const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const { TABLE_NAME } = process.env;

exports.handler = async (event) => {
  console.log('TODO sendmessage');

  return { statusCode: 200, body: 'Data sent.' };
};
