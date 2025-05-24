// lib/mastra_lambda-stack.ts - Using container images
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
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

    // Keep the original layer-based function for weather agent
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

    const apiHandler = new ApiEndpointLambda(this, "ApiHandler", {
      api: Api,
      route: "/api",
      region: this.region,
      handlerFunctionProps: {
        code: lambda.Code.fromAsset("./src/handlers/api"),
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
        },
      },
    });

    const qaContainerFunction = new lambda.Function(
      this,
      "QAContainerFunction",
      {
        code: lambda.Code.fromAssetImage("./src/containers/qa"),
        handler: lambda.Handler.FROM_IMAGE,
        runtime: lambda.Runtime.FROM_IMAGE,
        role: LambdaRole,
        timeout: cdk.Duration.minutes(5), 
        memorySize: 2048,
        ephemeralStorageSize: cdk.Size.gibibytes(2), // Extra storage
        environment: {
          REGION: this.region,
          ANTHROPIC_API_KEY: anthropic_api_key,
          MASTRA_TABLE_NAME: storageTable.tableName,
          NODE_ENV: "production",
        },
      }
    );

  }
}
