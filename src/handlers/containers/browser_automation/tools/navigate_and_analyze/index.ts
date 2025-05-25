// src/handlers/containers/browser_automation/tools/navigate-and-analyze.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../browser_context_manager.js';

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
    navigationSuccess: z.boolean(),
    url: z.string(),
    title: z.string(),
    hasLoginForm: z.boolean(),
    hasSearchElements: z.boolean(),
    formCount: z.number(),
    buttonCount: z.number(),
    inputCount: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Navigate and analyze: ${context.url}`);

      // Navigate
      await page.goto(context.url, {
        waitUntil: context.waitUntil as any,
        timeout: context.timeout,
      });

      // Brief wait for page to settle
      await page.waitForTimeout(2000);

      const url = page.url();
      const title = await page.title();

      // Quick analysis without heavy data
      const analysis = await page.evaluate(() => {
        const forms = document.querySelectorAll("form");
        const buttons = document.querySelectorAll("button");
        const inputs = document.querySelectorAll("input");

        // Check for login indicators
        const hasLoginForm = Array.from(forms).some(
          (form) =>
            form.innerHTML.toLowerCase().includes("password") ||
            form.innerHTML.toLowerCase().includes("login") ||
            form.innerHTML.toLowerCase().includes("sign in")
        );

        // Check for search indicators
        const hasSearchElements = Array.from(inputs).some(
          (input) =>
            input.placeholder?.toLowerCase().includes("search") ||
            input.name?.toLowerCase().includes("search")
        );

        return {
          hasLoginForm,
          hasSearchElements,
          formCount: forms.length,
          buttonCount: buttons.length,
          inputCount: inputs.length,
        };
      });

      browserManager.updateActivity();
      console.log(
        `✅ Navigated to ${url} and analyzed: ${analysis.formCount} forms, ${analysis.inputCount} inputs`
      );

      return {
        navigationSuccess: true,
        url,
        title,
        ...analysis,
      };
    } catch (error: any) {
      console.error("Navigate and analyze failed:", error);
      return {
        navigationSuccess: false,
        url: context.url,
        title: "",
        hasLoginForm: false,
        hasSearchElements: false,
        formCount: 0,
        buttonCount: 0,
        inputCount: 0,
        error: error.message,
      };
    }
  },
});