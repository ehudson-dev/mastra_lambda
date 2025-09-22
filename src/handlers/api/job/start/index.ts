// src/handlers/api/index.ts - Updated with SQS job dispatch
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { mastra } from "/opt/nodejs/mastra/index";
import { HttpResponse } from "/opt/nodejs/utils/index";

const sqsClient = new SQSClient({
  region: process.env.REGION || process.env.AWS_REGION,
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('API Handler invoked:', JSON.stringify(event, null, 2));

  try {
    let request = JSON.parse(event.body!);
    console.log('Parsed request:', request);

    // Handle traditional agent requests
    if (request.agent) {
      console.log(`Processing agent request: ${request.agent}`);
      
      let agent = mastra.getAgent(request.agent);
      const thread_id = request.thread_id ?? crypto.randomUUID();

      const result = await agent.generate(
        [
          {
            role: "user",
            content: request.prompt,
          },
        ],
        {
          threadId: thread_id,
          resourceId: request.agent,
        }
      );

      return HttpResponse(200, { thread_id: thread_id, ...result });
    }

    // Handle container requests asynchronously via SQS
    if (request.container) {
      console.log(`Processing container request: ${request.container}`);

      const jobId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      // Prepare job payload for SQS
      const jobPayload = {
        jobId,
        containerName: request.container,
        input: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
        threadId: request.thread_id || crypto.randomUUID(),
        timestamp,
        originalRequest: request,
        maxSteps: request.maxSteps || undefined,
        maxTokens: request.maxTokens || undefined,
        maxRetries: request.maxRetries || undefined
      };

      console.log('Sending job to SQS:', jobPayload);

      // Send message to SQS queue
      const sendMessageCommand = new SendMessageCommand({
        QueueUrl: process.env.CONTAINER_JOB_QUEUE_URL!,
        MessageBody: JSON.stringify(jobPayload),
        MessageAttributes: {
          containerName: {
            DataType: "String",
            StringValue: request.container,
          },
          jobId: {
            DataType: "String",
            StringValue: jobId,
          },
        },
        // Use jobId as deduplication ID to prevent duplicate processing
        MessageDeduplicationId: jobId,
        MessageGroupId: request.container, // Group by container type
      });

      try {
        const result = await sqsClient.send(sendMessageCommand);
        console.log('SQS message sent successfully:', result.MessageId);

        return HttpResponse(202, {
          jobId,
          status: "queued",
          message: "Container job queued for processing",
          containerName: request.container,
          timestamp,
          checkStatusUrl: `/api/job/${jobId}`,
          sqsMessageId: result.MessageId,
        });
      } catch (sqsError: any) {
        console.error('Error sending message to SQS:', sqsError);
        return HttpResponse(500, {
          error: "Failed to queue container job",
          details: sqsError.message,
          jobId,
        });
      }
    }

    // No valid request type found
    return HttpResponse(400, {
      error: "Request must contain either 'agent' or 'container' field",
      received: Object.keys(request),
      examples: {
        agent: {
          agent: "weatherAgent",
          prompt: "What's the weather in New York?",
          thread_id: "optional-thread-id"
        },
        container: {
          container: "qa",
          input: "Please test https://example.com",
          thread_id: "optional-thread-id"
        }
      }
    });

  } catch (error: any) {
    console.error('API handler error:', error);
    console.error('Error stack:', error.stack);
    
    return HttpResponse(500, { 
      error: error.message,
      type: error.constructor?.name || 'Error',
      timestamp: new Date().toISOString(),
    });
  }
};