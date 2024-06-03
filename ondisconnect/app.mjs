import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const { PLAYER_TABLE_NAME } = process.env;

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  const logContext = { connectionId };

  console.log('ondisconnect', logContext);

  try {
    await docClient.send(new DeleteCommand({
      TableName: PLAYER_TABLE_NAME,
      Key: { connectionId }
    }));
  } catch (error) {
    console.error('Error disconnecting player:', error);
    return { statusCode: 500, body: 'Failed to disconnect' };
  }

  console.log('Player disconnected', logContext);
  return { statusCode: 200, body: 'Disconnected.' };
};
