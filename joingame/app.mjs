import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const { PLAYER_TABLE_NAME, GAME_TABLE_NAME } = process.env;

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  const { name: playerName, gameId } = JSON.parse(event.body);
  const logContext = { connectionId, playerName, gameId };

  console.log('joingame', logContext);

  const apigwManagementClient = new ApiGatewayManagementApiClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  let existingGame;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: GAME_TABLE_NAME,
      Key: { name: gameId }
    }));
    existingGame = result.Item;
  } catch (e) {
    console.error('Error retrieving game:', e.stack);
    return { statusCode: 500, body: 'Error retrieving game' };
  }

  let errorMessage;
  if (!existingGame) {
    errorMessage = 'Game with this Game ID not found';
  } else if (existingGame.status !== 'waiting-for-players') {
    errorMessage = 'This game has already started';
  } else if (existingGame.players.length >= 12) {
    errorMessage = 'This game is full (12 people already in game)';
  } else if (!playerName || !playerName.length) {
    errorMessage = 'Player name must be passed in';
  } else if (playerName.length > 12) {
    errorMessage = 'Player name must be less than 12 characters';
  } else if (existingGame.players.find(({ name }) => name === playerName)) {
    errorMessage = 'A player already exists in the game with this name';
  }

  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'joingame/failedtojoin',
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

  let updatedGame;
  try {
    const updateResult = await docClient.send(new UpdateCommand({
      TableName: GAME_TABLE_NAME,
      Key: { name: gameId },
      UpdateExpression: 'SET players = list_append(players, :p)',
      ExpressionAttributeValues: {
        ':p': [{ connectionId, name: playerName, score: 0 }]
      },
      ReturnValues: 'UPDATED_NEW'
    }));
    updatedGame = updateResult.Attributes;
  } catch (e) {
    console.error('Error adding player to game', e.stack);
    return { statusCode: 500, body: 'Error updating game' };
  }
  
  const { players } = updatedGame;
  console.log('updated players', {
    ...logContext,
    players
  });

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

  // Broadcasting the join event to all players in the game
  const postCalls = players.map(async ({ connectionId: playerConnectionId }) => {
    let data;
    if (playerConnectionId === connectionId) {
      data = {
        type: 'game/youjoinedgame',
        payload: {
          gameId,
          playerName,
          players: players.map(player => player.name)
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
      await apigwManagementClient.send(new PostToConnectionCommand({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify(data)
      }));
    } catch (e) {
      if (e.statusCode === 410) {
        console.log(`Found stale connection ${playerConnectionId}`);
      } else {
        console.error(`Unexpected error occurred sending message to connection ${playerConnectionId}`, e.stack);
        throw e;
      }
    }
  });

  try {
    await Promise.all(postCalls);
  } catch (e) {
    console.error('At least one message failed to send', e.stack);
    return { statusCode: 500, body: 'Failed to send update to all players' };
  }

  console.log('joined game', logContext);
  return { statusCode: 200, body: 'Joined game' };
};
