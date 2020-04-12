const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const {
  PLAYER_TABLE_NAME,
  GAME_TABLE_NAME
} = process.env;

exports.handler = async (event) => {
  const { connectionId } = event.requestContext;
  const { diceKept: playerDiceKept } = JSON.parse(event.body);
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
  console.log('joingame', { ...logContext, playerDiceKept });

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

  let errorMessage;
  if (!game) {
    errorMessage = 'Player not yet connected to game';
  } else if (game.status !== 'in-progress') {
    errorMessage = 'Game has not yet started';
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
    (!isScorableDiceRoll(playerDiceKept) || hasNonScorableDice(playerDiceKept))
  ) {
    errorMessage = 'Dice kept must be scorable';
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

  const numberOfNewDiceRolls = (game.diceRolled.length || 6) - ((playerDiceKept && playerDiceKept.length) || 0);
  const diceRolls = [];
  for (let i = 0; i < numberOfNewDiceRolls; i++) {
    diceRolls.push(getRandomInt());
  }

  const validRoll = isScorableDiceRoll(diceRolls);

  let data;

  if (validRoll) {
    await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: 'SET diceKept = :k, diceRolled = :d',
      ExpressionAttributeValues: {
        ':k': playerDiceKept || [],
        ':d': diceRolls
      },
      ReturnValues: 'NONE'
    }).promise();

    data = {
      type: 'game/rolleddice',
      payload: {
        playerName,
        diceRolls
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

    await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: 'SET round = :r, playerTurn = :t, diceKept = :k, diceRolled = :d',
      ExpressionAttributeValues: {
        ':r': round,
        ':t': playerTurn,
        ':k': [],
        ':d': []
      },
      ReturnValues: 'NONE'
    }).promise();

    data = {
      type: 'game/endturn',
      payload: {
        playerName,
        diceRolls,
        nextPlayerTurn: playerTurns[playerTurn],
        round,
        crapout: true
      }
    };
  }

  const postCalls = game.players.map(async ({ connectionId: playerConnectionId }) => {
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify(data)
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

  console.log('rolled dice', logContext);

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
 * If array contains a 1, 5, or 3 of a kind.
 * @param {Array} array
 * @return {Boolean}
 */
const isScorableDiceRoll = (array) => {
  return array.includes(1) || array.includes(5) || (array.length >= 3 && hasTriple(array));
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
 * @param {Array} array
 * @return {Boolean} If the array contains at least 3 of the same value.
 */
const hasTriple = (array) => {
  const valueMapOfArray = valueMap(array);
  const values = Object.values(valueMapOfArray);
  const biggestDuplicate = Math.max(...values);
  return biggestDuplicate >= 3;
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
