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
  
  const gameName = makeId();
  logContext.gameName = gameName;

  await ddb.put({
    TableName: GAME_TABLE_NAME,
    Item: {
      name: gameName,
      gameStatus: 'waiting-for-players',
      players: [{ connectionId, name: playerName }],
      createdOn: new Date().toISOString()
    }
  }).promise();

  await ddb.update({
    TableName: PLAYER_TABLE_NAME,
    Key: { connectionId },
    UpdateExpression: 'SET status = :s, gameId = :g, name = :n',
    ExpressionAttributeValues: {
      ':s': 'in-game',
      ':g': gameName,
      ':n': playerName
    }
  }).promise();

  log.info('created game', logContext);

  return { statusCode: 200 };
  // TODO do the non connect ones need this return value?
};

const makeId = () => {
  let id = '';
  const possible = 'abcdefghijklmnopqrstuvwxyz';
  for (var i = 0; i < 5; i++) {
    id += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return id;
};