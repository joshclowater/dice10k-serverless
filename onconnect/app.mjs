import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const { PLAYER_TABLE_NAME } = process.env;

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  const logContext = { connectionId };

  console.log('onconnect', logContext);

  try {
    await docClient.send(new PutCommand({
      TableName: PLAYER_TABLE_NAME,
      Item: {
        connectionId,
        status: 'pending',
        createdOn: new Date().toISOString()
      }
    }));
  } catch (error) {
    console.error('Error connecting player:', error);
    return { statusCode: 500, body: 'Failed to connect' };
  }

  console.log('Player connected', logContext);
  return { statusCode: 200, body: 'Connected' };
};
