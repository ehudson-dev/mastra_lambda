import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';

export const navigateAndAnalyzeTool = createTool({
  id: "navigate-and-analyze",
  description: "Navigate to a URL and immediately analyze the page structure",
  inputSchema: z.object({
    url: z.string().describe("URL to navigate to"),
    waitUntil: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("load"),
    timeout: z.number().default(30000).describe("Navigation timeout"),
    includeTitle: z
      .boolean()
      .default(true)
      .describe("Include page title in analysis"),
    includeFormInfo: z
      .boolean()
      .default(true)
      .describe("Include basic form info"),
  }),
  outputSchema: z.object({
    success: z.boolean(), // Renamed from 'navigationSuccess'
    url: z.string(),
    title: z.string(),
    login: z.boolean(), // Shortened from 'hasLoginForm'
    search: z.boolean(), // Shortened from 'hasSearchElements'
    forms: z.number(), // Shortened from 'formCount'
    buttons: z.number(), // Shortened from 'buttonCount'
    inputs: z.number(), // Shortened from 'inputCount'
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Navigate and analyze: ${context.url}`);

      await page.goto(context.url, {
        waitUntil: context.waitUntil as any,
        timeout: context.timeout,
      });

      await page.waitForTimeout(2000);

      const url = page.url();
      const title = await page.title();

      const analysis = await page.evaluate(() => {
        const forms = document.querySelectorAll("form");
        const buttons = document.querySelectorAll("button");
        const inputs = document.querySelectorAll("input");

        const hasLoginForm = Array.from(forms).some(
          (form) =>
            form.innerHTML.toLowerCase().includes("password") ||
            form.innerHTML.toLowerCase().includes("login") ||
            form.innerHTML.toLowerCase().includes("sign in")
        );

        const hasSearchElements = Array.from(inputs).some(
          (input) =>
            input.placeholder?.toLowerCase().includes("search") ||
            input.name?.toLowerCase().includes("search")
        );

        return {
          login: hasLoginForm,
          search: hasSearchElements,
          forms: forms.length,
          buttons: buttons.length,
          inputs: inputs.length,
        };
      });

      browserManager.updateActivity();
      console.log(
        `✅ Navigated to ${url} - ${analysis.forms}f ${analysis.inputs}i ${analysis.buttons}b`
      );

      return {
        success: true,
        url: url.length > 100 ? url.substring(0, 100) + '...' : url, // Truncate long URLs
        title: title.substring(0, 100), // Truncate long titles
        ...analysis,
      };
    } catch (error: any) {
      console.error("Navigate and analyze failed:", error);
      return {
        success: false,
        url: context.url,
        title: "",
        login: false,
        search: false,
        forms: 0,
        buttons: 0,
        inputs: 0,
        error: error.message.substring(0, 100),
      };
    }
  },
});