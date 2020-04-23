const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const {
  PLAYER_TABLE_NAME,
  GAME_TABLE_NAME
} = process.env;

exports.handler = async (event) => {
  const { connectionId } = event.requestContext;
  const {
    diceKept: playerDiceKept,
    endTurn
  } = JSON.parse(event.body);
  const { Item: player } = await ddb.get({
    TableName: PLAYER_TABLE_NAME,
    Key: {
      connectionId
    }
  }).promise();
  const { gameId, name: playerName } = player;
  const logContext = {
    connectionId,
    gameId,
    playerName
  };
  console.log('rolldice', { ...logContext, playerDiceKept });

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });

  const { Item: game } = await ddb.get({
    TableName: GAME_TABLE_NAME,
    Key: {
      name: gameId
    }
  }).promise();

  let scoredThisRoll;
  if (playerDiceKept && playerDiceKept.length > 0) {
    scoredThisRoll = calculateScore(playerDiceKept);
  }

  let errorMessage;
  if (!game) {
    errorMessage = 'Player not yet connected to game';
  } else if (game.status === 'waiting-for-players') {
    errorMessage = 'Game has not yet started';
  } else if (game.status === 'game-over') {
    errorMessage = 'Game is over';
  } else if (game.playerTurns[game.playerTurn] !== playerName) {
    errorMessage = 'Not current player turn';
  } else if (!game.diceRolled.length && playerDiceKept && playerDiceKept.length > 0) {
    errorMessage = 'Cannot keep dice, have not yet rolled';
  } else if (game.diceRolled.length && (!playerDiceKept || !playerDiceKept.length)){
    errorMessage = 'You must keep at least one die';
  } else if (game.diceRolled.length &&
    (playerDiceKept.length > game.diceRolled.length || !isSubset(game.diceRolled, playerDiceKept))
  ) {
    errorMessage = 'Dice chosen must be subset of dice rolled';
  } else if (game.diceRolled.length &&
    (scoredThisRoll === 0 || hasNonScorableDice(playerDiceKept))
  ) {
    errorMessage = 'Dice kept must be scorable';
  } else if (game.diceRolled.length &&
    endTurn && (game.scoreThisTurn + scoredThisRoll) < 750 && game.players.find(player => player.name === playerName).score === 0
  ) {
    errorMessage = 'You must score at least 750 points on your first scoring turn';
  }
  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'game/failedtorolldice',
          payload: { errorMessage }
        })
      }).promise();
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`Found stale connection ${connectionId}`);
      } else {
        console.error(`Unexpected error occured sending message to connection ${connectionId}`, e.stack);
        throw e;
      }
    }
    return { statusCode: 400, body: errorMessage };
  }

  let diceRolls;
  let validRoll;
  if (!endTurn) {
    let numberOfNextDiceRolls;
    if (game.diceRolled.length === 0 || game.diceRolled.length === playerDiceKept.length) {
      // First roll of turn or player scored all dice
      numberOfNextDiceRolls = 6;
    } else {
      numberOfNextDiceRolls = game.diceRolled.length - playerDiceKept.length;
    }
    diceRolls = [];
    for (let i = 0; i < numberOfNextDiceRolls; i++) {
      diceRolls.push(getRandomInt());
    }
    validRoll = isScorableDiceRoll(diceRolls);
  }

  let socketMessage;

  if (validRoll) {
    await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: 'SET diceKept = :k, diceRolled = :d, scoreThisTurn = scoreThisTurn + :s',
      ExpressionAttributeValues: {
        ':k': playerDiceKept || [],
        ':d': diceRolls,
        ':s': scoredThisRoll || 0
      },
      ReturnValues: 'NONE'
    }).promise();

    socketMessage = {
      type: 'game/rolleddice',
      payload: {
        playerName,
        diceRolls,
        playerDiceKept,
        scoredThisRoll
      }
    };
  } else {
    let { playerTurns, playerTurn, round } = game;
    if (playerTurns.length === playerTurn + 1) {
      playerTurn = 0;
      round++;
    } else {
      playerTurn++;
    }

    let scoredThisTurn;
    let updateExpression = 'SET round = :r, playerTurn = :t, diceKept = :k, diceRolled = :d, scoreThisTurn = :s';
    let expressionAttributeNames;
    const expressionAttributeValues = {
      ':r': round,
      ':t': playerTurn,
      ':k': [],
      ':d': [],
      ':s': 0
    };

    let endGame;
    if (endTurn) {
      scoredThisTurn = game.scoreThisTurn + scoredThisRoll;
      const playerIndex = game.players.findIndex(player => player.name === playerName);
      updateExpression += `, players[${playerIndex}].score = players[${playerIndex}].score + :sc`;
      expressionAttributeValues[':sc'] = scoredThisTurn;

      const playerTotalScore = scoredThisTurn + game.players[playerIndex].score;
      if (playerTotalScore >= 10000) {
        endGame = true;
        expressionAttributeNames = { '#st': 'status' };
        updateExpression += ', #st = :st';
        expressionAttributeValues[':st'] = 'game-over';
      }
    }

    await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'NONE'
    }).promise();

    let payload = {
      playerName,
      playerDiceKept,
      scoredThisRoll,
      scoredThisTurn
    };
    
    if (endGame) {
      payload.endGame = endGame;
    } else {
      payload = {
        ...payload,
        diceRolls,
        crapout: !endTurn,
        round,
        nextPlayerTurn: playerTurns[playerTurn]
      };
    }

    socketMessage = {
      type: 'game/endturn',
      payload
    };
  }

  const postCalls = game.players.map(async ({ connectionId: playerConnectionId }) => {
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify(socketMessage)
      }).promise();
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`Found stale connection ${playerConnectionId}`);
      } else {
        console.error(`Unexpected error occured sending message to connection ${playerConnectionId}`, e.stack);
        throw e;
      }
    }
  });
  
  try {
    await Promise.all(postCalls);
  } catch (e) {
    console.error('At least one message failed to send', e.stack);
    return { statusCode: 500, body: e.stack };
  }

  console.log('rolled dice', { ...logContext, socketMessage });

  return { statusCode: 200, body: 'Rolled dice' };
};

/**
 * @param {Array} array 
 * @param {Array} subArray
 * @return {Boolean} If array contains at least the same values and number of values in subArray.
 */
const isSubset = (array, subArray) => {
  const valueMapOfArray = valueMap(array);
  const valueMapOfSubArray = valueMap(subArray);
  
  for (let [key, value] of Object.entries(valueMapOfSubArray)) {
    if (!valueMapOfArray[key] || valueMapOfArray[key] < value) {
      return false;
    }
  }
  return true;
};

/**
 * @param {number} min inclusive.
 * @param {number} max exclusive.
 * @return {number} Random int between min and max.
 */
const getRandomInt = (min = 1, max = 7) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
};

/**
 * If array contains one or two 2s, 3s, 4s, or 6s.
 * @param {Array} array
 * @return {Boolean} 
 */
const hasNonScorableDice = (array) => {
  const valueMapOfArray = valueMap(array);
  return (valueMapOfArray[2] > 0 && valueMapOfArray[2] < 3) ||
    (valueMapOfArray[3] > 0 && valueMapOfArray[3] < 3) ||
    (valueMapOfArray[4] > 0 && valueMapOfArray[4] < 3) ||
    (valueMapOfArray[6] > 0 && valueMapOfArray[6] < 3);
};

/**
 * If array contains a 1, 5, or 3 of a kind.
 * @param {Array} array
 * @return {Boolean}
 */
const isScorableDiceRoll = (array) => {
  return array.includes(1) || array.includes(5) || (array.length >= 3 && hasTriple(array));
};

/**
 * @param {Array} array
 * @return {Boolean} If the array contains at least 3 of the same value.
 */
const hasTriple = (array) => {
  const valueMapOfArray = valueMap(array);
  const values = Object.values(valueMapOfArray);
  const biggestDuplicate = Math.max(...values);
  return biggestDuplicate >= 3;
};

const calculateScore = (array) => {
  let score = 0;
  const valueMapOfArray = valueMap(array);
  for (const dieProperty in valueMapOfArray) {
    const die = Number(dieProperty);
    const numberOfDice = valueMapOfArray[die];
    if (numberOfDice === 1 || numberOfDice === 2) {
      if (die === 1) {
        score += numberOfDice * 100;
      } else if (die === 5) {
        score += numberOfDice * 50;
      }
    } else if (numberOfDice >= 3) {
      if (die === 1) {
        score += 1000;
        if (numberOfDice > 3) {
          score += (numberOfDice - 3) * 1000;
        }
      } else {
        const scoreForDie = die * 100;
        score += scoreForDie;
        if (numberOfDice > 3) {
          score += (numberOfDice - 3) * scoreForDie;
        }
      }
    }
  }
  return score;
};

/**
 * @param {Array} array
 * @return {Object} map of values in array and their occurrences.
 */
const valueMap = (array) => {
  const valueMapResult = {};
  array.forEach(element => {
    if (valueMapResult[element]) {
      valueMapResult[element]++;
    } else {
      valueMapResult[element] = 1;
    }
  });
  return valueMapResult;
};
