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
  smartLoginTool,
  smartSearchTool,
  smartTableClickTool,
  smartWaitTool
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
   // Tier 1 - Workflow tools (prioritized)
    smartLogin: smartLoginTool,
    smartSearch: smartSearchTool,
    smartTableClick: smartTableClickTool, 
    smartWait: smartWaitTool,
    
    // Tier 2 - Navigation
    navigateAndAnalyze: navigateAndAnalyzeTool,
    screenshot: screenshotTool,
    
    // Tier 3 - Individual actions (discouraged)
    findAndType: findAndTypeTool,
    findAndClick: findAndClickTool,
    fillForm: fillFormTool,
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