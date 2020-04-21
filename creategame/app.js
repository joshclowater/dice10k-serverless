const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const {
  PLAYER_TABLE_NAME,
  GAME_TABLE_NAME
} = process.env;

exports.handler = async (event) => {

  const { connectionId } = event.requestContext;
  const { name: playerName } = JSON.parse(event.body);
  const logContext = { connectionId, playerName };
  
  console.log('creategame', logContext);
  
  const gameId = makeId();
  logContext.gameId = gameId;

  const players = [{ connectionId, name: playerName, score: 0 }];
  await ddb.put({
    TableName: GAME_TABLE_NAME,
    Item: {
      name: gameId,
      status: 'waiting-for-players',
      players,
      createdOn: new Date().toISOString()
    }
  }).promise();

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

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });
  
  try {
    await apigwManagementApi.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify({
        type: 'game/youjoinedgame',
        payload: {
          gameId,
          playerName,
          players: [playerName]
        }
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
  
  console.log('created game', logContext);

  return { statusCode: 200, body: 'Created game' };
};

const makeId = () => {
  let id = '';
  const possible = 'abcdefghijklmnopqrstuvwxyz';
  for (var i = 0; i < 5; i++) {
    id += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return id;
};
