// src/handlers/sqs-processor/index.ts - SQS message processor
import { SQSEvent, SQSRecord, SQSBatchResponse } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const lambdaClient = new LambdaClient({
  region: process.env.REGION || process.env.AWS_REGION,
});

const s3Client = new S3Client({
  region: process.env.REGION || process.env.AWS_REGION,
});

interface JobPayload {
  jobId: string;
  containerName: string;
  input: string;
  threadId: string;
  timestamp: string;
  originalRequest: any;
}

interface ContainerResult {
  success: boolean;
  error?: any;
  data?: any;
  processingTime?: number;
  timestamp?: string;
  jobId?: string;
  containerName?: string;
  functionStatusCode?: number;
  logs?: any
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  console.log('SQS Processor invoked with', event.Records.length, 'messages');
  
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error: any) {
      console.error(`Failed to process record ${record.messageId}:`, error);
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return {
    batchItemFailures,
  };
};

const processRecord = async (record: SQSRecord): Promise<void> => {
  console.log(`Processing message: ${record.messageId}`);
  
  const jobPayload: JobPayload = JSON.parse(record.body);
  console.log('Job payload:', jobPayload);

  const startTime = Date.now();
  let result: ContainerResult;

  try {
    // Determine which Lambda function to invoke based on container name
    const functionName = getFunctionName(jobPayload.containerName);
    
    if (!functionName) {
      throw new Error(`Unknown container name: ${jobPayload.containerName}`);
    }

    console.log(`Invoking container function: ${functionName}`);

    // Prepare payload for container function
    const containerPayload = {
        input: jobPayload.input,
        thread_id: jobPayload.threadId,
        jobId: jobPayload.jobId,
    }

    // Invoke the container Lambda function
    const invokeCommand = new InvokeCommand({
      FunctionName: functionName,
      Payload: JSON.stringify(containerPayload),
      InvocationType: 'RequestResponse', // Synchronous invocation
    });

    const lambdaResponse = await lambdaClient.send(invokeCommand);
    const processingTime = Date.now() - startTime;

    console.log(`Container function completed in ${processingTime}ms`);

    if (lambdaResponse.StatusCode === 200) {
      // Parse the response from the container function
      const responsePayload = JSON.parse(
        new TextDecoder().decode(lambdaResponse.Payload)
      );
      
      const containerResponse = JSON.parse(responsePayload.body || '{}');

      result = {
        success: true,
        data: containerResponse,
        processingTime,
        timestamp: new Date().toISOString(),
        jobId: jobPayload.jobId,
        containerName: jobPayload.containerName,
        functionStatusCode: lambdaResponse.StatusCode,
        logs: lambdaResponse.LogResult,
      };
    } else {
      // Lambda function returned error status
      const errorPayload = lambdaResponse.Payload ? 
        new TextDecoder().decode(lambdaResponse.Payload) : 
        'Unknown error';

      result = {
        success: false,
        error: {
          message: 'Container function returned error status',
          statusCode: lambdaResponse.StatusCode,
          payload: errorPayload,
          functionError: lambdaResponse.FunctionError,
        },
        processingTime,
        timestamp: new Date().toISOString(),
        jobId: jobPayload.jobId,
        containerName: jobPayload.containerName,
      };
    }

  } catch (error: any) {
    console.error('Error invoking container function:', error);
    
    result = {
      success: false,
      error: {
        message: error.message,
        type: error.constructor?.name || 'Error',
        stack: error.stack,
      },
      processingTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      jobId: jobPayload.jobId,
      containerName: jobPayload.containerName,
    };
  }

  // Store the result in S3
  await storeResultInS3(jobPayload, result);
  
  console.log(`Job ${jobPayload.jobId} completed successfully`);
};

const getFunctionName = (containerName: string): string | null => {
  // Map container names to actual Lambda function names
  const containerMapping: Record<string, string> = {
    browser_automation: process.env.BROWSER_AUTOMATION_FUNCTION_NAME!,
    // Add more container mappings here as needed
    // 'web-scraper': process.env.WEB_SCRAPER_FUNCTION_NAME!,
    // 'pdf-processor': process.env.PDF_PROCESSOR_FUNCTION_NAME!,
  };

  return containerMapping[containerName] || null;
};

const storeResultInS3 = async (jobPayload: JobPayload, result: ContainerResult): Promise<void> => {
  const bucketName = process.env.RESULTS_BUCKET!;
  const key = `${jobPayload.containerName}/${jobPayload.jobId}/result.json`;

  console.log(`Storing result in S3: s3://${bucketName}/${key}`);

  const jobResult = {
    job: {
      jobId: jobPayload.jobId,
      containerName: jobPayload.containerName,
      submittedAt: jobPayload.timestamp,
      completedAt: new Date().toISOString(),
      processingTime: result.processingTime,
    },
    request: {
      input: jobPayload.input,
      threadId: jobPayload.threadId,
      originalRequest: jobPayload.originalRequest,
    },
    result,
    metadata: {
      sqsMessageId: jobPayload.originalRequest?.sqsMessageId,
      region: process.env.REGION,
      version: '1.0.0',
    },
  };

  const putObjectCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: JSON.stringify(jobResult, null, 2),
    ContentType: 'application/json',
    Metadata: {
      jobId: jobPayload.jobId,
      containerName: jobPayload.containerName,
      status: result.success ? 'completed' : 'failed',
      timestamp: result.timestamp || new Date().toISOString(),
    },
  });

  try {
    await s3Client.send(putObjectCommand);
    console.log(`Result stored successfully in S3: ${key}`);
  } catch (error: any) {
    console.error('Error storing result in S3:', error);
    throw error; // Re-throw to mark the SQS message as failed
  }
};