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

WORKFLOW EFFICIENCY RULES:
- **Prioritize bundled workflow tools** - they combine multiple actions
- Use ONLY standard CSS selectors (no jQuery syntax)
- One workflow tool > multiple atomic tools

TOOL PRIORITY (use higher numbered tools first):
**TIER 1 - Workflow Tools (Preferred):**
1. **smartLogin**: For any login/signin (auto-detects + fills + submits)
2. **smartSearch**: For search tasks (finds field + types + waits for results)  
3. **smartTableClick**: For table interactions (finds rows + clicks + waits)
4. **smartWait**: For intelligent waiting (conditions vs fixed time)

**TIER 2 - Navigation & Analysis:**
5. **navigateAndAnalyze**: Navigate + get page overview
6. **screenshot**: For verification and debugging

**TIER 3 - Individual Actions (Use sparingly):**
7. **findAndType/findAndClick**: Only for unique interactions
8. **fillForm**: For complex non-login forms
9. **wait**: Only if smartWait doesn't fit
10. **executeJs**: ABSOLUTE LAST RESORT

APPROACH:
1. Plan workflow 
2. Execute step by step
3. After each step, take a screenshot and analyze it for: error messages, success messages, & loading indicators
4. Did the screenshot match your expectations? If not, try adjusting your approach

OPTIMAL WORKFLOWS:

**Login Flow:**
- navigateAndAnalyze → smartLogin → screenshot (3 calls total)

**Search Flow:**  
- smartSearch (with takeScreenshot: true) (1 call total)

**Table Interaction:**
- smartTableClick → smartWait (type: 'url-change') (2 calls total)

**Instead of multiple atomic actions, think in workflows:**
❌ Bad: findElements → findAndType → wait → screenshot → findElements → findAndClick
✅ Good: smartSearch → smartTableClick

**For your example task:**
1. navigateAndAnalyze (login page)
2. smartLogin (credentials)  
3. smartSearch (query: "brad johnson", takeScreenshot: true)
4. smartTableClick (rowIndex: 0)
5. smartWait (type: 'url-change') 
6. screenshot (final result)
= 6 total API calls vs 15+

Always ask: "Can I use a workflow tool instead of multiple atomic tools?"
`;

const anthropic = createRateLimitedAnthropic();

export const genericBrowserAgent = new Agent({
  name: "Generic Browser Automation Agent",
  instructions: enhancedInstructions,
  model: anthropic("claude-3-7-sonnet-20250219"),
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
      lastMessages: 1, // only give the agent context did the last step succeed or fail
    },
  }),
});