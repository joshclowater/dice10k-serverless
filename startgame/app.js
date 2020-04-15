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
  console.log('startgame', logContext);

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
  } else if (game.status != 'waiting-for-players') {
    errorMessage = 'Game has already started';
  } else if (game.players.length < 2) {
    errorMessage = 'Must be more than two players to start';
  }
  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'game/failedtostartgame',
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

  const playerNames = game.players.map(player => player.name);
  shuffleArray(playerNames);

  await ddb.update({
    TableName: GAME_TABLE_NAME,
    Key: { name: game.name },
    UpdateExpression: 'SET #s = :s, playerTurns = :p, round = :r, playerTurn = :t, diceKept = :k, diceRolled = :d, scoreThisTurn = :st',
    ExpressionAttributeNames: {
      '#s': 'status'
    },
    ExpressionAttributeValues: {
      ':s': 'in-progress',
      ':p': playerNames,
      ':r': 1,
      ':t': 0,
      ':k': [],
      ':d': [],
      ':st': 0
    },
    ReturnValues: 'NONE'
  }).promise();

  const postCalls = game.players.map(async ({ connectionId: playerConnectionId }) => {
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify({
          type: 'game/gamestarted',
          payload: {
            round: 1,
            playersTurn: playerNames[0]
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

  console.log('started game', logContext);

  return { statusCode: 200, body: 'Started game' };
};

/**
 * @param {Array} array 
 * @return {Array} array with items shuffled.
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
  }
}
