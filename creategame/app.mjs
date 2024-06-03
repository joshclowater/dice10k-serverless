import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const { PLAYER_TABLE_NAME, GAME_TABLE_NAME } = process.env;

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  const { name: playerName } = JSON.parse(event.body);
  const logContext = { connectionId, playerName };

  console.log('creategame', logContext);

  const apigwManagementClient = new ApiGatewayManagementApiClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  let errorMessage;
  if (!playerName || !playerName.length) {
    errorMessage = 'Player name must be passed in';
  } else if (playerName.length > 12) {
    errorMessage = 'Player name must be less than 12 characters';
  }

  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'creategame/failedtocreate',
          payload: { errorMessage }
        })
      }));
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`Found stale connection ${connectionId}`);
      } else {
        console.error(`Unexpected error occurred sending message to connection ${connectionId}`, e.stack);
        throw e;
      }
    }
    return { statusCode: 400, body: errorMessage };
  }

  const gameId = makeId();
  logContext.gameId = gameId;

  const players = [{ connectionId, name: playerName, score: 0 }];
  await docClient.send(new PutCommand({
    TableName: GAME_TABLE_NAME,
    Item: {
      name: gameId,
      status: 'waiting-for-players',
      players,
      createdOn: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hours in the future
    }
  }));

  await docClient.send(new UpdateCommand({
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
  }));

  try {
    await apigwManagementClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({
        type: 'game/youjoinedgame',
        payload: {
          gameId,
          playerName,
          players: [playerName]
        }
      })
    }));
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
