// src/handlers/containers/qa/index.ts - Generic Browser Automation Toolkit
import { chromium, Page, Browser, BrowserContext, Locator } from 'playwright-core';
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

// Browser Context Manager (keeping the good parts from before)
class BrowserContextManager {
  private static instance: BrowserContextManager;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastActivity: number = Date.now();
  private readonly TIMEOUT_MS = 300000; // 5 minutes

  static getInstance(): BrowserContextManager {
    if (!BrowserContextManager.instance) {
      BrowserContextManager.instance = new BrowserContextManager();
    }
    return BrowserContextManager.instance;
  }

  async getPage(): Promise<Page> {
    if (this.page && (Date.now() - this.lastActivity > this.TIMEOUT_MS)) {
      console.log('Browser context stale, recreating...');
      await this.cleanup();
    }

    if (!this.browser || !this.context || !this.page) {
      await this.initializeBrowser();
    }

    this.lastActivity = Date.now();
    return this.page!;
  }

  private async initializeBrowser(): Promise<void> {
    console.log('Initializing browser context...');
    
    this.browser = await chromium.launch({
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
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 1024 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    this.page = await this.context.newPage();
    
    this.page.on('pageerror', (error) => {
      console.error('Page error:', error);
    });
  }

  async cleanup(): Promise<void> {
    console.log('Cleaning up browser context...');
    try {
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  updateActivity(): void {
    this.lastActivity = Date.now();
  }
}

// Generic Navigation Tool
const navigateTool = createTool({
  id: 'navigate',
  description: 'Navigate to a URL and wait for the page to load',
  inputSchema: z.object({
    url: z.string().describe('URL to navigate to'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('networkidle').describe('When to consider navigation complete'),
    timeout: z.number().default(30000).describe('Navigation timeout in milliseconds'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    url: z.string(),
    title: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log(`Navigating to: ${context.url}`);
      await page.goto(context.url, { 
        waitUntil: context.waitUntil as any, 
        timeout: context.timeout 
      });
      
      const title = await page.title();
      const url = page.url();
      
      browserManager.updateActivity();
      console.log(`Navigation complete: ${title} (${url})`);
      
      return {
        success: true,
        url,
        title,
      };
    } catch (error: any) {
      console.error('Navigation failed:', error);
      return {
        success: false,
        url: context.url,
        title: '',
        error: error.message,
      };
    }
  },
});

// Generic Element Finding Tool
const findElementsTool = createTool({
  id: 'find-elements',
  description: 'Find elements on the page using CSS selectors or text content',
  inputSchema: z.object({
    selector: z.string().describe('CSS selector to find elements'),
    waitFor: z.boolean().default(false).describe('Whether to wait for elements to appear'),
    timeout: z.number().default(5000).describe('Timeout for waiting'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {

      console.log(`FIND ELEMENTS CALLED WITH:`, JSON.stringify(context));
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log(`Finding elements: ${context.selector}`);
      
      if (context.waitFor) {
        try {
          await page.waitForSelector(context.selector, { timeout: context.timeout });
        } catch (e) {
          console.log(`Wait timeout for selector: ${context.selector}`);
        }
      }
      
      const elements = await page.locator(context.selector).all();
      console.log(`Found ${elements.length} elements matching: ${context.selector}`);
      browserManager.updateActivity();
      
      return {
        success: true,
        count: elements.length,
      };
    } catch (error: any) {
      console.error('Find elements failed:', error);
      return {
        success: false,
        count: 0,
        elements: [],
        error: error.message,
      };
    }
  },
});

// Generic Click Tool
const clickTool = createTool({
  id: 'click',
  description: 'Click on an element using CSS selector',
  inputSchema: z.object({
    selector: z.string().describe('CSS selector for element to click'),
    elementIndex: z.number().default(0).describe('Index of element if multiple match (0 = first)'),
    waitForElement: z.boolean().default(true).describe('Wait for element to be visible before clicking'),
    timeout: z.number().default(5000).describe('Timeout for waiting'),
    force: z.boolean().default(false).describe('Force click even if element is not ready'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    elementFound: z.boolean(),
    clicked: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log(`Clicking: ${context.selector} (index: ${context.elementIndex})`);
      
      if (context.waitForElement) {
        try {
          await page.waitForSelector(context.selector, { timeout: context.timeout });
        } catch (e) {
          console.log(`Element not found within timeout: ${context.selector}`);
          return {
            success: false,
            elementFound: false,
            clicked: false,
            error: `Element not found: ${context.selector}`,
          };
        }
      }
      
      const element = page.locator(context.selector).nth(context.elementIndex);
      
      if (!(await element.count())) {
        return {
          success: false,
          elementFound: false,
          clicked: false,
          error: `No element found at index ${context.elementIndex}`,
        };
      }
      
      await element.click({ force: context.force });
      
      browserManager.updateActivity();
      console.log(`Successfully clicked: ${context.selector}`);
      
      return {
        success: true,
        elementFound: true,
        clicked: true,
      };
    } catch (error: any) {
      console.error('Click failed:', error);
      return {
        success: false,
        elementFound: true,
        clicked: false,
        error: error.message,
      };
    }
  },
});

// Generic Type Tool
const typeTool = createTool({
  id: 'type',
  description: 'Type text into an input field',
  inputSchema: z.object({
    selector: z.string().describe('CSS selector for input element'),
    text: z.string().describe('Text to type'),
    elementIndex: z.number().default(0).describe('Index of element if multiple match'),
    clear: z.boolean().default(true).describe('Clear field before typing'),
    pressEnter: z.boolean().default(false).describe('Press Enter after typing'),
    delay: z.number().default(0).describe('Delay between keystrokes in milliseconds'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    elementFound: z.boolean(),
    typed: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log(`Typing into: ${context.selector} (text: "${context.text.substring(0, 50)}...")`);
      
      const element = page.locator(context.selector).nth(context.elementIndex);
      
      if (!(await element.count())) {
        return {
          success: false,
          elementFound: false,
          typed: false,
          error: `Element not found: ${context.selector}`,
        };
      }
      
      await element.waitFor({ state: 'visible', timeout: 5000 });
      
      if (context.clear) {
        await element.clear();
      }
      
      if (context.delay > 0) {
        await element.type(context.text, { delay: context.delay });
      } else {
        await element.fill(context.text);
      }
      
      if (context.pressEnter) {
        await element.press('Enter');
      }
      
      browserManager.updateActivity();
      console.log(`Successfully typed into: ${context.selector}`);
      
      return {
        success: true,
        elementFound: true,
        typed: true,
      };
    } catch (error: any) {
      console.error('Type failed:', error);
      return {
        success: false,
        elementFound: false,
        typed: false,
        error: error.message,
      };
    }
  },
});

// Generic Wait Tool
const waitTool = createTool({
  id: 'wait',
  description: 'Wait for various conditions or simply pause execution',
  inputSchema: z.object({
    type: z.enum(['timeout', 'selector', 'navigation', 'function']).describe('Type of wait condition'),
    value: z.union([z.string(), z.number()]).describe('Wait value (milliseconds for timeout, selector for element, or JS function string)'),
    timeout: z.number().default(10000).describe('Maximum time to wait in milliseconds'),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible').describe('State to wait for when waiting for selector'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    waited: z.number(),
    condition: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      const startTime = Date.now();
      
      console.log(`Waiting for: ${context.type} = ${context.value}`);
      
      switch (context.type) {
        case 'timeout':
          const ms = typeof context.value === 'number' ? context.value : parseInt(context.value as string);
          await page.waitForTimeout(ms);
          break;
          
        case 'selector':
          await page.waitForSelector(context.value as string, { 
            state: context.state as any,
            timeout: context.timeout 
          });
          break;
          
        case 'navigation':
          await page.waitForLoadState('networkidle', { timeout: context.timeout });
          break;
          
        case 'function':
          await page.waitForFunction(context.value as string, {}, { timeout: context.timeout });
          break;
          
        default:
          throw new Error(`Unknown wait type: ${context.type}`);
      }
      
      const waited = Date.now() - startTime;
      browserManager.updateActivity();
      console.log(`Wait completed in ${waited}ms`);
      
      return {
        success: true,
        waited,
        condition: `${context.type}: ${context.value}`,
      };
    } catch (error: any) {
      console.error('Wait failed:', error);
      const waited = Date.now() - Date.now();
      return {
        success: false,
        waited,
        condition: `${context.type}: ${context.value}`,
        error: error.message,
      };
    }
  },
});

// Generic Screenshot Tool
const screenshotTool = createTool({
  id: 'screenshot',
  description: 'Take a screenshot of the current page',
  inputSchema: z.object({
    filename: z.string().describe('Name for the screenshot file'),
    description: z.string().describe('Description of what the screenshot shows'),
    fullPage: z.boolean().default(true).describe('Capture full page or just viewport'),
    element: z.string().optional().describe('CSS selector to screenshot specific element'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filename: z.string(),
    s3Url: z.string(),
    description: z.string(),
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
        screenshot = await element.screenshot({ type: 'png' });
      } else {
        screenshot = await page.screenshot({ 
          fullPage: context.fullPage, 
          type: 'png' 
        });
      }
      
      const s3Url = await saveScreenshotToS3(screenshot, context.filename, context.description);
      
      browserManager.updateActivity();
      console.log(`Screenshot saved: ${s3Url}`);
      
      return {
        success: true,
        filename: context.filename,
        s3Url,
        description: context.description,
      };
    } catch (error: any) {
      console.error('Screenshot failed:', error);
      return {
        success: false,
        filename: context.filename,
        s3Url: '',
        description: context.description,
        error: error.message,
      };
    }
  },
});

// Page Analysis Tool
const analyzePageTool = createTool({
  id: 'analyze-page',
  description: 'Analyze the current page structure and content',
  inputSchema: z.object({
    includeText: z.boolean().default(false).describe('Include text content analysis'),
    includeStructure: z.boolean().default(false).describe('Include HTML structure analysis'),
    maxTextLength: z.number().default(1000).describe('Maximum length of text content to return'),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    textContent: z.string().optional(),
    forms: z.array(z.object({
      action: z.string(),
      method: z.string(),
      inputs: z.array(z.object({
        type: z.string(),
        name: z.string(),
        placeholder: z.string(),
      })),
    })),
    buttons: z.array(z.object({
      text: z.string(),
      type: z.string(),
      disabled: z.boolean(),
    })),
    links: z.array(z.object({
      text: z.string(),
      href: z.string(),
    })),
    images: z.array(z.object({
      src: z.string(),
      alt: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      console.log(`ANALYZE PAGE CALLED WITH:`, JSON.stringify(context));
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log('Analyzing page structure...');
      
      const analysis = await page.evaluate((options) => {
        const result: any = {
          url: window.location.href,
          title: document.title,
          forms: [],
          buttons: [],
          links: [],
          images: [],
        };
        
        if (options.includeText) {
          result.textContent = document.body.innerText.substring(0, options.maxTextLength);
        }
        
        return result;
      }, {
        includeText: context.includeText,
        includeStructure: context.includeStructure,
        maxTextLength: context.maxTextLength,
      });
      
      browserManager.updateActivity();
      console.log('Page analysis completed');
      
      return analysis;
    } catch (error: any) {
      console.error('Page analysis failed:', error);
      return {
        url: '',
        title: '',
        forms: [],
        buttons: [],
        links: [],
        images: [],
        error: error.message,
      };
    }
  },
});

const executeJSTool = createTool({
  id: 'execute-js',
  description: 'Execute custom JavaScript code in the page context',
  inputSchema: z.object({
    script: z.string().describe('JavaScript code to execute'),
    args: z.array(z.any()).default([]).describe('Arguments to pass to the script'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    result: z.any(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      console.log(`Executing JavaScript: ${context.script.substring(0, 100)}...`);
      
      // Create a function wrapper that can be serialized by Playwright
      const result = await page.evaluate(
        ({ script, args }) => {
          // Create and execute the function in the browser context
          const func = new Function('...args', script);
          return func(...args);
        },
        { script: context.script, args: context.args }
      );
      
      browserManager.updateActivity();
      console.log('JavaScript execution completed');
      
      return {
        success: true,
        result,
      };
    } catch (error: any) {
      console.error('JavaScript execution failed:', error);
      return {
        success: false,
        result: null,
        error: error.message,
      };
    }
  },
});

// Utility function to save screenshots
const saveScreenshotToS3 = async (screenshot: Buffer, name: string, description: string): Promise<string> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}-${timestamp}.png`;
    const key = `qa/${process.env.JOB_ID || 'unknown'}/${filename}`;

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
    return s3Url;
  } catch (error: any) {
    console.error('Error saving screenshot:', error);
    throw error;
  }
};

const enhancedInstructions = `
Browser automation agent. Complete ALL steps of multi-step tasks.

CRITICAL EFFICIENCY RULES:
- NEVER set getInfo:true unless debugging failures
- Use ONLY standard CSS selectors (no jQuery syntax)

VALID CSS SELECTORS:
✅ input[type="email"]
✅ button[type="submit"] 
✅ .class-name
✅ #element-id
✅ [aria-label="Login"]
✅ [placeholder*="email"]

INVALID SELECTORS (DO NOT USE):
❌ :contains() - jQuery only
❌ :visible - jQuery only  
❌ :first - jQuery only
❌ :eq() - jQuery only

For text content, use:
✅ button (then check text content)
✅ [aria-label*="text"]
✅ [title*="text"]

Tools: navigate, findElements, click, type, wait, screenshot, analyzePage, executeJS

For efficiency: Use getInfo:false, includeText:false, and includeStructure:false unless debugging. Use minimal analyzePage unless needed.

Approach:
1. Plan workflow 
2. Execute step by step
3. Don't stop until complete
`;

// Generic Browser Agent
const genericBrowserAgent = new Agent({
  name: 'Generic Browser Automation Agent',
  instructions: enhancedInstructions,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { 
    navigate: navigateTool,
    findElements: findElementsTool,
    click: clickTool,
    type: typeTool,
    wait: waitTool,
    screenshot: screenshotTool,
    analyzePage: analyzePageTool,
    executeJS: executeJSTool,
  },
  memory: new Memory({
    storage: new DynamoDBStore({
      name: "dynamodb",
      config: {
        tableName: process.env.MASTRA_TABLE_NAME!,
        region: process.env.REGION!
      }
    }),
    options: {
      lastMessages: 10, // Increased for more context
    },
  }),
});

// Main Lambda handler
export const handler = async (event: any): Promise<any> => {
  console.log('Generic Browser Agent invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const browserManager = BrowserContextManager.getInstance();
  
  try {
    if (!event.input) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required field: input',
          usage: 'Provide a natural language prompt for browser automation',
          examples: [
            'Go to the login page, log in with the credentials, then search for "jim johnson" and find his phone number',
            'Navigate to example.com and take a screenshot',
            'Find all the input fields on the current page and tell me what they are for'
          ]
        }),
      };
    }

    const threadId: string = event.thread_id || crypto.randomUUID();
    const jobId: string = event.jobId;
    const startTime = Date.now();

    // Set job ID in environment for screenshot naming
    process.env.JOB_ID = jobId;

    console.log(`Processing generic browser automation with thread ID: ${threadId}, job ID: ${jobId}`);

    const result = await genericBrowserAgent.generate(event.input, {
      threadId,
      resourceId: "generic-browser-automation",
      maxSteps: 28,
      maxRetries: 0,
      maxTokens: 8000
    });

    const processingTime = Date.now() - startTime;
    console.log(`Generic browser automation completed in ${processingTime}ms`);

    const response = {
      thread_id: threadId,
      job_id: jobId,
      processingTime,
      automationType: 'generic-browser',
      features: ['navigation', 'element-finding', 'clicking', 'typing', 'waiting', 'screenshots', 'page-analysis', 'javascript-execution'],
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
    console.error('Generic browser automation error:', error);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        automationType: 'generic-browser',
        type: error.constructor?.name || 'Error',
        timestamp: new Date().toISOString(),
        job_id: event.jobId,
      }),
    };
  } finally {
    // Clean up browser context on completion
    try {
      await browserManager.cleanup();
    } catch (e) {
      console.error('Error during final cleanup:', e);
    }
  }
};