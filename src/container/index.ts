// container/index.ts - Main handler for containerized Lambda (TypeScript)
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { chromium, Page, Browser } from 'playwright-core';
import { anthropic } from '@ai-sdk/anthropic';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { DynamoDBStore } from '@mastra/dynamodb';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Type definitions for better TypeScript support
interface WebTestResult {
  success: boolean;
  url: string;
  pageTitle: string;
  screenshot: string;
  elementsFound: {
    buttons: number;
    links: number;
    forms: number;
    images: number;
  };
  loadTime: number;
  errors: string[];
  pageSize: {
    width: number;
    height: number;
  };
  basicChecks: {
    hasTitle: boolean;
    hasNavigation: boolean;
    hasMainContent: boolean;
    responsive: boolean;
  };
}

interface TestContext {
  url: string;
  timeout?: number;
  waitForSelector?: string;
}

// Container web test tool with proper TypeScript types
const containerWebTestTool = createTool({
  id: 'container-web-test',
  description: 'Perform web testing with container-based Chromium',
  inputSchema: z.object({
    url: z.string().describe('URL to test'),
    timeout: z.number().default(30000).describe('Timeout in milliseconds'),
    waitForSelector: z.string().optional().describe('Wait for specific element'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    url: z.string(),
    pageTitle: z.string(),
    screenshot: z.string(),
    elementsFound: z.object({
      buttons: z.number(),
      links: z.number(),
      forms: z.number(),
      images: z.number(),
    }),
    loadTime: z.number(),
    errors: z.array(z.string()),
    pageSize: z.object({
      width: z.number(),
      height: z.number(),
    }),
    basicChecks: z.object({
      hasTitle: z.boolean(),
      hasNavigation: z.boolean(),
      hasMainContent: z.boolean(),
      responsive: z.boolean(),
    }),
  }),
  execute: async ({ context }): Promise<WebTestResult> => {
    console.log(`Container tool executing for: ${context.url}`);
    return await performContainerWebTest({
      url: context.url,
      timeout: context.timeout,
      waitForSelector: context.waitForSelector
    });
  },
});

const performContainerWebTest = async (context: TestContext): Promise<WebTestResult> => {
  let browser: Browser | null = null;
  const startTime = Date.now();
  const errors: string[] = [];
  const { url, timeout = 30000, waitForSelector } = context;

  try {
    console.log('Launching Chromium in container...');
    
    // Use system Chromium installed in container
    browser = await chromium.launch({
      headless: true,
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images', // Speed up loading
        '--single-process',
        '--no-zygote',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    console.log('Browser launched successfully');

    const page: Page = await browser.newPage({
      viewport: { width: 1280, height: 720 }
    });

    // Listen for errors with proper typing
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`Console Error: ${msg.text()}`);
      }
    });

    page.on('pageerror', (error: Error) => {
      errors.push(`Page Error: ${error.message}`);
    });

    console.log(`Navigating to: ${url}`);
    
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout 
    });

    const loadTime = Date.now() - startTime;
    console.log(`Page loaded in ${loadTime}ms`);

    // Wait for specific selector if provided
    if (waitForSelector) {
      console.log(`Waiting for selector: ${waitForSelector}`);
      try {
        await page.waitForSelector(waitForSelector, { timeout: 10000 });
      } catch (e) {
        errors.push(`Selector not found: ${waitForSelector}`);
      }
    }

    // Get page info with proper typing
    const pageTitle: string = await page.title();
    console.log(`Page title: ${pageTitle}`);
    
    // Count elements with type safety
    const elementsFound = await page.evaluate(() => {
      return {
        buttons: document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length,
        links: document.querySelectorAll('a[href]').length,
        forms: document.querySelectorAll('form').length,
        images: document.querySelectorAll('img').length,
      };
    });

    console.log('Elements found:', elementsFound);

    // Basic page structure checks with detailed typing
    const basicChecks = await page.evaluate(() => {
      const hasTitle = document.title.length > 0;
      const hasNavigation = !!(
        document.querySelector('nav') || 
        document.querySelector('[role="navigation"]') ||
        document.querySelector('.nav') ||
        document.querySelector('#nav')
      );
      const hasMainContent = !!(
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('.main') ||
        document.querySelector('#main') ||
        document.querySelector('.content')
      );
      
      // Simple responsive check
      const responsive = document.querySelector('meta[name="viewport"]') !== null;

      return {
        hasTitle,
        hasNavigation,
        hasMainContent,
        responsive
      };
    });

    console.log('Basic checks:', basicChecks);

    // Get page size
    const pageSize = await page.evaluate(() => {
      return {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight
      };
    });

    // Take screenshot
    console.log('Taking screenshot...');
    const screenshot = await page.screenshot({ 
      fullPage: true, 
      type: 'png',
      quality: 60 // Compress for faster response
    });
    const screenshotBase64 = screenshot.toString('base64');
    console.log(`Screenshot captured: ${screenshotBase64.length} characters`);

    await browser.close();
    console.log('Test completed successfully');

    return {
      success: true,
      url,
      pageTitle,
      screenshot: screenshotBase64,
      elementsFound,
      loadTime,
      errors,
      pageSize,
      basicChecks,
    };

  } catch (error: any) {
    console.error('Container test failed:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }

    return {
      success: false,
      url,
      pageTitle: '',
      screenshot: '',
      elementsFound: { buttons: 0, links: 0, forms: 0, images: 0 },
      loadTime: Date.now() - startTime,
      errors: [...errors, `Test failed: ${error.message}`],
      pageSize: { width: 0, height: 0 },
      basicChecks: { hasTitle: false, hasNavigation: false, hasMainContent: false, responsive: false },
    };
  }
};

// Container QA Agent with enhanced instructions
const containerQAAgent = new Agent({
  name: 'Container QA Agent',
  instructions: `
    You are a professional QA engineer performing comprehensive web functionality testing using containerized browser automation.
    
    ## Your Capabilities:
    - Take full-page screenshots of web pages using real Chromium browser
    - Count and analyze interactive page elements (buttons, links, forms, images)  
    - Detect JavaScript errors and console warnings
    - Analyze page structure and basic functionality
    - Check for basic responsive design setup
    - Measure page load performance
    
    ## Testing Approach:
    1. **Visual Analysis**: Use the screenshot to understand the visual layout
    2. **Element Analysis**: Count and categorize interactive elements
    3. **Structure Validation**: Check for proper HTML structure (nav, main content, etc.)
    4. **Error Detection**: Report any JavaScript errors or loading issues
    5. **Performance Assessment**: Analyze load times and page size
    
    ## Report Format:
    Provide clear, actionable QA reports following this structure:
    
    ### 1. Executive Summary
    - **Overall Status**: PASS/FAIL with key findings summary
    - **Critical Issues**: Any blocking problems (if found)
    
    ### 2. Page Overview  
    - **Title**: Page title and basic info
    - **Performance**: Load time, page size
    - **Elements**: Count of interactive elements found
    
    ### 3. Structure Analysis
    - **Navigation**: Is there proper navigation structure?
    - **Content**: Is there identifiable main content area?
    - **Responsive**: Basic responsive design indicators
    
    ### 4. Issues Found (if any)
    Categorize by severity:
    - **🔴 Critical**: Page doesn't load, major functionality broken, security issues
    - **🟡 High**: Missing key elements, navigation problems, console errors  
    - **🔵 Medium**: Minor structural issues, non-critical missing elements
    - **⚪ Low**: Cosmetic improvements, optimization suggestions
    
    ### 5. Recommendations
    - Specific, actionable suggestions for improvements
    - Reference screenshot when relevant
    
    ## Key Principles:
    - Be constructive and specific in feedback
    - Include both what works well and what needs improvement  
    - Use the screenshot as primary evidence for visual issues
    - Focus on user experience impact
    - Provide clear next steps for developers
    
    Always analyze the screenshot carefully - it provides crucial visual context that element counts alone cannot capture.
  `,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { containerWebTestTool },
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

// Main Lambda handler with proper typing
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Container QA Handler invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  try {
    const request = JSON.parse(event.body || '{}');
    
    console.log('Request:', request);

    if (!request.input) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required field: input',
          containerMode: true,
        }),
      };
    }

    const threadId: string = request.thread_id || crypto.randomUUID();
    const startTime = Date.now();

    console.log(`Processing with thread ID: ${threadId}`);

    const result = await containerQAAgent.generate(request.input, {
      threadId,
      resourceId: "container-qa-test",
    });

    const processingTime = Date.now() - startTime;
    console.log(`Processing completed in ${processingTime}ms`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        thread_id: threadId,
        processingTime,
        containerMode: true,
        timestamp: new Date().toISOString(),
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          memoryUsage: process.memoryUsage(),
          region: process.env.AWS_REGION,
        },
        ...result
      }),
    };

  } catch (error: any) {
    console.error('Container handler error:', error);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        containerMode: true,
        type: error.constructor?.name || 'Error',
        timestamp: new Date().toISOString(),
      }),
    };
  }
};