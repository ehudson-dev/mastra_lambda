// src/handlers/containers/qa/index.ts - Flexible Browser Automation Agent
import { chromium, Page, Browser } from 'playwright-core';
import { anthropic } from '@ai-sdk/anthropic';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { DynamoDBStore } from '@mastra/dynamodb';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: process.env.REGION || process.env.AWS_REGION,
});

// Flexible action types for general browser automation
interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'select' | 'screenshot' | 'extract_text' | 'check_element' | 'custom_js';
  selector?: string;
  value?: string;
  url?: string;
  timeout?: number;
  description: string;
  saveAs?: string; // For screenshots and extracted data
  script?: string; // For custom JavaScript
}

interface BrowserResult {
  success: boolean;
  url: string;
  pageTitle: string;
  actions: {
    completed: BrowserAction[];
    failed: Array<{action: BrowserAction, error: string}>;
  };
  screenshots: Array<{
    name: string;
    s3Url: string;
    description: string;
    timestamp: string;
  }>;
  extractedData: Record<string, any>;
  errors: string[];
  executionTime: number;
}

// Flexible browser automation tool
const flexibleBrowserTool = createTool({
  id: 'flexible-browser-automation',
  description: 'Perform flexible browser automation tasks including navigation, interaction, and data extraction',
  inputSchema: z.object({
    url: z.string().describe('Starting URL'),
    prompt: z.string().describe('Natural language description of what to do'),
    // Optional structured actions if the user wants to be specific
    actions: z.array(z.object({
      type: z.enum(['navigate', 'click', 'type', 'wait', 'scroll', 'select', 'screenshot', 'extract_text', 'check_element', 'custom_js']),
      selector: z.string().optional(),
      value: z.string().optional(),
      url: z.string().optional(),
      timeout: z.number().optional(),
      description: z.string(),
      saveAs: z.string().optional(),
      script: z.string().optional(),
    })).optional().describe('Optional specific actions to perform'),
    // Authentication if needed
    credentials: z.object({
      username: z.string(),
      password: z.string(),
      loginUrl: z.string().optional(),
      usernameSelector: z.string().optional(),
      passwordSelector: z.string().optional(),
      submitSelector: z.string().optional(),
    }).optional().describe('Login credentials if authentication is required'),
    timeout: z.number().default(60000).describe('Overall timeout in milliseconds'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    url: z.string(),
    pageTitle: z.string(),
    actions: z.object({
      completed: z.array(z.any()),
      failed: z.array(z.object({
        action: z.any(),
        error: z.string(),
      })),
    }),
    screenshots: z.array(z.object({
      name: z.string(),
      s3Url: z.string(),
      description: z.string(),
      timestamp: z.string(),
    })),
    extractedData: z.record(z.any()),
    errors: z.array(z.string()),
    executionTime: z.number(),
  }),
  execute: async ({ context }): Promise<BrowserResult> => {
    console.log(`Flexible browser automation executing: ${context.prompt}`);
    return await performBrowserAutomation(context);
  },
});

const performBrowserAutomation = async (context: any): Promise<BrowserResult> => {
  let browser: Browser | null = null;
  const startTime = Date.now();
  const errors: string[] = [];
  const screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}> = [];
  const extractedData: Record<string, any> = {};
  const completedActions: BrowserAction[] = [];
  const failedActions: Array<{action: BrowserAction, error: string}> = [];

  const result: BrowserResult = {
    success: false,
    url: context.url,
    pageTitle: '',
    actions: { completed: [], failed: [] },
    screenshots: [],
    extractedData: {},
    errors: [],
    executionTime: 0,
  };

  try {
    console.log('Launching browser for flexible automation...');
    
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--single-process',
        '--no-zygote',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    const page: Page = await browser.newPage({
      viewport: { width: 1280, height: 720 }
    });

    // Listen for errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`Console Error: ${msg.text()}`);
      }
    });

    page.on('pageerror', (error: Error) => {
      errors.push(`Page Error: ${error.message}`);
    });

    // Navigate to initial URL
    console.log(`Navigating to: ${context.url}`);
    await page.goto(context.url, { 
      waitUntil: 'networkidle',
      timeout: context.timeout || 60000
    });

    result.pageTitle = await page.title();
    result.url = page.url();

    // Handle authentication if provided
    if (context.credentials) {
      try {
        await performLogin(page, context.credentials);
        console.log('Login completed successfully');
      } catch (error: any) {
        errors.push(`Login failed: ${error.message}`);
        // Continue with automation even if login fails
      }
    }

    // If structured actions are provided, execute them
    if (context.actions && context.actions.length > 0) {
      for (const action of context.actions) {
        try {
          await executeAction(page, action, screenshots, extractedData);
          completedActions.push(action);
          console.log(`✓ Action completed: ${action.description}`);
        } catch (error: any) {
          const errorMsg = `Action failed: ${action.description} - ${error.message}`;
          failedActions.push({ action, error: errorMsg });
          errors.push(errorMsg);
          console.log(`✗ Action failed: ${action.description}`);
        }
      }
    } else {
      // If no structured actions, let the AI determine what to do based on the prompt
      // This is where we'd integrate with the AI to convert natural language to actions
      console.log(`Interpreting prompt: "${context.prompt}"`);
      const inferredActions = await interpretPromptToActions(context.prompt, page);
      
      for (const action of inferredActions) {
        try {
          await executeAction(page, action, screenshots, extractedData);
          completedActions.push(action);
          console.log(`✓ Inferred action completed: ${action.description}`);
        } catch (error: any) {
          const errorMsg = `Inferred action failed: ${action.description} - ${error.message}`;
          failedActions.push({ action, error: errorMsg });
          errors.push(errorMsg);
          console.log(`✗ Inferred action failed: ${action.description}`);
        }
      }
    }

    result.actions.completed = completedActions;
    result.actions.failed = failedActions;
    result.screenshots = screenshots;
    result.extractedData = extractedData;
    result.errors = errors;
    result.success = failedActions.length === 0 && errors.length === 0;

    await browser.close();
    console.log('Browser automation completed successfully');

    return result;

  } catch (error: any) {
    console.error('Browser automation failed:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }

    result.errors = [...errors, `Automation failed: ${error.message}`];
    result.executionTime = Date.now() - startTime;
    return result;
  } finally {
    result.executionTime = Date.now() - startTime;
  }
};

const interpretPromptToActions = async (prompt: string, page: Page): Promise<BrowserAction[]> => {
  // Simple prompt interpretation - in a real system, you might use AI to parse this
  const actions: BrowserAction[] = [];
  const lowerPrompt = prompt.toLowerCase();

  // Google search example
  if (lowerPrompt.includes('google') && lowerPrompt.includes('search')) {
    const searchTerm = extractSearchTerm(prompt);
    
    actions.push({
      type: 'navigate',
      url: 'https://www.google.com',
      description: 'Navigate to Google'
    });
    
    actions.push({
      type: 'wait',
      timeout: 2000,
      description: 'Wait for Google to load'
    });
    
    actions.push({
      type: 'type',
      selector: 'textarea[name="q"], input[name="q"]',
      value: searchTerm,
      description: `Search for "${searchTerm}"`
    });
    
    actions.push({
      type: 'click',
      selector: 'input[name="btnK"], button[type="submit"]',
      description: 'Click search button'
    });
    
    actions.push({
      type: 'wait',
      timeout: 3000,
      description: 'Wait for search results'
    });
    
    if (lowerPrompt.includes('screenshot')) {
      actions.push({
        type: 'screenshot',
        description: 'Take screenshot of search results',
        saveAs: 'search-results'
      });
    }
  }

  // Login example
  else if (lowerPrompt.includes('login') || lowerPrompt.includes('sign in')) {
    // Would need credentials provided separately
    actions.push({
      type: 'screenshot',
      description: 'Take screenshot of login page',
      saveAs: 'login-page'
    });
  }

  // Form filling example
  else if (lowerPrompt.includes('fill') && lowerPrompt.includes('form')) {
    actions.push({
      type: 'screenshot',
      description: 'Take screenshot of form',
      saveAs: 'form-page'
    });
  }

  // Click on something
  else if (lowerPrompt.includes('click')) {
    const clickTarget = extractClickTarget(prompt);
    actions.push({
      type: 'click',
      selector: clickTarget.selector,
      description: `Click on ${clickTarget.description}`
    });
    
    actions.push({
      type: 'screenshot',
      description: 'Take screenshot after click',
      saveAs: 'after-click'
    });
  }

  // Generic screenshot
  else if (lowerPrompt.includes('screenshot')) {
    actions.push({
      type: 'screenshot',
      description: 'Take screenshot of current page',
      saveAs: 'page-screenshot'
    });
  }

  return actions;
};

const extractSearchTerm = (prompt: string): string => {
  // Extract text between quotes or after "search"
  const quoteMatch = prompt.match(/"([^"]+)"/);
  if (quoteMatch) return quoteMatch[1];
  
  const searchMatch = prompt.match(/search\s+(?:for\s+)?["']?([^"'\n]+)["']?/i);
  if (searchMatch) return searchMatch[1].trim();
  
  return 'test search'; // fallback
};

const extractClickTarget = (prompt: string): {selector: string, description: string} => {
  // Simple extraction - in a real system, this would be more sophisticated
  if (prompt.includes('button')) {
    return { selector: 'button', description: 'button' };
  }
  if (prompt.includes('link')) {
    return { selector: 'a', description: 'link' };
  }
  return { selector: '*[role="button"], button, a', description: 'clickable element' };
};

const executeAction = async (
  page: Page, 
  action: BrowserAction, 
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>,
  extractedData: Record<string, any>
): Promise<void> => {
  console.log(`Executing action: ${action.type} - ${action.description}`);

  switch (action.type) {
    case 'navigate':
      if (!action.url) throw new Error('URL required for navigate action');
      await page.goto(action.url, { waitUntil: 'networkidle', timeout: action.timeout || 30000 });
      break;

    case 'click':
      if (!action.selector) throw new Error('Selector required for click action');
      await page.click(action.selector, { timeout: action.timeout || 10000 });
      break;

    case 'type':
      if (!action.selector || !action.value) throw new Error('Selector and value required for type action');
      await page.fill(action.selector, action.value, { timeout: action.timeout || 10000 });
      break;

    case 'wait':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
      } else {
        await page.waitForTimeout(action.timeout || 1000);
      }
      break;

    case 'scroll':
      if (action.selector) {
        await page.locator(action.selector).scrollIntoViewIfNeeded();
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
      break;

    case 'select':
      if (!action.selector || !action.value) throw new Error('Selector and value required for select action');
      await page.selectOption(action.selector, action.value);
      break;

    case 'screenshot':
      const screenshot = await page.screenshot({ 
        fullPage: true, 
        type: 'png',
      });
      const screenshotName = action.saveAs || `screenshot-${Date.now()}`;
      const s3Url = await saveScreenshotToS3(screenshot, screenshotName, action.description);
      screenshots.push({
        name: screenshotName,
        s3Url,
        description: action.description,
        timestamp: new Date().toISOString(),
      });
      break;

    case 'extract_text':
      if (!action.selector) throw new Error('Selector required for extract_text action');
      const text = await page.locator(action.selector).textContent();
      const dataKey = action.saveAs || 'extracted_text';
      extractedData[dataKey] = text;
      break;

    case 'check_element':
      if (!action.selector) throw new Error('Selector required for check_element action');
      const elementExists = await page.locator(action.selector).count() > 0;
      const checkKey = action.saveAs || 'element_check';
      extractedData[checkKey] = elementExists;
      break;

    case 'custom_js':
      if (!action.script) throw new Error('Script required for custom_js action');
      const jsResult = await page.evaluate(action.script);
      const jsKey = action.saveAs || 'js_result';
      extractedData[jsKey] = jsResult;
      break;

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  // Wait a bit after each action for stability
  await page.waitForTimeout(500);
};

const saveScreenshotToS3 = async (screenshot: Buffer, name: string, description: string): Promise<string> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}-${timestamp}.png`;
    const key = `${process.env.JOB_ID || 'unknown'}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.RESULTS_BUCKET!,
      Key: key,
      Body: screenshot,
      ContentType: 'image/png',
      Metadata: {
        screenshotName: name,
        description: description.substring(0, 1000),
        timestamp,
        jobId: process.env.JOB_ID || 'unknown',
      },
    }));

    const s3Url = `s3://${process.env.RESULTS_BUCKET}/${key}`;
    console.log(`Screenshot saved: ${s3Url}`);
    return s3Url;

  } catch (error: any) {
    console.error('Error saving screenshot:', error);
    throw error;
  }
};


// Enhanced diagnostic version for React form analysis
const performLogin = async (page: Page, credentials: any): Promise<void> => {
  try {
    console.log('=== STARTING ENHANCED LOGIN DIAGNOSTIC ===');

    if (credentials.loginUrl) {
      await page.goto(credentials.loginUrl);
    }

    // Wait for page to be fully loaded and React to initialize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000); // Give React extra time

    console.log('=== ANALYZING PAGE STRUCTURE ===');
    
    // First, let's analyze ALL form elements on the page
    const pageAnalysis = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      const allInputs = document.querySelectorAll('input');
      const buttons = document.querySelectorAll('button');
      
      const formData = Array.from(forms).map((form, index) => ({
        index,
        innerHTML: form.innerHTML.substring(0, 500), // First 500 chars
        inputs: Array.from(form.querySelectorAll('input')).map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          className: input.className,
          placeholder: input.placeholder,
          value: input.value,
          ariaLabel: input.getAttribute('aria-label'),
          disabled: input.disabled,
          readonly: input.readOnly,
          required: input.required,
        }))
      }));

      const allInputData = Array.from(allInputs).map((input, index) => ({
        index,
        type: input.type,
        name: input.name,
        id: input.id,
        className: input.className,
        placeholder: input.placeholder,
        value: input.value,
        ariaLabel: input.getAttribute('aria-label'),
        disabled: input.disabled,
        readonly: input.readOnly,
        required: input.required,
        visible: input.offsetParent !== null,
        tagName: input.tagName,
        outerHTML: input.outerHTML.substring(0, 300)
      }));

      const buttonData = Array.from(buttons).map((button, index) => ({
        index,
        type: button.type,
        textContent: button.textContent?.trim(),
        className: button.className,
        id: button.id,
        disabled: button.disabled,
        visible: button.offsetParent !== null,
        outerHTML: button.outerHTML.substring(0, 300)
      }));

      return {
        url: window.location.href,
        title: document.title,
        forms: formData,
        allInputs: allInputData,
        buttons: buttonData,
        totalForms: forms.length,
        totalInputs: allInputs.length,
        totalButtons: buttons.length
      };
    });

    console.log('=== PAGE ANALYSIS RESULTS ===');
    console.log(`URL: ${pageAnalysis.url}`);
    console.log(`Title: ${pageAnalysis.title}`);
    console.log(`Forms found: ${pageAnalysis.totalForms}`);
    console.log(`Total inputs: ${pageAnalysis.totalInputs}`);
    console.log(`Total buttons: ${pageAnalysis.totalButtons}`);

    console.log('\n=== ALL INPUTS ANALYSIS ===');
    pageAnalysis.allInputs.forEach((input, index) => {
      console.log(`Input ${index}:`);
      console.log(`  Type: ${input.type}`);
      console.log(`  Name: ${input.name}`);
      console.log(`  ID: ${input.id}`);
      console.log(`  Placeholder: ${input.placeholder}`);
      console.log(`  Value: ${input.value}`);
      console.log(`  Visible: ${input.visible}`);
      console.log(`  Disabled: ${input.disabled}`);
      console.log(`  Class: ${input.className.substring(0, 50)}...`);
      console.log(`  HTML: ${input.outerHTML}`);
      console.log('---');
    });

    console.log('\n=== BUTTON ANALYSIS ===');
    pageAnalysis.buttons.forEach((button, index) => {
      console.log(`Button ${index}:`);
      console.log(`  Type: ${button.type}`);
      console.log(`  Text: ${button.textContent}`);
      console.log(`  ID: ${button.id}`);
      console.log(`  Visible: ${button.visible}`);
      console.log(`  Disabled: ${button.disabled}`);
      console.log(`  HTML: ${button.outerHTML}`);
      console.log('---');
    });

    // Now let's test our selectors systematically
    console.log('\n=== TESTING USERNAME SELECTORS ===');

    const usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]', 
      'input[type="email"]',
      'input[id*="username"]',
      'input[id*="email"]',
      '#username',
      '#email',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
      'input[aria-label*="email" i]',
      'input[aria-label*="username" i]',
      'form input[type="text"]:first-of-type',
      'form input:not([type="password"]):not([type="hidden"]):not([type="submit"]):first-of-type',
    ];

    let usernameField : any = null;
    let workingUsernameSelector = '';

    for (const selector of usernameSelectors) {
      try {
        console.log(`Testing selector: ${selector}`);
        const elements = await page.locator(selector).all();
        console.log(`  Found ${elements.length} elements`);
        
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          console.log(`  Element ${i}: visible=${isVisible}, enabled=${isEnabled}`);
          
          if (isVisible && isEnabled) {
            // Get element details
            const elementInfo = await element.evaluate((el: any) => ({
              tagName: el.tagName,
              type: el.type,
              name: el.name,
              id: el.id,
              placeholder: el.placeholder,
              value: el.value,
              className: el.className,
            }));
            console.log(`  ✓ VIABLE ELEMENT:`, elementInfo);
            
            if (!usernameField) {
              usernameField = element;
              workingUsernameSelector = selector;
              console.log(`  ✓ SELECTED as username field`);
            }
          }
        }
      } catch (error: any) {
        console.log(`  ✗ Selector failed: ${error.message}`);
      }
    }

    if (!usernameField) {
      throw new Error('No username field found with any selector');
    }

    console.log(`\n=== USING USERNAME SELECTOR: ${workingUsernameSelector} ===`);

    // Now let's try different methods to fill the username
    console.log('=== TESTING USERNAME FILL METHODS ===');

    // Method 1: Standard fill
    try {
      console.log('Method 1: Standard fill...');
      await usernameField.click({ timeout: 5000 });
      await usernameField.clear();
      await usernameField.fill(credentials.username);
      
      const newValue = await usernameField.inputValue();
      console.log(`✓ Standard fill result: "${newValue}"`);
      
      if (newValue === credentials.username) {
        console.log('✓ Standard fill successful!');
      } else {
        throw new Error(`Fill failed - expected "${credentials.username}", got "${newValue}"`);
      }
    } catch (error: any) {
      console.log(`✗ Standard fill failed: ${error.message}`);
      
      // Method 2: Keyboard input
      try {
        console.log('Method 2: Keyboard input...');
        await usernameField.click();
        await page.keyboard.press('Control+a');
        await page.keyboard.type(credentials.username);
        
        const newValue = await usernameField.inputValue();
        console.log(`Keyboard input result: "${newValue}"`);
        
        if (newValue !== credentials.username) {
          throw new Error(`Keyboard input failed - expected "${credentials.username}", got "${newValue}"`);
        }
        console.log('✓ Keyboard input successful!');
      } catch (keyboardError: any) {
        console.log(`✗ Keyboard input failed: ${keyboardError.message}`);
        
        // Method 3: JavaScript setValue
        try {
          console.log('Method 3: JavaScript setValue...');
          await usernameField.evaluate((el, value) => {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, credentials.username);
          
          const newValue = await usernameField.inputValue();
          console.log(`JavaScript setValue result: "${newValue}"`);
          
          if (newValue !== credentials.username) {
            throw new Error(`JavaScript setValue failed - expected "${credentials.username}", got "${newValue}"`);
          }
          console.log('✓ JavaScript setValue successful!');
        } catch (jsError: any) {
          console.log(`✗ JavaScript setValue failed: ${jsError.message}`);
          throw new Error('All username fill methods failed');
        }
      }
    }

    // Now test password field
    console.log('\n=== TESTING PASSWORD SELECTORS ===');

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id*="password"]',
      '#password',
      'input[placeholder*="password" i]',
      'input[aria-label*="password" i]',
    ];

    let passwordField : any = null;
    let workingPasswordSelector = '';

    for (const selector of passwordSelectors) {
      try {
        console.log(`Testing password selector: ${selector}`);
        const elements = await page.locator(selector).all();
        console.log(`  Found ${elements.length} elements`);
        
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          console.log(`  Element ${i}: visible=${isVisible}, enabled=${isEnabled}`);
          
          if (isVisible && isEnabled) {
            const elementInfo = await element.evaluate((el: any) => ({
              tagName: el.tagName,
              type: el.type,
              name: el.name,
              id: el.id,
              placeholder: el.placeholder,
              value: el.value ? '[HIDDEN]' : '',
            }));
            console.log(`  ✓ VIABLE ELEMENT:`, elementInfo);
            
            if (!passwordField) {
              passwordField = element;
              workingPasswordSelector = selector;
              console.log(`  ✓ SELECTED as password field`);
            }
          }
        }
      } catch (error: any) {
        console.log(`  ✗ Password selector failed: ${error.message}`);
      }
    }

    if (!passwordField) {
      throw new Error('No password field found');
    }

    console.log(`\n=== USING PASSWORD SELECTOR: ${workingPasswordSelector} ===`);

    // Fill password using the method that worked for username
    console.log('=== FILLING PASSWORD ===');
    try {
      await passwordField.click({ timeout: 5000 });
      await passwordField.clear();
      await passwordField.fill(credentials.password);
      console.log('✓ Password filled successfully');
    } catch (error) {
      console.log('Password fill failed, trying keyboard input...');
      await passwordField.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type(credentials.password);
      console.log('✓ Password filled with keyboard');
    }

    // Find submit button
    console.log('\n=== TESTING SUBMIT SELECTORS ===');

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Sign In")',
      'button:has-text("Login")',
      'button:has-text("Log in")',
      'form button:not([type="button"])',
      'form button:last-of-type',
    ];

    let submitButton: any = null;
    let workingSubmitSelector = '';

    for (const selector of submitSelectors) {
      try {
        console.log(`Testing submit selector: ${selector}`);
        const elements = await page.locator(selector).all();
        console.log(`  Found ${elements.length} elements`);
        
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i];
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          console.log(`  Element ${i}: visible=${isVisible}, enabled=${isEnabled}`);
          
          if (isVisible && isEnabled) {
            const elementInfo = await element.evaluate((el: any) => ({
              tagName: el.tagName,
              type: el.type,
              textContent: el.textContent?.trim(),
              id: el.id,
              className: el.className,
            }));
            console.log(`  ✓ VIABLE ELEMENT:`, elementInfo);
            
            if (!submitButton) {
              submitButton = element;
              workingSubmitSelector = selector;
              console.log(`  ✓ SELECTED as submit button`);
            }
          }
        }
      } catch (error: any) {
        console.log(`  ✗ Submit selector failed: ${error.message}`);
      }
    }

    if (!submitButton) {
      console.log('No submit button found, trying form submission...');
      await page.keyboard.press('Enter');
      console.log('✓ Submitted with Enter key');
    } else {
      console.log(`\n=== USING SUBMIT SELECTOR: ${workingSubmitSelector} ===`);
      await submitButton.click();
      console.log('✓ Submit button clicked');
    }

    // Wait for login to complete
    console.log('\n=== WAITING FOR LOGIN COMPLETION ===');
    await page.waitForTimeout(5000);
    
    const finalUrl = page.url();
    console.log(`Final URL: ${finalUrl}`);
    
    // Check if we're still on login page
    if (finalUrl.includes('/auth/login') || finalUrl.includes('login')) {
      console.log('⚠️  Still on login page - login may have failed');
      
      // Check for error messages
      const errorMessages = await page.evaluate(() => {
        const errorElements = document.querySelectorAll('[role="alert"], .error, .alert-danger, .text-red-500, .text-destructive');
        return Array.from(errorElements).map(el => el.textContent?.trim()).filter(Boolean);
      });
      
      if (errorMessages.length > 0) {
        console.log('Error messages found:', errorMessages);
      }
    } else {
      console.log('✓ Login appears successful - URL changed');
    }

    console.log('=== LOGIN DIAGNOSTIC COMPLETE ===');

  } catch (error: any) {
    console.error('=== LOGIN DIAGNOSTIC FAILED ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    throw error;
  }
};

// Flexible Browser Agent
const flexibleBrowserAgent = new Agent({
  name: 'Flexible Browser Agent',
  instructions: `
    You are a flexible browser automation assistant that can perform a wide variety of web tasks based on natural language instructions.
    
    ## Capabilities:
    - **Navigation**: Visit any website
    - **Search**: Perform searches on Google, Bing, or site-specific search
    - **Form Interaction**: Fill forms, submit data, select options
    - **Authentication**: Login to websites when credentials are provided
    - **Screenshots**: Capture screenshots of pages, elements, or results
    - **Data Extraction**: Extract text, check for elements, get page information
    - **Custom Actions**: Perform specific clicks, scrolling, waiting
    
    ## Approach:
    1. **Understand the Request**: Parse what the user wants to accomplish
    2. **Plan Actions**: Break down the task into browser actions
    3. **Execute Safely**: Perform actions with appropriate waits and error handling
    4. **Capture Results**: Take screenshots and extract data as requested
    5. **Report Back**: Provide clear results and any issues encountered
    
    ## Common Tasks:
    
    ### Search Tasks
    - "Search Google for X and screenshot the results"
    - "Go to YouTube and search for tutorials on Y"
    - "Search Amazon for product Z and get the price"
    
    ### Navigation Tasks  
    - "Go to website.com and take a screenshot"
    - "Navigate through the menu to find the contact page"
    - "Check if the login page loads correctly"
    
    ### Form Tasks
    - "Fill out the contact form with test data"
    - "Subscribe to the newsletter with test@example.com"
    - "Add an item to the shopping cart"
    
    ### Authentication Tasks
    - "Login to the dashboard and screenshot the home page"
    - "Sign into the account and check user profile"
    
    ### Data Extraction Tasks
    - "Get the page title and main heading text"
    - "Check if the shopping cart icon shows item count"
    - "Extract the list of product names from the catalog"
    
    ## Response Format:
    Provide clear, actionable results including:
    - What actions were performed successfully
    - Any issues encountered
    - Screenshots taken
    - Data extracted
    - Suggestions for follow-up actions
    
    ## Key Principles:
    - **User-Friendly**: Interpret natural language instructions flexibly
    - **Safe**: Always use test data, avoid harmful actions
    - **Thorough**: Take screenshots and extract data as requested
    - **Informative**: Explain what happened and why
    - **Adaptable**: Handle different website structures gracefully
    
    Remember: You can handle both structured action requests and natural language instructions. Be creative in interpreting what the user wants to accomplish!
  `,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { flexibleBrowserTool },
  memory: new Memory({
    storage: new DynamoDBStore({
      name: "dynamodb",
      config: {
        tableName: process.env.MASTRA_TABLE_NAME!,
        region: process.env.REGION!
      }
    }),
    options: {
      lastMessages: 10,
    },
  }),
});

// Main Lambda handler
export const handler = async (event: any): Promise<any> => {
  console.log('Flexible Browser Agent invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    if (!event.input) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required field: input',
          usage: 'Provide either a natural language prompt or structured actions',
          examples: [
            'Navigate to google.com, search "QA" and save a screenshot of the results',
            'Go to example.com and take a screenshot of the homepage',
            'Login to app.com with test credentials and screenshot the dashboard'
          ]
        }),
      };
    }

    const threadId: string = event.thread_id || crypto.randomUUID();
    const jobId: string = event.jobId;
    const startTime = Date.now();

    // Set job ID in environment for screenshot naming
    process.env.JOB_ID = jobId;

    console.log(`Processing flexible browser automation with thread ID: ${threadId}, job ID: ${jobId}`);

    const result = await flexibleBrowserAgent.generate(event.input, {
      threadId,
      resourceId: "flexible-browser-automation",
    });

    const processingTime = Date.now() - startTime;
    console.log(`Flexible browser automation completed in ${processingTime}ms`);

    const response = {
      thread_id: threadId,
      job_id: jobId,
      processingTime,
      automationType: 'flexible-browser',
      features: ['navigation', 'screenshots', 'form-interaction', 'data-extraction', 'authentication'],
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        memoryUsage: process.memoryUsage(),
        region: process.env.AWS_REGION,
      },
      ...result,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };

  } catch (error: any) {
    console.error('Flexible browser automation error:', error);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        automationType: 'flexible-browser',
        type: error.constructor?.name || 'Error',
        timestamp: new Date().toISOString(),
        job_id: event.jobId,
      }),
    };
  }
};