# dice10k-serverless

The back end for the multiplayer dice game "Dice 10000" built with [Node.js](https://nodejs.org/en/) and deployed using [AWS Lambda functions](https://aws.amazon.com/lambda/).

Features:

- Websocket API used with [AWS Websocket API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html).
- State stored using [AWS DynamoDB](https://aws.amazon.com/dynamodb/).
- Fully defined as infrastructure as code, using [AWS Serverless Application Model](https://docs.aws.amazon.com/serverless-application-model/) to create all the application resources.
- CI/CD Pipeline using [AWS CodePipeline](https://aws.amazon.com/codepipeline/) and [AWS CodeBuild](https://aws.amazon.com/codebuild/), so that you can just push to the Github and it will automatically deploy.