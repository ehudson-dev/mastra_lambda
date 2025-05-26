import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';
import { AdaptiveSelectorEngine } from '../../lib/adaptive_selectors/index.js';

export const findAndTypeTool = createTool({
  id: "find-and-type",
  description: "Find an input element and type text with intelligent element discovery",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector for input element"),
    text: z.string().describe("Text to type"),
    type: z.enum(['email', 'password', 'search', 'text']).optional().describe("Input type for smart detection"),
    elementIndex: z.number().default(0).describe("Index if multiple elements match"),
    clear: z.boolean().default(true).describe("Clear field before typing"),
    pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
    waitTimeout: z.number().default(5000).describe("How long to wait for element"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    found: z.number(),
    typed: z.boolean(),
    adapted: z.boolean().optional(), // Whether selector was auto-corrected
    workingSelector: z.string().optional(), // The selector that actually worked
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`🎯 Smart find and type: ${context.selector}`);

      // Use adaptive selector finding
      const searchResult = await AdaptiveSelectorEngine.findBestSelector(
        page,
        context.selector,
        context.type
      );

      if (!searchResult.found) {
        return {
          success: false,
          found: 0,
          typed: false,
          error: `No elements found for: ${context.selector}`,
        };
      }

      const workingSelector = searchResult.workingSelector || context.selector;
      const wasAdapted = workingSelector !== context.selector;

      if (wasAdapted) {
        console.log(`🔄 Adapted: ${context.selector} → ${workingSelector}`);
      }

      const element = page.locator(workingSelector).nth(context.elementIndex);
      await element.waitFor({ state: "visible", timeout: context.waitTimeout });

      if (context.clear) {
        await element.clear();
      }

      await element.fill(context.text);

      if (context.pressEnter) {
        await element.press("Enter");
      }

      browserManager.updateActivity();

      const result: any = {
        success: true,
        found: searchResult.count,
        typed: true,
      };

      if (wasAdapted) {
        result.adapted = true;
        result.workingSelector = workingSelector;
      }

      return result;

    } catch (error: any) {
      console.error("Smart find and type failed:", error);
      return {
        success: false,
        found: 0,
        typed: false,
        error: error.message.substring(0, 100),
      };
    }
  },
});