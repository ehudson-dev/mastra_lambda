// src/handlers/containers/browser_automation/index.ts
import { BrowserContextManager } from "./lib/browser_context_manager/index.js";
import { genericBrowserAgent } from "./agent/index.js";

// Main Lambda handler
export const handler = async (event: any): Promise<any> => {
  console.log("Generic Browser Agent invoked");
  console.log("Event:", JSON.stringify(event, null, 2));

  const browserManager = BrowserContextManager.getInstance();

  try {
    if (!event.input) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required field: input",
          usage: "Provide a natural language prompt for browser automation",
          examples: [
            'Go to the login page, log in with the credentials, then search for "jim johnson" and find his phone number',
            "Navigate to example.com and take a screenshot",
            "Find all the input fields on the current page and tell me what they are for",
          ],
        }),
      };
    }

    const threadId: string = event.thread_id || crypto.randomUUID();
    const jobId: string = event.jobId;
    const startTime = Date.now();

    // Set job ID in environment for screenshot naming
    process.env.JOB_ID = jobId;

    console.log(
      `Processing generic browser automation with thread ID: ${threadId}, job ID: ${jobId}`
    );

    const result = await genericBrowserAgent.generate(event.input, {
      threadId,
      resourceId: "generic-browser-automation",
      maxSteps: event.maxSteps || 25,
      maxRetries: event.maxRetries || 0,
      maxTokens: event.maxTokens || 64000,
    });

    const processingTime = Date.now() - startTime;
    console.log(`Generic browser automation completed in ${processingTime}ms`);

    const response = {
      thread_id: threadId,
      job_id: jobId,
      processingTime,
      automationType: "generic-browser",
      features: [
        "navigation",
        "element-finding",
        "clicking",
        "typing",
        "waiting",
        "screenshots",
        "page-analysis",
        "javascript-execution",
      ],
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        memoryUsage: process.memoryUsage(),
        region: process.env.AWS_REGION,
      },
      ...result,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };
  } catch (error: any) {
    console.error("Generic browser automation error:", error);
    console.error("Error stack:", error.stack);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        automationType: "generic-browser",
        type: error.constructor?.name || "Error",
        timestamp: new Date().toISOString(),
        job_id: event.jobId,
      }),
    };
  } finally {
    // Clean up browser context on completion
    try {
      await browserManager.cleanup();
    } catch (e) {
      console.error("Error during final cleanup:", e);
    }
  }
};