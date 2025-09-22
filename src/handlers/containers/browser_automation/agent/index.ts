// src/handlers/containers/browser_automation/agent.ts
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { DynamoDBStore } from "@mastra/dynamodb";
import { createRateLimitedAnthropic } from "../lib/anthropic/index.js";
import {
  findAndTypeTool,
  findAndClickTool,
  navigateAndAnalyzeTool,
  fillFormTool,
  waitTool,
  screenshotTool,
  executeJSTool,
  findElementsTool,
  smartWaitTool,
  textUploadTool
} from "../tools/index.js";

const enhancedInstructions = `
Browser automation agent. Complete ALL steps of multi-step tasks.

APPROACH:
1. Plan workflow 
2. Execute step by step
3. After each step, take a screenshot and analyze it for: error messages, success messages, & loading indicators
4. Did the screenshot match your expectations? If not, try adjusting your approach

`;

const anthropic = createRateLimitedAnthropic();

export const genericBrowserAgent = new Agent({
  name: "Generic Browser Automation Agent",
  instructions: enhancedInstructions,
  model: anthropic("claude-sonnet-4-20250514"),
  tools: {
    smartWait: smartWaitTool,
    navigateAndAnalyze: navigateAndAnalyzeTool,
    screenshot: screenshotTool,
    textUploadTool: textUploadTool,
    findAndType: findAndTypeTool,
    findAndClick: findAndClickTool,
    wait: waitTool,
    executeJs: executeJSTool,
    findElements: findElementsTool,
  },
  memory: new Memory({
    storage: new DynamoDBStore({
      name: "dynamodb",
      config: {
        tableName: process.env.MASTRA_TABLE_NAME!,
        region: process.env.REGION!,
      },
    }),
    options: {
      lastMessages: 1000, // doesn't seem to have a significant impact on token use
    },
  }),
});