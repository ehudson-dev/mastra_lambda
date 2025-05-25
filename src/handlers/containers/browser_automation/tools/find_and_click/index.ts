// src/handlers/containers/browser_automation/tools/find-and-click.ts
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
    elementsFound: z.number(),
    clicked: z.boolean(),
    elementText: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Find and click: ${context.selector} (index: ${context.elementIndex})`
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
          clicked: false,
          error: `No elements found for selector: ${context.selector}`,
        };
      }

      if (context.elementIndex >= elements.length) {
        return {
          success: false,
          elementsFound: elements.length,
          clicked: false,
          error: `Element index ${context.elementIndex} out of range (found ${elements.length} elements)`,
        };
      }

      // Get element text for verification
      const element = page.locator(context.selector).nth(context.elementIndex);
      const elementText = (await element.textContent()) || "";

      // Click the element
      await element.click({ force: context.force });

      // Wait after click for any resulting changes
      if (context.waitAfterClick > 0) {
        await page.waitForTimeout(context.waitAfterClick);
      }

      browserManager.updateActivity();
      console.log(
        `✅ Found ${elements.length} elements, clicked element ${context.elementIndex}: "${elementText}"`
      );

      return {
        success: true,
        elementsFound: elements.length,
        clicked: true,
        elementText: elementText.substring(0, 100), // Limit text length
      };
    } catch (error: any) {
      console.error("Find and click failed:", error);
      return {
        success: false,
        elementsFound: 0,
        clicked: false,
        error: error.message,
      };
    }
  },
});