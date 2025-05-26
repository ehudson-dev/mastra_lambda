import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';
import { saveScreenshotToS3 } from '../../lib/utils/index.js';

export const screenshotTool = createTool({
  id: "screenshot",
  description: "Take a screenshot of the current page",
  inputSchema: z.object({
    filename: z.string().describe("Name for the screenshot file"),
    description: z
      .string()
      .describe("Description of what the screenshot shows"),
    fullPage: z
      .boolean()
      .default(true)
      .describe("Capture full page or just viewport"),
    element: z
      .string()
      .optional()
      .describe("CSS selector to screenshot specific element"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    saved: z.boolean(), // More concise than separate filename/s3Url
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Taking screenshot: ${context.filename}`);

      let screenshot: Buffer;

      if (context.element) {
        const element = page.locator(context.element).first();
        screenshot = await element.screenshot({ type: "png" });
      } else {
        screenshot = await page.screenshot({
          fullPage: context.fullPage,
          type: "png",
        });
      }

      const s3Url = await saveScreenshotToS3(
        screenshot,
        context.filename,
        context.description
      );

      browserManager.updateActivity();
      console.log(`Screenshot saved: ${s3Url}`);

      return {
        success: true,
        saved: true,
      };
    } catch (error: any) {
      console.error("Screenshot failed:", error);
      return {
        success: false,
        saved: false,
        error: error.message.substring(0, 100),
      };
    }
  },
});