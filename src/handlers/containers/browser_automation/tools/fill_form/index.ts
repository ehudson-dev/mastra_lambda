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
    filled: z.number(), // Shortened from 'fieldsFilled'
    submitted: z.boolean(),
    errors: z.number(), // Return count instead of array of error messages
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Fill form with ${context.fields.length} fields`);

      const errors: string[] = [];
      let filled = 0;

      // Fill each field
      for (const field of context.fields) {
        try {
          await page.waitForSelector(field.selector, { timeout: 5000 });
          const element = page.locator(field.selector).first();

          if (field.clear) {
            await element.clear();
          }

          await element.fill(field.value);
          filled++;

          if (context.waitBetweenFields > 0) {
            await page.waitForTimeout(context.waitBetweenFields);
          }

          console.log(`✓ Filled field: ${field.selector}`);
        } catch (error: any) {
          const errorMsg = `Failed ${field.selector}: ${error.message}`;
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
          errors.push(`Submit failed: ${error.message}`);
        }
      }

      browserManager.updateActivity();
      console.log(
        `✅ Form fill completed: ${filled}/${context.fields.length} fields filled`
      );

      return {
        success: errors.length === 0,
        filled,
        submitted,
        errors: errors.length, // Return count, not full error messages
      };
    } catch (error: any) {
      console.error("Form fill failed:", error);
      return {
        success: false,
        filled: 0,
        submitted: false,
        errors: 1,
      };
    }
  },
});