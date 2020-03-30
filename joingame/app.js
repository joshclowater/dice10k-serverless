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
  const logContext = { connectionId, playerName, gameName };
  
  console.log('joingame', logContext);

  let game;
  try {
    game = await ddb.put({
      TableName: GAME_TABLE_NAME,
      Key: { name: gameId },
      UpdateExpression: 'SET players = list_append(players, :p)',
      ExpressionAttributeValues: {
        ':p': { connectionId, name: playerName }
      },
      ReturnValues: 'UPDATED_NEW'
    }).promise();
  } catch (e) {
    console.log('Error adding player to game', e.stack);
    return { statusCode: 400 };
  }

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
      ':g': gameName,
      ':n': playerName
    }
  }).promise();

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });
  
  // TODO send to all players in game
  console.log('game', game);

  try {
    await apigwManagementApi.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify({
        message: 'joinedgame',
        gameName
      })
    }).promise();
  } catch (e) {
    if (e.statusCode === 410) {
      console.log(`Found stale connection, deleting ${connectionId}`);
      return { statusCode: 410, body: 'Connection stale' };
    } else {
      throw e;
    }
  }
  
  console.log('joined game', logContext);

  return { statusCode: 200, body: 'Joined game' };
};
