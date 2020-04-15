const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const {
  PLAYER_TABLE_NAME,
  GAME_TABLE_NAME
} = process.env;

exports.handler = async (event) => {

  const { connectionId } = event.requestContext;
  const { name: playerName, gameId } = JSON.parse(event.body);
  const logContext = { connectionId, playerName, gameId };
  
  console.log('joingame', logContext);

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });

  const { Item: existingGame } = await ddb.get({
    TableName: GAME_TABLE_NAME,
    Key: {
      name: gameId
    }
  }).promise();

  let errorMessage;
  if (!existingGame) {
    errorMessage = 'Game with this Game ID not found';
  } else if (existingGame.status !== 'waiting-for-players') {
    errorMessage = 'This game has already started';
  } else if (existingGame.players.find(({ name }) => name === playerName)) {
    errorMessage = 'A player already exists in the game with this name';
  }
  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementApi.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'joingame/failedtojoin',
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

  let game;
  try {
    game = await ddb.update({
      TableName: GAME_TABLE_NAME,
      Key: { name: gameId },
      UpdateExpression: 'SET players = list_append(players, :p)',
      ExpressionAttributeValues: {
        ':p': [{ connectionId, name: playerName, score: 0 }]
      },
      ReturnValues: 'UPDATED_NEW'
    }).promise();
  } catch (e) {
    console.error('Error adding player to game', e.stack);
    return { statusCode: 500 };
  }

  const { players } = game.Attributes;
  console.log('updated players', {
    ...logContext,
    players
  });

  await ddb.update({
    TableName: PLAYER_TABLE_NAME,
    Key: { connectionId },
    UpdateExpression: 'SET #s = :s, gameId = :g, #n = :n',
    ExpressionAttributeNames: {
      '#s': 'status',
      '#n': 'name'
    },
    ExpressionAttributeValues: {
      ':s': 'in-game',
      ':g': gameId,
      ':n': playerName
    }
  }).promise();

  const postCalls = players.map(async ({ connectionId: playerConnectionId }) => {
    let data;
    if (playerConnectionId === connectionId) {
      data = {
        type: 'game/youjoinedgame',
        payload: {
          gameId,
          playerName,
          players
        }
      };
    } else {
      data = {
        type: 'game/joinedgame',
        payload: {
          playerName
        }
      };
    }
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

  console.log('joined game', logContext);

  return { statusCode: 200, body: 'Joined game' };
};
