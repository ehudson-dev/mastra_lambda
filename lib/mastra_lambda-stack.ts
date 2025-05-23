import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam'
import * as dynamo from 'aws-cdk-lib/aws-dynamodb'
import { anthropic_api_key } from '../bin/mastra_lambda';

export class MastraLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const ApiRole = new iam.Role(this, `ApiRole`, {
			assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal('apigateway.amazonaws.com'), new iam.AccountRootPrincipal())
		});

		ApiRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ['lambda:InvokeFunction'],
				resources: ['*']
			})
		);

    const APIInvokePolicy = new iam.PolicyStatement({
			effect: iam.Effect.ALLOW,
			actions: ['execute-api:Invoke', 'execute-api:ManageConnections'],
			resources: ['arn:aws:execute-api:*:*:*']
		});

    const LogAccessPolicy = new iam.PolicyStatement({
			effect: iam.Effect.ALLOW,
			actions: [
				'logs:CreateLogDelivery',
				'logs:CreateLogStream',
				'logs:GetLogDelivery',
				'logs:UpdateLogDelivery',
				'logs:DeleteLogDelivery',
				'logs:ListLogDeliveries',
				'logs:PutLogEvents',
				'logs:PutResourcePolicy',
				'logs:DescribeResourcePolicies',
				'logs:DescribeLogGroups',
				'logs:CreateLogGroup'
			],
			resources: ['*']
		});

		const DynamoPolicy = new iam.PolicyStatement({
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
					"dynamodb:BatchWriteItem"
			],
			resources: ['*']
		});

    const LambdaRole = new iam.Role(this, 'LambdaRole', {
			assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
		});

    LambdaRole.addToPolicy(LogAccessPolicy);
    LambdaRole.addToPolicy(APIInvokePolicy)
	LambdaRole.addToPolicy(DynamoPolicy)

    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      layerVersionName: 'mastra-dependencies',
      code: lambda.Code.fromAsset('./src/dependencies'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared dependencies for Mastra agents (AI SDKs, utilities)',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
	  
    });

	const storageTable = new dynamo.Table(this, "storage-table", {
		billingMode: dynamo.BillingMode.PAY_PER_REQUEST,
		partitionKey: {
			type: dynamo.AttributeType.STRING,
			name: "pk"
		},
		sortKey: {
			type: dynamo.AttributeType.STRING,
			name: "sk"
		},
		pointInTimeRecovery: true,
      	encryption: dynamo.TableEncryption.AWS_MANAGED,
	})

	// Add GSI1
    storageTable.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamo.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamo.AttributeType.STRING },

    });

    // Add GSI2 (Used by Trace and WorkflowSnapshot)
    storageTable.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: dynamo.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamo.AttributeType.STRING },
   
    });

    const apiHandler = new lambda.Function(this, 'ApiHandler', {
			code: lambda.Code.fromAsset('./src/handlers/api'),
			handler: 'index.handler',
			runtime: lambda.Runtime.NODEJS_20_X,
			role: LambdaRole,
			layers: [dependenciesLayer],
			timeout: cdk.Duration.seconds(30),
			retryAttempts: 0,
			memorySize: 1024,
      environment: {
        REGION: this.region,
        ANTHROPIC_API_KEY: anthropic_api_key,
		MASTRA_TABLE_NAME: storageTable.tableName
      },
    });


	const Api = new apigateway.CfnApi(this, `Api`, {
		name: `test mastra api`,
		protocolType: 'HTTP',
		description: `mastra lamdba`,
		credentialsArn: ApiRole.roleArn,
		corsConfiguration: {
			allowOrigins: ['*'],
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			allowHeaders: ['api-key', 'authorization', 'content-type']
		},
		target: apiHandler.functionArn
	});

  }
}