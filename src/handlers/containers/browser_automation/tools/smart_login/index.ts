import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';
import { AdaptiveSelectorEngine } from '../../lib/adaptive_selectors/index.js';

export const smartLoginTool = createTool({
  id: "smart-login",
  description: "Automatically detect and fill login forms with intelligent field mapping",
  inputSchema: z.object({
    username: z.string().describe("Username, email, or login identifier"),
    password: z.string().describe("Password"),
    submitAfterFill: z.boolean().default(true).describe("Click submit button after filling"),
    waitAfterSubmit: z.number().default(3000).describe("Ms to wait after submit"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    detected: z.object({
      usernameField: z.string().optional(),
      passwordField: z.string().optional(), 
      submitButton: z.string().optional(),
    }),
    filled: z.number(),
    submitted: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`🎯 Smart login: detecting form structure...`);

      // Detect form structure
      const formStructure = await AdaptiveSelectorEngine.detectFormStructure(page);
      console.log(`📋 Form structure:`, formStructure);

      // Smart field mapping
      const fieldMapping = await smartFieldMapping(page, formStructure);
      console.log(`🧠 Field mapping:`, fieldMapping);

      if (!fieldMapping.usernameField || !fieldMapping.passwordField) {
        return {
          success: false,
          detected: fieldMapping,
          filled: 0,
          submitted: false,
          message: `Missing fields - username: ${!!fieldMapping.usernameField}, password: ${!!fieldMapping.passwordField}`,
        };
      }

      let filled = 0;
      const errors: string[] = [];

      // Fill username field
      try {
        const usernameElement = page.locator(fieldMapping.usernameField).first();
        await usernameElement.waitFor({ state: 'visible', timeout: 5000 });
        await usernameElement.clear();
        await usernameElement.fill(context.username);
        filled++;
        console.log(`✅ Username filled: ${fieldMapping.usernameField}`);
      } catch (error: any) {
        errors.push(`Username fill failed: ${error.message}`);
      }

      // Small delay between fields
      await page.waitForTimeout(500);

      // Fill password field  
      try {
        const passwordElement = page.locator(fieldMapping.passwordField).first();
        await passwordElement.waitFor({ state: 'visible', timeout: 5000 });
        await passwordElement.clear();
        await passwordElement.fill(context.password);
        filled++;
        console.log(`✅ Password filled: ${fieldMapping.passwordField}`);
      } catch (error: any) {
        errors.push(`Password fill failed: ${error.message}`);
      }

      // Submit if requested and button found
      let submitted = false;
      if (context.submitAfterFill && fieldMapping.submitButton) {
        try {
          await page.waitForTimeout(500); // Brief pause before submit
          const submitElement = page.locator(fieldMapping.submitButton).first();
          await submitElement.click();
          submitted = true;
          console.log(`✅ Submitted via: ${fieldMapping.submitButton}`);
          
          if (context.waitAfterSubmit > 0) {
            await page.waitForTimeout(context.waitAfterSubmit);
          }
        } catch (error: any) {
          errors.push(`Submit failed: ${error.message}`);
        }
      }

      browserManager.updateActivity();

      const success = errors.length === 0;
      const message = success 
        ? `Login completed: ${filled}/2 fields filled, submitted: ${submitted}`
        : `Login issues: ${errors.join(', ')}`;

      return {
        success,
        detected: fieldMapping,
        filled,
        submitted,
        message,
      };

    } catch (error: any) {
      console.error("Smart login failed:", error);
      return {
        success: false,
        detected: {},
        filled: 0,
        submitted: false,
        message: `Login failed: ${error.message}`,
      };
    }
  },
});

// Smart field mapping logic
async function smartFieldMapping(page: any, formStructure: any): Promise<{
  usernameField?: string;
  passwordField?: string;
  submitButton?: string;
}> {
  
  const mapping: any = {};

  // Find username/email field with priority order
  const usernamePatterns = [
    // Use detected structure first
    ...(formStructure.emailField ? [formStructure.emailField] : []),
    // Then try common patterns
    'input[name="username"]',
    'input[name="email"]', 
    'input[name="user"]',
    'input[name="login"]',
    'input[type="email"]',
    'input[id="username"]',
    'input[id="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="user" i]',
    // Fallback: any text input in a form
    'form input[type="text"]:first-of-type',
    'input[type="text"]:first-of-type',
  ];

  for (const pattern of usernamePatterns) {
    try {
      const elements = await page.locator(pattern).all();
      if (elements.length > 0) {
        mapping.usernameField = pattern;
        console.log(`🎯 Username field: ${pattern}`);
        break;
      }
    } catch (e) {
      // Continue trying
    }
  }

  // Find password field
  const passwordPatterns = [
    // Use detected structure first
    ...(formStructure.passwordField ? [formStructure.passwordField] : []),
    // Then try common patterns  
    'input[type="password"]',
    'input[name="password"]',
    'input[name="pass"]',
    'input[id="password"]',
    'input[placeholder*="password" i]',
  ];

  for (const pattern of passwordPatterns) {
    try {
      const elements = await page.locator(pattern).all();
      if (elements.length > 0) {
        mapping.passwordField = pattern;
        console.log(`🎯 Password field: ${pattern}`);
        break;
      }
    } catch (e) {
      // Continue trying
    }
  }

  // Find submit button
  const submitPatterns = [
    // Use detected structure first
    ...(formStructure.submitButton ? [formStructure.submitButton] : []),
    // Then try common patterns
    'button[type="submit"]',
    'input[type="submit"]', 
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Sign In")',
    '.login-btn',
    '.submit-btn',
    // Fallback: any button in a form
    'form button:first-of-type',
    'button:first-of-type',
  ];

  for (const pattern of submitPatterns) {
    try {
      const elements = await page.locator(pattern).all();
      if (elements.length > 0) {
        mapping.submitButton = pattern;
        console.log(`🎯 Submit button: ${pattern}`);
        break;
      }
    } catch (e) {
      // Continue trying
    }
  }

  return mapping;
}