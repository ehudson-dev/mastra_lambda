// src/handlers/containers/browser_automation/tools/execute-js.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../browser_context_manager.js';

export const executeJSTool = createTool({
  id: "execute-js",
  description: "Execute custom JavaScript code in the page context",
  inputSchema: z.object({
    script: z.string().describe("JavaScript code to execute"),
    args: z
      .array(z.any())
      .default([])
      .describe("Arguments to pass to the script"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.any(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Executing JavaScript: ${context.script.substring(0, 100)}...`
      );

      // Create a function wrapper that can be serialized by Playwright
      const result = await page.evaluate(
        ({ script, args }) => {
          // Create and execute the function in the browser context
          const func = new Function("...args", script);
          return func(...args);
        },
        { script: context.script, args: context.args }
      );

      browserManager.updateActivity();
      console.log("JavaScript execution completed");

      return {
        success: true,
        result,
      };
    } catch (error: any) {
      console.error("JavaScript execution failed:", error);
      return {
        success: false,
        result: null,
        error: error.message,
      };
    }
  },
});