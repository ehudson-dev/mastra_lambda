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

const performLogin = async (page: Page, credentials: any): Promise<void> => {
  if (credentials.loginUrl) {
    await page.goto(credentials.loginUrl);
  }

  // Common username selectors
  const usernameSelectors = [
    credentials.usernameSelector,
    'input[name="username"]',
    'input[name="email"]', 
    'input[type="email"]',
    'input[id*="username"]',
    'input[id*="email"]',
    '#username',
    '#email'
  ].filter(Boolean);

  // Common password selectors
  const passwordSelectors = [
    credentials.passwordSelector,
    'input[type="password"]',
    'input[name="password"]',
    'input[id*="password"]',
    '#password'
  ].filter(Boolean);

  // Find and fill username
  for (const selector of usernameSelectors) {
    try {
      await page.fill(selector as string, credentials.username, { timeout: 2000 });
      break;
    } catch (e) {
      continue;
    }
  }

  // Find and fill password
  for (const selector of passwordSelectors) {
    try {
      await page.fill(selector as string, credentials.password, { timeout: 2000 });
      break;
    } catch (e) {
      continue;
    }
  }

  // Submit form
  const submitSelectors = [
    credentials.submitSelector,
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")'
  ].filter(Boolean);

  for (const selector of submitSelectors) {
    try {
      await page.click(selector as string, { timeout: 2000 });
      break;
    } catch (e) {
      continue;
    }
  }

  await page.waitForTimeout(2000);
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
    - Screenshots taken (with descriptions)
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