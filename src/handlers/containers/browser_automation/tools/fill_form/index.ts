// src/handlers/containers/browser_automation/tools/fill-form.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';

export const fillFormTool = createTool({
  id: "fill-form",
  description: "Fill multiple form fields in one operation",
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          selector: z.string(),
          value: z.string(),
          clear: z.boolean().default(true),
        })
      )
      .describe("Array of fields to fill"),
    submitSelector: z
      .string()
      .optional()
      .describe("Submit button selector (will click if provided)"),
    waitBetweenFields: z
      .number()
      .default(500)
      .describe("Milliseconds to wait between field fills"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    fieldsFilled: z.number(),
    submitted: z.boolean(),
    errors: z.array(z.string()),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Fill form with ${context.fields.length} fields`);

      const errors: string[] = [];
      let fieldsFilled = 0;

      // Fill each field
      for (const field of context.fields) {
        try {
          await page.waitForSelector(field.selector, { timeout: 5000 });
          const element = page.locator(field.selector).first();

          if (field.clear) {
            await element.clear();
          }

          await element.fill(field.value);
          fieldsFilled++;

          if (context.waitBetweenFields > 0) {
            await page.waitForTimeout(context.waitBetweenFields);
          }

          console.log(`✓ Filled field: ${field.selector}`);
        } catch (error: any) {
          const errorMsg = `Failed to fill ${field.selector}: ${error.message}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      // Submit if requested
      let submitted = false;
      if (context.submitSelector) {
        try {
          await page.waitForSelector(context.submitSelector, { timeout: 5000 });
          await page.locator(context.submitSelector).first().click();
          submitted = true;
          console.log(`✓ Clicked submit: ${context.submitSelector}`);
        } catch (error: any) {
          errors.push(`Failed to submit: ${error.message}`);
        }
      }

      browserManager.updateActivity();
      console.log(
        `✅ Form fill completed: ${fieldsFilled}/${context.fields.length} fields filled`
      );

      return {
        success: errors.length === 0,
        fieldsFilled,
        submitted,
        errors,
      };
    } catch (error: any) {
      console.error("Form fill failed:", error);
      return {
        success: false,
        fieldsFilled: 0,
        submitted: false,
        errors: [error.message],
      };
    }
  },
});