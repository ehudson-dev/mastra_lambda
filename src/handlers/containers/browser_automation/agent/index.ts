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
  smartLoginTool
} from "../tools/index.js";

const enhancedInstructions = `
Browser automation agent. Complete ALL steps of multi-step tasks.

CRITICAL EFFICIENCY RULES:
- Use ONLY standard CSS selectors (no jQuery syntax)
- Prefer bundled tools to reduce API calls
- **For logins: ALWAYS use smartLogin tool first** - it auto-detects form fields
- Use navigateAndAnalyze to understand new pages quickly

TOOLS PRIORITY ORDER:
1. **smartLogin**: For any login/signin task (auto-detects fields)
2. **navigateAndAnalyze**: Navigate and get page overview  
3. **findAndType/findAndClick**: For individual interactions
4. **fillForm**: For complex multi-field forms (non-login)
5. **screenshot**: For verification and debugging
6. **executeJs**: LAST RESORT ONLY

APPROACH:
1. Plan workflow 
2. Execute step by step
3. After each step, take a screenshot and analyze it for: error messages, success messages, & loading indicators
4. Did the screenshot match your expectations? If not, try adjusting your approach

LOGIN WORKFLOW:
1. navigateAndAnalyze to login page
2. smartLogin with credentials (handles detection automatically)
3. screenshot to verify success
4. Continue with next steps

NEVER manually construct selectors for login forms - let smartLogin handle it.

Example efficient login:
1. navigateAndAnalyze('login-url')
2. smartLogin({ username: 'user@email.com', password: 'pass123' })
3. screenshot('post-login')
4. Continue with main task...
`;

const anthropic = createRateLimitedAnthropic();

export const genericBrowserAgent = new Agent({
  name: "Generic Browser Automation Agent",
  instructions: enhancedInstructions,
  model: anthropic("claude-3-7-sonnet-20250219"),
  tools: {
    smartLogin: smartLoginTool,
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