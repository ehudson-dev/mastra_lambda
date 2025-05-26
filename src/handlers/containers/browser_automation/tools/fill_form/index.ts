import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';
import { AdaptiveSelectorEngine } from '../../lib/adaptive_selectors/index.js';

export const fillFormTool = createTool({
  id: "fill-form",
  description: "Fill multiple form fields with intelligent element discovery",
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          selector: z.string(),
          value: z.string(),
          type: z.enum(['email', 'password', 'search', 'text']).optional(),
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
    autoDetect: z
      .boolean()
      .default(true)
      .describe("Automatically detect form structure if selectors fail"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filled: z.number(),
    submitted: z.boolean(),
    errors: z.number(),
    adaptations: z.number().optional(), // How many selectors were auto-corrected
    suggestions: z.array(z.string()).optional(), // Working selectors found
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`🎯 Smart form fill with ${context.fields.length} fields`);

      const errors: string[] = [];
      const suggestions: string[] = [];
      let filled = 0;
      let adaptations = 0;

      // Auto-detect form structure if enabled
      let formStructure: any = {};
      if (context.autoDetect) {
        formStructure = await AdaptiveSelectorEngine.detectFormStructure(page);
        console.log(`📋 Detected form structure:`, formStructure);
      }

      // Fill each field with adaptive selection
      for (const field of context.fields) {
        try {
          // Try adaptive selector finding
          const searchResult = await AdaptiveSelectorEngine.findBestSelector(
            page, 
            field.selector, 
            field.type
          );

          if (!searchResult.found) {
            errors.push(`No element found for ${field.selector}`);
            console.error(`❌ Could not find any element for: ${field.selector}`);
            continue;
          }

          const workingSelector = searchResult.workingSelector || field.selector;
          
          if (workingSelector !== field.selector) {
            adaptations++;
            suggestions.push(`${field.selector} → ${workingSelector}`);
            console.log(`🔄 Adapted selector: ${field.selector} → ${workingSelector}`);
          }

          // Use the working selector
          const element = page.locator(workingSelector).first();
          await element.waitFor({ state: 'visible', timeout: 5000 });

          if (field.clear) {
            await element.clear();
          }

          await element.fill(field.value);
          filled++;

          if (context.waitBetweenFields > 0) {
            await page.waitForTimeout(context.waitBetweenFields);
          }

          console.log(`✅ Filled: ${workingSelector}`);
          
        } catch (error: any) {
          const errorMsg = `Failed ${field.selector}: ${error.message}`;
          errors.push(errorMsg);
          console.error(`❌ ${errorMsg}`);
        }
      }

      // Smart submit button handling
      let submitted = false;
      if (context.submitSelector) {
        try {
          const submitResult = await AdaptiveSelectorEngine.findBestSelector(
            page,
            context.submitSelector,
            'submit'
          );

          if (submitResult.found) {
            const workingSubmit = submitResult.workingSelector || context.submitSelector;
            
            if (workingSubmit !== context.submitSelector) {
              adaptations++;
              suggestions.push(`submit: ${context.submitSelector} → ${workingSubmit}`);
            }

            await page.locator(workingSubmit).first().click();
            submitted = true;
            console.log(`✅ Submitted via: ${workingSubmit}`);
          } else {
            errors.push(`Submit button not found: ${context.submitSelector}`);
          }
          
        } catch (error: any) {
          errors.push(`Submit failed: ${error.message}`);
        }
      }

      browserManager.updateActivity();
      
      const result: any = {
        success: errors.length === 0,
        filled,
        submitted,
        errors: errors.length,
      };

      if (adaptations > 0) {
        result.adaptations = adaptations;
        result.suggestions = suggestions;
      }

      console.log(`🎯 Smart form fill: ${filled}/${context.fields.length} filled, ${adaptations} adaptations`);
      
      return result;
      
    } catch (error: any) {
      console.error("Smart form fill failed:", error);
      return {
        success: false,
        filled: 0,
        submitted: false,
        errors: 1,
      };
    }
  },
});