// src/handlers/containers/browser_automation/tools/find-and-type.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../browser_context_manager';

export const findAndTypeTool = createTool({
  id: "find-and-type",
  description: "Find an input element and type text into it in one operation",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector for input element"),
    text: z.string().describe("Text to type"),
    elementIndex: z
      .number()
      .default(0)
      .describe("Index if multiple elements match"),
    clear: z.boolean().default(true).describe("Clear field before typing"),
    pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
    waitTimeout: z
      .number()
      .default(5000)
      .describe("How long to wait for element"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    elementsFound: z.number(),
    typed: z.boolean(),
    finalValue: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Find and type: ${context.selector} = "${context.text.substring(0, 50)}..."`
      );

      // Wait for and find elements
      await page.waitForSelector(context.selector, {
        timeout: context.waitTimeout,
      });
      const elements = await page.locator(context.selector).all();

      if (elements.length === 0) {
        return {
          success: false,
          elementsFound: 0,
          typed: false,
          error: `No elements found for selector: ${context.selector}`,
        };
      }

      // Get the target element
      const element = page.locator(context.selector).nth(context.elementIndex);
      await element.waitFor({ state: "visible", timeout: context.waitTimeout });

      // Clear and type
      if (context.clear) {
        await element.clear();
      }

      await element.fill(context.text);

      if (context.pressEnter) {
        await element.press("Enter");
      }

      // Get final value for verification
      const finalValue = await element.inputValue();

      browserManager.updateActivity();
      console.log(
        `✅ Found ${elements.length} elements, typed into element ${context.elementIndex}`
      );

      return {
        success: true,
        elementsFound: elements.length,
        typed: true,
        finalValue,
      };
    } catch (error: any) {
      console.error("Find and type failed:", error);
      return {
        success: false,
        elementsFound: 0,
        typed: false,
        error: error.message,
      };
    }
  },
});