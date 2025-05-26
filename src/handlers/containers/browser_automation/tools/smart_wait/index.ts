import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { BrowserContextManager } from "../../lib/browser_context_manager/index.js";

export const smartWaitTool = createTool({
  id: "smart-wait",
  description:
    "Intelligent waiting - wait for specific elements, URL changes, or content to appear",
  inputSchema: z.object({
    type: z
      .enum(["element", "url-change", "content", "time"])
      .describe("Type of wait condition"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector to wait for (if type=element)"),
    content: z
      .string()
      .optional()
      .describe("Text content to wait for (if type=content)"),
    timeout: z
      .number()
      .default(10000)
      .describe("Max wait time in milliseconds"),
    urlPattern: z
      .string()
      .optional()
      .describe("URL pattern to wait for (if type=url-change)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    conditionMet: z.boolean(),
    waitTime: z.number(),
    currentUrl: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context }): Promise<any> => {
    let startTime, browserManager, page;

    try {
      startTime = Date.now();
      browserManager = BrowserContextManager.getInstance();
      page = await browserManager.getPage();
      console.log(`⏳ Smart wait: ${context.type} (${context.timeout}ms max)`);

      let conditionMet = false;
      const currentUrl = page.url();

      switch (context.type) {
        case "element":
          if (context.selector) {
            try {
              await page.waitForSelector(context.selector, {
                timeout: context.timeout,
                state: "visible",
              });
              conditionMet = true;
              console.log(`✅ Element appeared: ${context.selector}`);
            } catch (e) {
              console.log(`⏰ Element wait timeout: ${context.selector}`);
            }
          }
          break;

        case "url-change":
          try {
            await page.waitForFunction(
              (originalUrl) => window.location.href !== originalUrl,
              currentUrl,
              { timeout: context.timeout }
            );
            conditionMet = true;
            const newUrl = page.url();
            console.log(`✅ URL changed from: ${currentUrl} to: ${newUrl}`);
          } catch (e) {
            console.log(`⏰ URL change timeout - still at: ${page.url()}`);
          }
          break;

        case "content":
          if (context.content) {
            try {
              await page.waitForFunction(
                (content) => {
                  const bodyText = document.body.textContent || "";
                  return bodyText.toLowerCase().includes(content.toLowerCase());
                },
                context.content,
                { timeout: context.timeout }
              );
              conditionMet = true;
              console.log(`✅ Content appeared: "${context.content}"`);
            } catch (e) {
              console.log(`⏰ Content wait timeout: "${context.content}"`);
            }
          }
          break;

        case "time":
        default:
          await page.waitForTimeout(context.timeout);
          conditionMet = true;
          console.log(`✅ Time wait completed: ${context.timeout}ms`);
          break;
      }

      const waitTime = Date.now() - startTime;
      const finalUrl = page.url();

      browserManager.updateActivity();

      return {
        success: true,
        conditionMet,
        waitTime,
        currentUrl: finalUrl,
        message: `Wait completed: ${conditionMet ? "condition met" : "timeout"} in ${waitTime}ms`,
      };
    } catch (error: any) {
      const waitTime = Date.now() - startTime;
      console.error("Smart wait failed:", error);
      return {
        success: false,
        conditionMet: false,
        waitTime,
        currentUrl: page?.url(),
        message: `Wait failed: ${error.message}`,
      };
    }
  },
});
