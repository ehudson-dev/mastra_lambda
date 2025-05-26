import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';

export const findAndClickTool = createTool({
  id: "find-and-click",
  description: "Find a clickable element and click it in one operation",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector for element to click"),
    elementIndex: z
      .number()
      .default(0)
      .describe("Index if multiple elements match"),
    waitTimeout: z
      .number()
      .default(5000)
      .describe("How long to wait for element"),
    force: z
      .boolean()
      .default(false)
      .describe("Force click even if element not ready"),
    waitAfterClick: z
      .number()
      .default(1000)
      .describe("Milliseconds to wait after clicking"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    found: z.number(), // Shortened from 'elementsFound'
    clicked: z.boolean(),
    text: z.string().optional(), // Shortened from 'elementText' and truncated
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Find and click: ${context.selector} (index: ${context.elementIndex})`
      );

      await page.waitForSelector(context.selector, {
        timeout: context.waitTimeout,
      });
      const elements = await page.locator(context.selector).all();

      if (elements.length === 0) {
        return {
          success: false,
          found: 0,
          clicked: false,
          error: `No elements: ${context.selector}`,
        };
      }

      if (context.elementIndex >= elements.length) {
        return {
          success: false,
          found: elements.length,
          clicked: false,
          error: `Index ${context.elementIndex} > ${elements.length-1}`,
        };
      }

      const element = page.locator(context.selector).nth(context.elementIndex);
      const elementText = (await element.textContent()) || "";

      await element.click({ force: context.force });

      if (context.waitAfterClick > 0) {
        await page.waitForTimeout(context.waitAfterClick);
      }

      browserManager.updateActivity();
      console.log(
        `✅ Found ${elements.length} elements, clicked element ${context.elementIndex}: "${elementText}"`
      );

      return {
        success: true,
        found: elements.length,
        clicked: true,
        text: elementText.substring(0, 50), // Truncate element text
      };
    } catch (error: any) {
      console.error("Find and click failed:", error);
      return {
        success: false,
        found: 0,
        clicked: false,
        error: error.message.substring(0, 100),
      };
    }
  },
});