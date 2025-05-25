// src/handlers/containers/qa/index.ts - Generic Browser Automation Toolkit
import { chromium, Page, Browser, BrowserContext } from "playwright-core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { DynamoDBStore } from "@mastra/dynamodb";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
    if (this.page && Date.now() - this.lastActivity > this.TIMEOUT_MS) {
      console.log("Browser context stale, recreating...");
      await this.cleanup();
    }

    if (!this.browser || !this.context || !this.page) {
      await this.initializeBrowser();
    }

    this.lastActivity = Date.now();
    return this.page!;
  }

  private async initializeBrowser(): Promise<void> {
    console.log("Initializing browser context...");

    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-extensions",
        "--disable-plugins",
        "--single-process",
        "--no-zygote",
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 1024 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    this.page = await this.context.newPage();

    this.page.on("pageerror", (error) => {
      console.error("Page error:", error);
    });
  }

  async cleanup(): Promise<void> {
    console.log("Cleaning up browser context...");
    try {
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  updateActivity(): void {
    this.lastActivity = Date.now();
  }
}

// Generic Element Finding Tool
const findElementsTool = createTool({
  id: "find-elements",
  description: "Find elements on the page using CSS selectors or text content",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector to find elements"),
    waitFor: z
      .boolean()
      .default(false)
      .describe("Whether to wait for elements to appear"),
    timeout: z.number().default(5000).describe("Timeout for waiting"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    count: z.number(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`Finding elements: ${context.selector}`);

      if (context.waitFor) {
        try {
          await page.waitForSelector(context.selector, {
            timeout: context.timeout,
          });
        } catch (e) {
          console.log(`Wait timeout for selector: ${context.selector}`);
        }
      }

      const elements = await page.locator(context.selector).all();
      console.log(
        `Found ${elements.length} elements matching: ${context.selector}`
      );
      browserManager.updateActivity();

      return {
        success: true,
        count: elements.length,
      };
    } catch (error: any) {
      console.error("Find elements failed:", error);
      return {
        success: false,
        count: 0,
        elements: [],
        error: error.message,
      };
    }
  },
});

// Generic Wait Tool
const waitTool = createTool({
  id: "wait",
  description: "Wait for 10 seconds",
  outputSchema: z.object({
    success: z.boolean(),
    waited: z.number(),
    error: z.string().optional(),
  }),
  execute: async (): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const startTime = Date.now();

      await new Promise((resolve) => setTimeout(resolve, 10000));

      const waited = Date.now() - startTime;
      browserManager.updateActivity();
      console.log(`Wait completed in ${waited}ms`);

      return {
        success: true,
        waited,
      };
    } catch (error: any) {
      console.error("Wait failed:", error);
      const waited = Date.now() - Date.now();
      return {
        success: false,
        waited,
        error: error.message,
      };
    }
  },
});

// Generic Screenshot Tool
const screenshotTool = createTool({
  id: "screenshot",
  description: "Take a screenshot of the current page",
  inputSchema: z.object({
    filename: z.string().describe("Name for the screenshot file"),
    description: z
      .string()
      .describe("Description of what the screenshot shows"),
    fullPage: z
      .boolean()
      .default(true)
      .describe("Capture full page or just viewport"),
    element: z
      .string()
      .optional()
      .describe("CSS selector to screenshot specific element"),
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
        screenshot = await element.screenshot({ type: "png" });
      } else {
        screenshot = await page.screenshot({
          fullPage: context.fullPage,
          type: "png",
        });
      }

      const s3Url = await saveScreenshotToS3(
        screenshot,
        context.filename,
        context.description
      );

      browserManager.updateActivity();
      console.log(`Screenshot saved: ${s3Url}`);

      return {
        success: true,
        filename: context.filename,
        s3Url,
        description: context.description,
      };
    } catch (error: any) {
      console.error("Screenshot failed:", error);
      return {
        success: false,
        filename: context.filename,
        s3Url: "",
        description: context.description,
        error: error.message,
      };
    }
  },
});

const executeJSTool = createTool({
  id: "execute-js",
  description: "Execute custom JavaScript code in the page context",
  inputSchema: z.object({
    script: z.string().describe("JavaScript code to execute"),
    args: z
      .array(z.any())
      .default([])
      .describe("Arguments to pass to the script"),
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

      console.log(
        `Executing JavaScript: ${context.script.substring(0, 100)}...`
      );

      // Create a function wrapper that can be serialized by Playwright
      const result = await page.evaluate(
        ({ script, args }) => {
          // Create and execute the function in the browser context
          const func = new Function("...args", script);
          return func(...args);
        },
        { script: context.script, args: context.args }
      );

      browserManager.updateActivity();
      console.log("JavaScript execution completed");

      return {
        success: true,
        result,
      };
    } catch (error: any) {
      console.error("JavaScript execution failed:", error);
      return {
        success: false,
        result: null,
        error: error.message,
      };
    }
  },
});

// Utility function to save screenshots
const saveScreenshotToS3 = async (
  screenshot: Buffer,
  name: string,
  description: string
): Promise<string> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${name}-${timestamp}.png`;
    const key = `qa/${process.env.JOB_ID || "unknown"}/${filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.RESULTS_BUCKET!,
        Key: key,
        Body: screenshot,
        ContentType: "image/png",
        Metadata: {
          screenshotName: name,
          description: description.substring(0, 1000),
          timestamp,
          jobId: process.env.JOB_ID || "unknown",
        },
      })
    );

    const s3Url = `s3://${process.env.RESULTS_BUCKET}/${key}`;
    return s3Url;
  } catch (error: any) {
    console.error("Error saving screenshot:", error);
    throw error;
  }
};

// Find and Type Combined Tool
const findAndTypeTool = createTool({
  id: "find-and-type",
  description: "Find an input element and type text into it in one operation",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector for input element"),
    text: z.string().describe("Text to type"),
    elementIndex: z
      .number()
      .default(0)
      .describe("Index if multiple elements match"),
    clear: z.boolean().default(true).describe("Clear field before typing"),
    pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
    waitTimeout: z
      .number()
      .default(5000)
      .describe("How long to wait for element"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    elementsFound: z.number(),
    typed: z.boolean(),
    finalValue: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Find and type: ${context.selector} = "${context.text.substring(0, 50)}..."`
      );

      // Wait for and find elements
      await page.waitForSelector(context.selector, {
        timeout: context.waitTimeout,
      });
      const elements = await page.locator(context.selector).all();

      if (elements.length === 0) {
        return {
          success: false,
          elementsFound: 0,
          typed: false,
          error: `No elements found for selector: ${context.selector}`,
        };
      }

      // Get the target element
      const element = page.locator(context.selector).nth(context.elementIndex);
      await element.waitFor({ state: "visible", timeout: context.waitTimeout });

      // Clear and type
      if (context.clear) {
        await element.clear();
      }

      await element.fill(context.text);

      if (context.pressEnter) {
        await element.press("Enter");
      }

      // Get final value for verification
      const finalValue = await element.inputValue();

      browserManager.updateActivity();
      console.log(
        `✅ Found ${elements.length} elements, typed into element ${context.elementIndex}`
      );

      return {
        success: true,
        elementsFound: elements.length,
        typed: true,
        finalValue,
      };
    } catch (error: any) {
      console.error("Find and type failed:", error);
      return {
        success: false,
        elementsFound: 0,
        typed: false,
        error: error.message,
      };
    }
  },
});

// Find and Click Combined Tool
const findAndClickTool = createTool({
  id: "find-and-click",
  description: "Find a clickable element and click it in one operation",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector for element to click"),
    elementIndex: z
      .number()
      .default(0)
      .describe("Index if multiple elements match"),
    waitTimeout: z
      .number()
      .default(5000)
      .describe("How long to wait for element"),
    force: z
      .boolean()
      .default(false)
      .describe("Force click even if element not ready"),
    waitAfterClick: z
      .number()
      .default(1000)
      .describe("Milliseconds to wait after clicking"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    elementsFound: z.number(),
    clicked: z.boolean(),
    elementText: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(
        `Find and click: ${context.selector} (index: ${context.elementIndex})`
      );

      // Wait for and find elements
      await page.waitForSelector(context.selector, {
        timeout: context.waitTimeout,
      });
      const elements = await page.locator(context.selector).all();

      if (elements.length === 0) {
        return {
          success: false,
          elementsFound: 0,
          clicked: false,
          error: `No elements found for selector: ${context.selector}`,
        };
      }

      if (context.elementIndex >= elements.length) {
        return {
          success: false,
          elementsFound: elements.length,
          clicked: false,
          error: `Element index ${context.elementIndex} out of range (found ${elements.length} elements)`,
        };
      }

      // Get element text for verification
      const element = page.locator(context.selector).nth(context.elementIndex);
      const elementText = (await element.textContent()) || "";

      // Click the element
      await element.click({ force: context.force });

      // Wait after click for any resulting changes
      if (context.waitAfterClick > 0) {
        await page.waitForTimeout(context.waitAfterClick);
      }

      browserManager.updateActivity();
      console.log(
        `✅ Found ${elements.length} elements, clicked element ${context.elementIndex}: "${elementText}"`
      );

      return {
        success: true,
        elementsFound: elements.length,
        clicked: true,
        elementText: elementText.substring(0, 100), // Limit text length
      };
    } catch (error: any) {
      console.error("Find and click failed:", error);
      return {
        success: false,
        elementsFound: 0,
        clicked: false,
        error: error.message,
      };
    }
  },
});

// Navigate and Analyze Combined Tool
const navigateAndAnalyzeTool = createTool({
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

// Multi-Step Form Fill Tool
const fillFormTool = createTool({
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

// Rate limiting state management
interface RateLimitState {
  inputTokensRemaining: number;
  inputTokensLimit: number;
  inputTokensReset: Date;
  requestsRemaining: number;
  requestsLimit: number;
  requestsReset: Date;
  lastUpdated: Date;
}

let currentRateLimit: RateLimitState | null = null;

// Custom fetch with dynamic rate limiting
const createRateLimitingFetch = (originalFetch = fetch) => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    
    // Only apply rate limiting to Anthropic API calls
    if (!url.includes('api.anthropic.com')) {
      return originalFetch(input, init);
    }

    // Check if we need to wait based on current rate limit state
    if (currentRateLimit) {
      await checkAndWaitForRateLimit();
    }

    console.log(`🌐 Making Anthropic API call at ${new Date().toISOString()}`);
    
    try {
      // Make the actual API call
      const response = await originalFetch(input, init);

      //log anthropic headers in cloudwatch
      let headers = {} as any;
      response.headers.forEach((value: string, key: string) =>{
        headers[key] = value;
      })
      console.log(`Anthropic Response Headers: \n ${JSON.stringify(headers)}`)

      // Extract and update rate limit information from response headers
      updateRateLimitFromHeaders(response.headers);
      
      // Log current rate limit status
      logRateLimitStatus();
      
      return response;
      
    } catch (error: any) {
      console.error('❌ API call failed:', error.message);
      
      // If it's a rate limit error despite our protection, add penalty delay
      if (error.message?.includes('rate limit')) {
        console.log('🚨 Rate limit hit despite protection - adding penalty delay');
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60s penalty
      }
      
      throw error;
    }
  };
};

// Check current rate limit and wait if necessary
const checkAndWaitForRateLimit = async (): Promise<void> => {
  if (!currentRateLimit) return;

  const now = new Date();
  const { inputTokensRemaining, inputTokensReset, requestsRemaining, requestsReset } = currentRateLimit;

  // Check if rate limit has naturally reset
  if (now >= inputTokensReset) {
    console.log('✅ Rate limit window has reset naturally');
    currentRateLimit = null;
    return;
  }

  // Calculate minimum tokens needed for next call (estimated)
  const MIN_TOKENS_NEEDED = 4000; // Conservative estimate based on your logs
  const MIN_REQUESTS_NEEDED = 1;

  // Check input tokens
  if (inputTokensRemaining < MIN_TOKENS_NEEDED) {
    const waitTimeMs = inputTokensReset.getTime() - now.getTime();
    console.log(`🚦 INPUT TOKENS LOW: ${inputTokensRemaining}/${currentRateLimit.inputTokensLimit} remaining`);
    console.log(`⏰ Waiting ${Math.round(waitTimeMs / 1000)}s until reset at ${inputTokensReset.toISOString()}`);
    
    if (waitTimeMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTimeMs + 1000)); // +1s buffer
    }
    return;
  }

  // Check request count
  if (requestsRemaining < MIN_REQUESTS_NEEDED) {
    const waitTimeMs = requestsReset.getTime() - now.getTime();
    console.log(`🚦 REQUESTS LOW: ${requestsRemaining}/${currentRateLimit.requestsLimit} remaining`);
    console.log(`⏰ Waiting ${Math.round(waitTimeMs / 1000)}s until reset at ${requestsReset.toISOString()}`);
    
    if (waitTimeMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTimeMs + 1000)); // +1s buffer
    }
    return;
  }

  // Adaptive delay based on remaining tokens
  if (inputTokensRemaining < 8000) { // Less than 40% remaining
    const delayMs = Math.max(5000, (8000 - inputTokensRemaining) * 2); // Scale delay
    console.log(`⚡ ADAPTIVE DELAY: ${inputTokensRemaining} tokens remaining, waiting ${delayMs}ms`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
};

// Extract rate limit info from response headers
const updateRateLimitFromHeaders = (headers: Headers): void => {
  try {
    const inputTokensRemaining = parseInt(headers.get('anthropic-ratelimit-input-tokens-remaining') || '0');
    const inputTokensLimit = parseInt(headers.get('anthropic-ratelimit-input-tokens-limit') || '20000');
    const inputTokensResetStr = headers.get('anthropic-ratelimit-input-tokens-reset');
    
    const requestsRemaining = parseInt(headers.get('anthropic-ratelimit-requests-remaining') || '0');
    const requestsLimit = parseInt(headers.get('anthropic-ratelimit-requests-limit') || '50');
    const requestsResetStr = headers.get('anthropic-ratelimit-requests-reset');

    if (inputTokensResetStr && requestsResetStr) {
      currentRateLimit = {
        inputTokensRemaining,
        inputTokensLimit,
        inputTokensReset: new Date(inputTokensResetStr),
        requestsRemaining,
        requestsLimit,
        requestsReset: new Date(requestsResetStr),
        lastUpdated: new Date(),
      };
    }
  } catch (error) {
    console.error('Error parsing rate limit headers:', error);
  }
};

// Log current rate limit status
const logRateLimitStatus = (): void => {
  if (!currentRateLimit) {
    console.log('📊 Rate Limit Status: No data available');
    return;
  }

  const { inputTokensRemaining, inputTokensLimit, requestsRemaining, requestsLimit } = currentRateLimit;
  const tokenPercentage = Math.round((inputTokensRemaining / inputTokensLimit) * 100);
  const requestPercentage = Math.round((requestsRemaining / requestsLimit) * 100);

  console.log(`📊 Rate Limit Status:`);
  console.log(`   🎯 Input Tokens: ${inputTokensRemaining}/${inputTokensLimit} (${tokenPercentage}%)`);
  console.log(`   📞 Requests: ${requestsRemaining}/${requestsLimit} (${requestPercentage}%)`);
  
  if (tokenPercentage < 25) {
    console.log(`   ⚠️  WARNING: Low token availability`);
  }
  
  if (currentRateLimit.inputTokensReset) {
    const resetIn = Math.round((currentRateLimit.inputTokensReset.getTime() - Date.now()) / 1000);
    console.log(`   ⏰ Resets in: ${resetIn}s`);
  }
};

const enhancedInstructions = `
Browser automation agent. Complete ALL steps of multi-step tasks.

CRITICAL EFFICIENCY RULES:
- Use ONLY standard CSS selectors (no jQuery syntax)
- Prefer bundled tools to reduce API calls
- Use fillForm for login (email + password + submit in one call)
- Use navigateAndAnalyze to understand new pages quickly

BUNDLED TOOLS (Preferred - Fewer API calls):
- **findAndType**: Find input and type text in one operation
- **findAndClick**: Find element and click in one operation  
- **navigateAndAnalyze**: Navigate and get page overview in one operation
- **fillForm**: Fill multiple form fields in one operation

INDIVIDUAL TOOLS (Use sparingly):
- navigate, wait, screenshot, executeJS, findElements

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


Approach:
1. Plan workflow 
2. Execute step by step

Example efficient workflow:
1. navigateAndAnalyze to login page
2. fillForm with username, password, and submit
3. wait for redirect  
4. screenshot homepage
5. findAndType to search field
6. findAndClick search results

`;

const createRateLimitedAnthropic = () => {
  const customFetch = createRateLimitingFetch();
  
  return createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    headers: {
      'anthropic-beta': 'token-efficient-tools-2025-02-19'
    },
    fetch: customFetch,
  });
};

const anthropic = createRateLimitedAnthropic()

// Generic Browser Agent
const genericBrowserAgent = new Agent({
  name: "Generic Browser Automation Agent",
  instructions: enhancedInstructions,
  model: anthropic("claude-3-7-sonnet-20250219"),
  tools: {
    findAndType: findAndTypeTool,
    findAndClick: findAndClickTool,
    navigateAndAnalyze: navigateAndAnalyzeTool,
    fillForm: fillFormTool,
    wait: waitTool,
    screenshot: screenshotTool,
    executeJs: executeJSTool,
    findElements: findElementsTool,
  },
  memory: new Memory({
    storage: new DynamoDBStore({
      name: "dynamodb",
      config: {
        tableName: process.env.MASTRA_TABLE_NAME!,
        region: process.env.REGION!,
      },
    }),
    options: {
      lastMessages: 3, // Increased for more context
    },
  }),
});

// Main Lambda handler
export const handler = async (event: any): Promise<any> => {
  console.log("Generic Browser Agent invoked");
  console.log("Event:", JSON.stringify(event, null, 2));

  const browserManager = BrowserContextManager.getInstance();

  try {
    if (!event.input) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing required field: input",
          usage: "Provide a natural language prompt for browser automation",
          examples: [
            'Go to the login page, log in with the credentials, then search for "jim johnson" and find his phone number',
            "Navigate to example.com and take a screenshot",
            "Find all the input fields on the current page and tell me what they are for",
          ],
        }),
      };
    }

    const threadId: string = event.thread_id || crypto.randomUUID();
    const jobId: string = event.jobId;
    const startTime = Date.now();

    // Set job ID in environment for screenshot naming
    process.env.JOB_ID = jobId;

    console.log(
      `Processing generic browser automation with thread ID: ${threadId}, job ID: ${jobId}`
    );

    const result = await genericBrowserAgent.generate(event.input, {
      threadId,
      resourceId: "generic-browser-automation",
      maxSteps: 25,
      maxRetries: 0,
      maxTokens: 64000,
      providerOptions: {
        anthropic: {
          test: "",
        },
      },
    });

    const processingTime = Date.now() - startTime;
    console.log(`Generic browser automation completed in ${processingTime}ms`);

    const response = {
      thread_id: threadId,
      job_id: jobId,
      processingTime,
      automationType: "generic-browser",
      features: [
        "navigation",
        "element-finding",
        "clicking",
        "typing",
        "waiting",
        "screenshots",
        "page-analysis",
        "javascript-execution",
      ],
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
    console.error("Generic browser automation error:", error);
    console.error("Error stack:", error.stack);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        automationType: "generic-browser",
        type: error.constructor?.name || "Error",
        timestamp: new Date().toISOString(),
        job_id: event.jobId,
      }),
    };
  } finally {
    // Clean up browser context on completion
    try {
      await browserManager.cleanup();
    } catch (e) {
      console.error("Error during final cleanup:", e);
    }
  }
};
