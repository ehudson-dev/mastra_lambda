// lib/mastra_lambda-stack.ts - Updated with SQS and S3
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { anthropic_api_key } from "../bin/mastra_lambda";
import { ApiEndpointLambda } from "./constructs/ApiEndpointLambda";

export class MastraLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ApiRole = new iam.Role(this, `ApiRole`, {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("apigateway.amazonaws.com"),
        new iam.AccountRootPrincipal()
      ),
    });

    ApiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );

    const LambdaRole = new iam.Role(this, "LambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // DynamoDB permissions
    LambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
        ],
        resources: ["*"],
      })
    );

    // Create S3 bucket for results storage
    const resultsBucket = new s3.Bucket(this, "ResultsBucket", {
      bucketName: `mastra-results-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Create SQS queue for container job processing
    const containerJobQueue = new sqs.Queue(this, "ContainerJobQueue", {
      queueName: "mastra-container-jobs.fifo",
      fifo: true,
      contentBasedDeduplication: false, // We'll provide explicit deduplication IDs
      visibilityTimeout: cdk.Duration.minutes(10), // Should be longer than container timeout
      deadLetterQueue: {
        queue: new sqs.Queue(this, "ContainerJobDLQ", {
          queueName: "mastra-container-jobs-dlq.fifo",
          fifo: true,
        }),
        maxReceiveCount: 3,
      },
    });

    // S3 permissions for Lambda
    LambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ],
        resources: [
          resultsBucket.bucketArn,
          `${resultsBucket.bucketArn}/*`,
        ],
      })
    );

    // SQS permissions for Lambda
    LambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ],
        resources: [
          containerJobQueue.queueArn,
          containerJobQueue.deadLetterQueue!.queue.queueArn,
        ],
      })
    );

    // Lambda invoke permissions for container functions
    LambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
      })
    );

    const storageTable = new dynamo.Table(this, "storage-table", {
      billingMode: dynamo.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        type: dynamo.AttributeType.STRING,
        name: "pk",
      },
      sortKey: {
        type: dynamo.AttributeType.STRING,
        name: "sk",
      },
      pointInTimeRecovery: true,
      encryption: dynamo.TableEncryption.AWS_MANAGED,
    });

    // Add GSI1
    storageTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamo.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamo.AttributeType.STRING },
    });

    // Add GSI2
    storageTable.addGlobalSecondaryIndex({
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: dynamo.AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: dynamo.AttributeType.STRING },
    });

    // API Gateway
    const Api = new apigateway.CfnApi(this, `Api`, {
      name: `mastra container qa api`,
      protocolType: "HTTP",
      description: `mastra qa testing with container-based browser automation`,
      corsConfiguration: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["api-key", "authorization", "content-type"],
      },
    });

    // Dependencies layer for basic functions
    const dependenciesLayer = new lambda.LayerVersion(
      this,
      "DependenciesLayer",
      {
        layerVersionName: "mastra-basic-dependencies",
        code: lambda.Code.fromAsset("./src/dependencies"),
        compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
        description: "Basic Mastra dependencies (no browser)",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Container QA function (the actual worker)
    const qaContainerFunction = new lambda.Function(
      this,
      "QAContainerFunction",
      {
        code: lambda.Code.fromAssetImage("./src/handlers/containers/qa"),
        handler: lambda.Handler.FROM_IMAGE,
        runtime: lambda.Runtime.FROM_IMAGE,
        role: LambdaRole,
        timeout: cdk.Duration.minutes(5), 
        memorySize: 2048,
        ephemeralStorageSize: cdk.Size.gibibytes(2),
        environment: {
          REGION: this.region,
          ANTHROPIC_API_KEY: anthropic_api_key,
          MASTRA_TABLE_NAME: storageTable.tableName,
          NODE_ENV: "production",
          RESULTS_BUCKET: resultsBucket.bucketName,
        },
      }
    );

    // SQS processor function that invokes container functions
    const sqsProcessorFunction = new lambda.Function(
      this,
      "SQSProcessorFunction",
      {
        code: lambda.Code.fromAsset("./src/handlers/event/sqs"),
        handler: "index.handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        role: LambdaRole,
        layers: [dependenciesLayer],
        timeout: cdk.Duration.minutes(6),
        memorySize: 512,
        environment: {
          REGION: this.region,
          ANTHROPIC_API_KEY: anthropic_api_key,
          MASTRA_TABLE_NAME: storageTable.tableName,
          RESULTS_BUCKET: resultsBucket.bucketName,
          QA_CONTAINER_FUNCTION_NAME: qaContainerFunction.functionName,
        },
      }
    );

    // Add SQS event source to processor function
    sqsProcessorFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(containerJobQueue, {
        batchSize: 1, // Process one job at a time
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      })
    );

    // API handler with updated environment variables
    const apiHandler = new ApiEndpointLambda(this, "ApiHandler", {
      api: Api,
      route: "POST /api/job/start",
      region: this.region,
      handlerFunctionProps: {
        code: lambda.Code.fromAsset("./src/handlers/api/job/start"),
        handler: "index.handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        role: LambdaRole,
        layers: [dependenciesLayer],
        timeout: cdk.Duration.seconds(30),
        memorySize: 1024,
        environment: {
          REGION: this.region,
          ANTHROPIC_API_KEY: anthropic_api_key,
          MASTRA_TABLE_NAME: storageTable.tableName,
          CONTAINER_JOB_QUEUE_URL: containerJobQueue.queueUrl,
          RESULTS_BUCKET: resultsBucket.bucketName,
        },
      },
    });

    // Job status API endpoint for checking job progress
    const jobStatusHandler = new ApiEndpointLambda(this, "JobStatusHandler", {
      api: Api,
      route: "GET /api/job/{job_id}",
      region: this.region,
      handlerFunctionProps: {
        code: lambda.Code.fromAsset("./src/handlers/job/status"),
        handler: "index.handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        role: LambdaRole,
        layers: [dependenciesLayer],
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: {
          REGION: this.region,
          RESULTS_BUCKET: resultsBucket.bucketName,
        },
      },
    });

    // Output important values
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `https://${Api.attrApiId}.execute-api.${this.region}.amazonaws.com`,
      description: "API Gateway URL",
    });

    new cdk.CfnOutput(this, "ResultsBucketName", {
      value: resultsBucket.bucketName,
      description: "S3 bucket for storing job results",
    });

    new cdk.CfnOutput(this, "QueueUrl", {
      value: containerJobQueue.queueUrl,
      description: "SQS queue URL for container jobs",
    });
  }
}