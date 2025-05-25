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
} from "../tools/index.js";

const enhancedInstructions = `
Browser automation agent. Complete ALL steps of multi-step tasks.

CRITICAL EFFICIENCY RULES:
- Use ONLY standard CSS selectors (no jQuery syntax)
- Prefer bundled tools to reduce API calls
- Use fillForm for login (email + password + submit in one call)
- Use navigateAndAnalyze to understand new pages quickly

BUNDLED TOOLS (Preferred - Fewer API calls):
- **findAndType**: Find input and type text in one operation
- **findAndClick**: Find element and click in one operation  
- **navigateAndAnalyze**: Navigate and get page overview in one operation
- **fillForm**: Fill multiple form fields in one operation

INDIVIDUAL TOOLS (Use sparingly):
- wait, screenshot, executeJS, findElements

VALID CSS SELECTORS:
✅ input[type="email"]
✅ button[type="submit"] 
✅ .class-name
✅ #element-id
✅ [aria-label="Login"]
✅ [placeholder*="email"]

INVALID SELECTORS (DO NOT USE):
❌ :contains() - jQuery only
❌ :visible - jQuery only  
❌ :first - jQuery only
❌ :eq() - jQuery only

For text content, use:
✅ button (then check text content)
✅ [aria-label*="text"]
✅ [title*="text"]


Approach:
1. Plan workflow 
2. Execute step by step

Example efficient workflow:
1. navigateAndAnalyze to login page
2. fillForm with username, password, and submit
3. wait for redirect  
4. screenshot homepage
5. findAndType to search field
6. findAndClick search results

`;

const anthropic = createRateLimitedAnthropic();

export const genericBrowserAgent = new Agent({
  name: "Generic Browser Automation Agent",
  instructions: enhancedInstructions,
  model: anthropic("claude-3-7-sonnet-20250219"),
  tools: {
    findAndType: findAndTypeTool,
    findAndClick: findAndClickTool,
    navigateAndAnalyze: navigateAndAnalyzeTool,
    fillForm: fillFormTool,
    wait: waitTool,
    screenshot: screenshotTool,
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
      lastMessages: 3, // Increased for more context
    },
  }),
});