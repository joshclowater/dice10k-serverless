const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const {
  PLAYER_TABLE_NAME,
  GAME_TABLE_NAME
} = process.env;

exports.handler = async (event) => {

  const { connectionId } = event.requestContext;
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
  console.log('joingame', logContext);

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

  const diceRolls = [
    getRandomInt(),
    getRandomInt(),
    getRandomInt(),
    getRandomInt(),
    getRandomInt(),
    getRandomInt()
  ];

  let { playerTurns, playerTurn, round } = game;
  if (playerTurns.length === playerTurn + 1) {
    playerTurn = 0;
    round++;
  } else {
    playerTurn++;
  }

  try {
    await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: 'SET round = :r, playerTurn = :t',
      ExpressionAttributeValues: {
        ':r': round,
        ':t': playerTurn
      },
      ReturnValues: 'NONE'
    }).promise();
  } catch (e) {
    console.error('Error adding player to game', e.stack);
    return { statusCode: 500 };
  }

  const postCalls = game.players.map(async ({ connectionId: playerConnectionId }) => {
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify({
          type: 'game/rolleddice',
          payload: {
            gameId,
            playerName,
            diceRolls,
            nextPlayerTurn: playerTurns[playerTurn],
            round
          }
        })
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

  console.log('rolled dice', { ...logContext, diceRolls });

  return { statusCode: 200, body: 'Rolled dice' };
};

/**
 * The maximum is exclusive and the minimum is inclusive.
 * @param {number} min 
 * @param {number} max 
 * @return {number} Random int between min and max.
 */
const getRandomInt = (min = 1, max = 7) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
};
