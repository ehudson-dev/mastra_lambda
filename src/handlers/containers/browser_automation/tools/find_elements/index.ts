// src/handlers/containers/browser_automation/tools/find-elements.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../browser_context_manager';

export const findElementsTool = createTool({
  id: "find-elements",
  description: "Find elements on the page using CSS selectors or text content",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector to find elements"),
    waitFor: z
      .boolean()
      .default(false)
      .describe("Whether to wait for elements to appear"),
    timeout: z.number().default(5000).describe("Timeout for waiting"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Finding elements: ${context.selector}`);

      if (context.waitFor) {
        try {
          await page.waitForSelector(context.selector, {
            timeout: context.timeout,
          });
        } catch (e) {
          console.log(`Wait timeout for selector: ${context.selector}`);
        }
      }

      const elements = await page.locator(context.selector).all();
      console.log(
        `Found ${elements.length} elements matching: ${context.selector}`
      );
      browserManager.updateActivity();

      return {
        success: true,
        count: elements.length,
      };
    } catch (error: any) {
      console.error("Find elements failed:", error);
      return {
        success: false,
        count: 0,
        elements: [],
        error: error.message,
      };
    }
  },
});