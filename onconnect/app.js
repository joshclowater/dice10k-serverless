const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const { PLAYER_TABLE_NAME } = process.env;

exports.handler = async (event) => {

  const { connectionId } = event.requestContext;
  const logContext = { connectionId };

  console.log('onconnect', logContext);

  await ddb.put({
    TableName: PLAYER_TABLE_NAME,
    Item: {
      connectionId,
      status: 'pending',
      createdOn: new Date().toISOString()
    }
  }).promise();

  console.log('Player connected', logContext);

  return { statusCode: 200, body: 'Connected' };
};
