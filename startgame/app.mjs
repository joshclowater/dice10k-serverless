import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const { PLAYER_TABLE_NAME, GAME_TABLE_NAME } = process.env;

export const handler = async (event) => {
  const { connectionId } = event.requestContext;

  let player;
  try {
    const playerResult = await docClient.send(new GetCommand({
      TableName: PLAYER_TABLE_NAME,
      Key: { connectionId }
    }));
    player = playerResult.Item;
  } catch (e) {
    console.error('Error retrieving player:', e);
    return { statusCode: 500, body: 'Error retrieving player' };
  }

  const { gameId, name: playerName } = player;
  const logContext = {
    connectionId,
    gameId,
    playerName
  };
  console.log('startgame', logContext);

  const apigwManagementClient = new ApiGatewayManagementApiClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  let game;
  try {
    const gameResult = await docClient.send(new GetCommand({
      TableName: GAME_TABLE_NAME,
      Key: { name: gameId }
    }));
    game = gameResult.Item;
  } catch (e) {
    console.error('Error retrieving game:', e);
    return { statusCode: 500, body: 'Error retrieving game' };
  }

  let errorMessage;
  if (!game) {
    errorMessage = 'Player not yet connected to game';
  } else if (game.status != 'waiting-for-players') {
    errorMessage = 'Game has already started';
  } else if (game.players.length < 2) {
    errorMessage = 'Must be more than two players to start';
  }
  if (errorMessage) {
    console.log(errorMessage, logContext);
    try {
      await apigwManagementClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({
          type: 'game/failedtostartgame',
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

  const playerNames = game.players.map(player => player.name);
  shuffleArray(playerNames);

  try {
    await docClient.send(new UpdateCommand({
      TableName: GAME_TABLE_NAME,
      Key: { name: game.name },
      UpdateExpression: 'SET #s = :s, playerTurns = :p, round = :r, playerTurn = :t, diceKept = :k, diceRolled = :d, scoreThisTurn = :st',
      ExpressionAttributeNames: {
        '#s': 'status'
      },
      ExpressionAttributeValues: {
        ':s': 'in-progress',
        ':p': playerNames,
        ':r': 1,
        ':t': 0,
        ':k': [],
        ':d': [],
        ':st': 0
      },
      ReturnValues: 'NONE'
    }));
  } catch (e) {
    console.error('Error updating game status:', e.stack);
    return { statusCode: 500, body: 'Error updating game status' };
  }

  const postCalls = game.players.map(async ({ connectionId: playerConnectionId }) => {
    try {
      await apigwManagementClient.send(new PostToConnectionCommand({
        ConnectionId: playerConnectionId,
        Data: JSON.stringify({
          type: 'game/gamestarted',
          payload: {
            playerTurns: playerNames,
            round: 1,
            playersTurn: playerNames[0]
          }
        })
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
    return { statusCode: 500, body: e.stack };
  }

  console.log('started game', logContext);
  return { statusCode: 200, body: 'Started game' };
};

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
