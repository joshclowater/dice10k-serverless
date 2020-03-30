const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const { PLAYER_TABLE_NAME } = process.env;

exports.handler = async (event) => {

  const { connectionId } = event.requestContext;
  const logContext = { connectionId };

  console.log('ondisconnect', logContext);

  await ddb.delete({
    TableName: PLAYER_TABLE_NAME,
    Key: { connectionId }
  }).promise();

  return { statusCode: 200, body: 'Disconnected.' };
};