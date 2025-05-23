// lib/mastra_lambda-stack.ts - Using container images
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
import { anthropic_api_key } from "../bin/mastra_lambda";

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
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
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

    // Container-based Lambda function
    const qaContainerFunction = new lambda.Function(this, "QAContainerFunction", {
      code: lambda.Code.fromAssetImage("./container"),
      handler: lambda.Handler.FROM_IMAGE,
      runtime: lambda.Runtime.FROM_IMAGE,
      role: LambdaRole,
      timeout: cdk.Duration.minutes(5), // Generous timeout for browser ops
      memorySize: 3008, // Maximum memory
      ephemeralStorageSize: cdk.Size.gibibytes(2), // Extra storage
      environment: {
        REGION: this.region,
        ANTHROPIC_API_KEY: anthropic_api_key,
        MASTRA_TABLE_NAME: storageTable.tableName,
        NODE_ENV: "production",
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

    const basicApiHandler = new lambda.Function(this, "BasicApiHandler", {
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

    // Routes
    new apigateway.CfnRoute(this, "BasicRoute", {
      apiId: Api.ref,
      routeKey: "POST /",
      target: `integrations/${new apigateway.CfnIntegration(this, "BasicIntegration", {
        apiId: Api.ref,
        integrationType: "AWS_PROXY",
        integrationUri: basicApiHandler.functionArn,
        payloadFormatVersion: "2.0",
      }).ref}`,
    });

    new apigateway.CfnRoute(this, "QARoute", {
      apiId: Api.ref,
      routeKey: "POST /qa",
      target: `integrations/${new apigateway.CfnIntegration(this, "QAIntegration", {
        apiId: Api.ref,
        integrationType: "AWS_PROXY",
        integrationUri: qaContainerFunction.functionArn,
        payloadFormatVersion: "2.0",
      }).ref}`,
    });

    // Handle preflight CORS
    new apigateway.CfnRoute(this, "OptionsRoute", {
      apiId: Api.ref,
      routeKey: "OPTIONS /qa",
      target: `integrations/${new apigateway.CfnIntegration(this, "OptionsIntegration", {
        apiId: Api.ref,
        integrationType: "AWS_PROXY",
        integrationUri: qaContainerFunction.functionArn,
        payloadFormatVersion: "2.0",
      }).ref}`,
    });

    // Lambda permissions
    basicApiHandler.addPermission("BasicApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${Api.ref}/*/*`,
    });

    qaContainerFunction.addPermission("QAApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${Api.ref}/*/*`,
    });

    // Outputs
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: `https://${Api.ref}.execute-api.${this.region}.amazonaws.com`,
      description: "API Endpoint - use /qa for containerized QA testing",
    });

    new cdk.CfnOutput(this, "QATestEndpoint", {
      value: `https://${Api.ref}.execute-api.${this.region}.amazonaws.com/qa`,
      description: "Direct containerized QA testing endpoint", 
    });
  }
}