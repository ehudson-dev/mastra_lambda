// src/api-handler.ts
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { mastra } from "/opt/nodejs/mastra/index";
import { HttpResponse } from "/opt/nodejs/utils/index";

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

  console.log(event);

  try {

    let request = JSON.parse(event.body!);

    let agent = mastra.getAgent(request.agent);

    const thread_id = request.thread_id ?? crypto.randomUUID();

    const result = await agent.generate(request.input, {
      threadId: thread_id,
      resourceId: "weather",
    });

    return HttpResponse(200, {thread_id: thread_id, ...result});

  } catch (error: any) {

    console.log(error.message);
    return HttpResponse(500, { error: error.message });
  
  }
};
