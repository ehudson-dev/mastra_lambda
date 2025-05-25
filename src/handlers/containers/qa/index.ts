// src/handlers/containers/qa/index.ts - Fixed Browser Automation Agent
import { chromium, Page, Browser, BrowserContext } from 'playwright-core';
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

// Global browser context manager
class BrowserContextManager {
  private static instance: BrowserContextManager;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastActivity: number = Date.now();
  private readonly TIMEOUT_MS = 600000; // 5 minutes

  static getInstance(): BrowserContextManager {
    if (!BrowserContextManager.instance) {
      BrowserContextManager.instance = new BrowserContextManager();
    }
    return BrowserContextManager.instance;
  }

  async getPage(): Promise<Page> {
    // Check if context is stale
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
    
    // Add error handling
    this.page.on('pageerror', (error) => {
      console.error('Page error:', error);
    });
    
    this.page.on('console', (msg) => {
      console.log('Page console:', msg.text());
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

// Enhanced screenshot tool with context management
const screenshotTool = createTool({
  id: 'take-screenshot',
  description: 'Take a screenshot of the current page state and save it to S3',
  inputSchema: z.object({
    filename: z.string().describe('Name for the screenshot file (e.g., "auth_result.png")'),
    description: z.string().describe('Description of what the screenshot shows'),
    fullPage: z.boolean().default(true).describe('Whether to capture the full page or just viewport'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    s3Url: z.string(),
    filename: z.string(),
    description: z.string(),
    timestamp: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    console.log(`Taking screenshot: ${context.filename}`);
    
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      const screenshot = await page.screenshot({ 
        fullPage: context.fullPage, 
        type: 'png',
      });
      
      const cleanFilename = context.filename.endsWith('.png') ? context.filename : `${context.filename}.png`;
      const s3Url = await saveScreenshotToS3(screenshot, cleanFilename.replace('.png', ''), context.description);
      
      browserManager.updateActivity();
      
      return {
        success: true,
        s3Url,
        filename: cleanFilename,
        description: context.description,
        timestamp: new Date().toISOString(),
      };
      
    } catch (error: any) {
      console.error(`Failed to capture screenshot ${context.filename}:`, error);
      
      return {
        success: false,
        s3Url: '',
        filename: context.filename,
        description: context.description,
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  },
});

// Enhanced page analysis tool
const pageAnalysisTool = createTool({
  id: 'analyze-page',
  description: 'Analyze the current page state to understand what is visible',
  inputSchema: z.object({
    focus: z.string().optional().describe('Specific aspect to focus on (e.g., "login status", "search results", "errors")'),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    status: z.string(),
    content: z.string(),
    errors: z.array(z.string()),
    forms: z.array(z.string()),
    buttons: z.array(z.string()),
    inputs: z.array(z.string()),
    keyElements: z.array(z.string()),
    searchElements: z.array(z.string()),
  }),  
  execute: async ({ context }): Promise<any> => {
    console.log(`Analyzing page with focus: ${context.focus || 'general'}`);
    
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();
      
      const analysis = await analyzeCurrentPage(page, context.focus);
      browserManager.updateActivity();
      
      return analysis;
      
    } catch (error: any) {
      console.error('Page analysis failed:', error);
      
      return {
        url: '',
        title: '',
        status: 'analysis_failed',
        content: '',
        errors: [error.message],
        forms: [],
        buttons: [],
        inputs: [],
        keyElements: [],
        searchElements: [],
      };
    }
  },
});

// Enhanced comprehensive browser automation tool
const comprehensiveBrowserTool = createTool({
  id: 'comprehensive-browser-automation',
  description: 'Complete browser automation with login, search, and data extraction',
  inputSchema: z.object({
    url: z.string().describe('URL to navigate to'),
    credentials: z.object({
      username: z.string(),
      password: z.string(),
    }).optional().describe('Login credentials if needed'),
    searchTerm: z.string().optional().describe('Term to search for'),
    objective: z.string().describe('What we are trying to accomplish'),
    maxRetries: z.number().default(3).describe('Maximum number of retries for operations'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    finalUrl: z.string(),
    pageTitle: z.string(),
    loginResult: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    searchResult: z.object({
      success: z.boolean(),
      phoneNumber: z.string().optional(),
      error: z.string().optional(),
      resultsFound: z.boolean(),
    }),
    screenshots: z.array(z.object({
      name: z.string(),
      s3Url: z.string(),
      description: z.string(),
      timestamp: z.string(),
    })),
    errors: z.array(z.string()),
    executionTime: z.number(),
  }),
  execute: async ({ context }): Promise<any> => {
    console.log(`Starting comprehensive browser automation: ${context.objective}`);
    const startTime = Date.now();
    const screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}> = [];
    const errors: string[] = [];
    
    const result = {
      success: false,
      finalUrl: '',
      pageTitle: '',
      loginResult: { success: false },
      searchResult: { success: false, resultsFound: false },
      screenshots: [] as any[],
      errors: [] as any[],
      executionTime: 0,
    };

    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      // Step 1: Navigate and Login
      console.log('Step 1: Navigating and logging in...');
      const loginResult = await performEnhancedLogin(page, context.url, context.credentials, screenshots);
      result.loginResult = loginResult;

      if (!loginResult.success) {
        result.errors = [loginResult.error || 'Login failed'];
        result.executionTime = Date.now() - startTime;
        return result;
      }

      result.finalUrl = page.url();
      result.pageTitle = await page.title();

      // Step 2: Take homepage screenshot
      const homepageScreenshot = await captureAndStoreScreenshot(page, 'homepage-final', screenshots, 'Final homepage after login');

      // Step 3: Search for the term
      if (context.searchTerm) {
        console.log('Step 2: Performing search...');
        const searchResult = await performEnhancedCRMSearch(page, context.searchTerm, screenshots);
        result.searchResult = searchResult;
      }

      result.success = result.loginResult.success && (!context.searchTerm || result.searchResult.success);
      result.screenshots = screenshots;
      result.errors = errors;
      result.executionTime = Date.now() - startTime;

      browserManager.updateActivity();
      return result;

    } catch (error: any) {
      console.error('Comprehensive browser automation failed:', error);
      result.errors = [...errors, `Automation failed: ${error.message}`];
      result.executionTime = Date.now() - startTime;
      return result;
    }
  },
});

// Enhanced login function with better waiting logic
const performEnhancedLogin = async (
  page: Page, 
  loginUrl: string,
  credentials: any,
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>
): Promise<{success: boolean, error?: string}> => {
  
  try {
    console.log('Navigating to login page...');
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Take initial screenshot
    await captureAndStoreScreenshot(page, 'login-page', screenshots, 'Login page loaded');
    
    // Fill email field with multiple selectors
    console.log('Filling email field...');
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]', 
      'input[name="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]'
    ];
    
    const emailField = await findElementWithSelectors(page, emailSelectors);
    if (!emailField) {
      throw new Error('Could not find email field');
    }
    
    await emailField.click({ clickCount: 3 });
    await page.waitForTimeout(200);
    await emailField.fill(credentials.username);
    await page.waitForTimeout(500);

    // Fill password field
    console.log('Filling password field...');
    const passwordField = await page.locator('input[type="password"]').first();
    await passwordField.waitFor({ state: 'visible', timeout: 5000 });
    await passwordField.click();
    await passwordField.fill(credentials.password);
    await page.waitForTimeout(500);

    // Take screenshot before submission
    await captureAndStoreScreenshot(page, 'login-filled', screenshots, 'Login form filled');

    // Submit login
    console.log('Submitting login form...');
    const submitSelectors = [
      'button:has-text("Sign In")',
      'button:has-text("Sign in")', 
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    
    const submitButton = await findElementWithSelectors(page, submitSelectors);
    if (!submitButton) {
      throw new Error('Could not find submit button');
    }
    
    await submitButton.click();

    // Enhanced waiting for login completion
    console.log('Waiting for login to complete...');
    let attempts = 0;
    const maxAttempts = 20; // 20 * 2 seconds = 40 seconds max wait
    
    while (attempts < maxAttempts) {
      await page.waitForTimeout(2000);
      attempts++;
      
      const currentUrl = page.url();
      console.log(`Login attempt ${attempts}: Current URL: ${currentUrl}`);
      
      // Check if we're still on login page
      if (!currentUrl.includes('login') && !currentUrl.includes('auth')) {
        console.log('Successfully redirected from login page');
        break;
      }
      
      // Check for error messages
      const errorElements = await page.locator('.error, .alert-danger, [role="alert"]').all();
      if (errorElements.length > 0) {
        for (const errorEl of errorElements) {
          const errorText = await errorEl.textContent();
          if (errorText && errorText.trim().length > 0) {
            throw new Error(`Login error: ${errorText}`);
          }
        }
      }
    }

    // Final verification
    const finalUrl = page.url();
    if (finalUrl.includes('login') || finalUrl.includes('auth')) {
      throw new Error('Still on login page after submission - login likely failed');
    }

    // Take final screenshot
    await captureAndStoreScreenshot(page, 'login-success', screenshots, 'Successful login - main page');
    
    console.log('Login successful!');
    return { success: true };

  } catch (error: any) {
    console.error('Login failed:', error);
    await captureAndStoreScreenshot(page, 'login-error', screenshots, 'Login error state');
    return { success: false, error: error.message };
  }
};

// Enhanced CRM search function
const performEnhancedCRMSearch = async (
  page: Page,
  searchTerm: string,
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>
): Promise<{success: boolean, phoneNumber?: string, error?: string, resultsFound: boolean}> => {
  
  try {
    console.log(`Performing CRM search for: ${searchTerm}`);
    
    // Wait for page to be ready
    await page.waitForTimeout(3000);
    
    // Take screenshot before search
    await captureAndStoreScreenshot(page, 'before-search', screenshots, 'Page state before search');
    
    // Enhanced search field detection
    const searchSelectors = [
      'input[placeholder*="Search Contacts" i]',
      'input[placeholder*="search contacts" i]',
      'input[placeholder*="search" i]',
      'input[name*="search" i]',
      'input[type="search"]',
      '.search input',
      '[data-testid*="search"] input',
      'input[aria-label*="search" i]'
    ];
    
    console.log('Looking for search field...');
    const searchField = await findElementWithSelectors(page, searchSelectors);
    
    if (!searchField) {
      // Let's check what input fields are available
      const allInputs = await page.locator('input').all();
      console.log(`Found ${allInputs.length} input fields on page`);
      
      for (let i = 0; i < allInputs.length; i++) {
        const input = allInputs[i];
        const placeholder = await input.getAttribute('placeholder');
        const name = await input.getAttribute('name');
        const type = await input.getAttribute('type');
        console.log(`Input ${i}: placeholder="${placeholder}", name="${name}", type="${type}"`);
      }
      
      throw new Error('Could not find search field on page');
    }
    
    console.log('Found search field, clicking and entering search term...');
    
    // Clear and enter search term
    await searchField.click();
    await searchField.clear();
    await searchField.fill(searchTerm);
    await page.waitForTimeout(1000);
    
    // Take screenshot after typing
    await captureAndStoreScreenshot(page, 'search-typed', screenshots, 'Search term entered');
    
    // Press Enter to search
    await searchField.press('Enter');
    
    console.log('Search submitted, waiting for results...');
    
    // Wait for modal or results to appear
    const modalSelectors = [
      '.modal',
      '[role="dialog"]',
      '.search-results-modal',
      '.modal-dialog',
      '.search-modal',
      '[data-testid*="modal"]'
    ];
    
    let modalElement : any = null;
    let attempts = 0;
    const maxWaitAttempts = 10;
    
    while (attempts < maxWaitAttempts && !modalElement) {
      await page.waitForTimeout(2000);
      attempts++;
      
      console.log(`Waiting for modal, attempt ${attempts}...`);
      
      for (const selector of modalSelectors) {
        try {
          const element = page.locator(selector);
          if (await element.isVisible()) {
            modalElement = element;
            console.log(`Found modal with selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // Take progress screenshot
      if (attempts === 5) {
        await captureAndStoreScreenshot(page, 'search-waiting', screenshots, 'Waiting for search results modal');
      }
    }
    
    if (!modalElement) {
      // Maybe results appear without modal - check for table directly
      const tableSelectors = [
        'table',
        '.table',
        '.results-table',
        '[role="table"]',
        '.search-results table'
      ];
      
      for (const selector of tableSelectors) {
        try {
          const tableElement = page.locator(selector);
          if (await tableElement.isVisible()) {
            console.log(`Found results table with selector: ${selector}`);
            modalElement = page; // Use page as container
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }
    
    if (!modalElement) {
      await captureAndStoreScreenshot(page, 'search-no-modal', screenshots, 'No modal or results found');
      return { success: false, error: 'Search modal or results did not appear', resultsFound: false };
    }
    
    // Take screenshot of modal/results
    await captureAndStoreScreenshot(page, 'search-results-modal', screenshots, 'Search results modal appeared');
    
    // Look for results table within modal or page
    const tableSelectors = [
      'table tbody tr',
      '.table tbody tr',
      '.results-table tbody tr',
      '[role="row"]',
      'tr[data-testid*="result"]'
    ];
    
    let firstRow : any = null;
    for (const selector of tableSelectors) {
      try {
        const container = modalElement === page ? page : modalElement;
        const rows = await container.locator(selector).all();
        
        if (rows.length > 0) {
          firstRow = rows[0];
          console.log(`Found ${rows.length} result rows`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!firstRow) {
      await captureAndStoreScreenshot(page, 'search-no-results', screenshots, 'No results found in table');
      return { success: false, error: 'No search results found in table', resultsFound: false };
    }
    
    // Extract phone number from first row
    console.log('Extracting phone number from first result...');
    
    // Try different approaches to find phone number
    const phoneSelectors = [
      'td:nth-child(3)', // Assuming phone is 3rd column
      'td:nth-child(4)', // Or 4th column
      'td[data-field*="phone"]',
      'td[data-testid*="phone"]',
      '.phone',
      '[data-phone]'
    ];
    
    let phoneNumber = null;
    
    for (const selector of phoneSelectors) {
      try {
        const phoneCell = firstRow.locator(selector);
        const phoneText = await phoneCell.textContent({ timeout: 2000 });
        
        if (phoneText && phoneText.trim().length > 0) {
          // Check if it looks like a phone number
          const cleanPhone = phoneText.trim();
          if (/[\d\-\(\)\+\s]{10,}/.test(cleanPhone)) {
            phoneNumber = cleanPhone;
            console.log(`Found phone number: ${phoneNumber}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    // If no phone found with selectors, get all cells and look for phone pattern
    if (!phoneNumber) {
      try {
        const allCells = await firstRow.locator('td').all();
        console.log(`Checking ${allCells.length} cells for phone number...`);
        
        for (let i = 0; i < allCells.length; i++) {
          const cellText = await allCells[i].textContent();
          if (cellText && /[\d\-\(\)\+\s]{10,}/.test(cellText.trim())) {
            phoneNumber = cellText.trim();
            console.log(`Found phone number in cell ${i}: ${phoneNumber}`);
            break;
          }
        }
      } catch (e) {
        console.error('Error extracting phone from cells:', e);
      }
    }
    
    // Take final screenshot
    await captureAndStoreScreenshot(page, 'search-complete', screenshots, 'Search operation completed');
    
    if (phoneNumber) {
      return { 
        success: true, 
        phoneNumber, 
        resultsFound: true 
      };
    } else {
      return { 
        success: false, 
        error: 'Phone number not found in search results', 
        resultsFound: true 
      };
    }
    
  } catch (error: any) {
    console.error('CRM search failed:', error);
    await captureAndStoreScreenshot(page, 'search-error', screenshots, 'Search error state');
    return { 
      success: false, 
      error: error.message, 
      resultsFound: false 
    };
  }
};

// Helper function to find element with multiple selectors
const findElementWithSelectors = async (page: Page, selectors: string[]) => {
  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 2000 })) {
        console.log(`Found element with selector: ${selector}`);
        return element;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
};

// Enhanced page analysis function
const analyzeCurrentPage = async (page: Page, focus?: string): Promise<any> => {
  try {
    console.log(`Analyzing current page with focus: ${focus || 'general'}`);
    
    const analysis = await page.evaluate((focusArea) => {
      const currentUrl = window.location.href;
      const pageTitle = document.title;
      
      // Get page status
      let status = 'loaded';
      if (currentUrl.includes('login') || currentUrl.includes('auth')) {
        status = 'login_page';
      } else if (currentUrl.includes('dashboard') || document.querySelector('.dashboard')) {
        status = 'dashboard_page';
      }
      
      // Get visible content (first 1000 chars)
      const bodyText = document.body?.innerText?.substring(0, 1000) || '';
      
      // Find errors
      const errorSelectors = ['.error', '.alert-danger', '.text-red-500', '[role="alert"]'];
      const errors = [] as any[];
      for (const selector of errorSelectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el: any) => {
          if (el.offsetParent !== null) {
            const text = el.textContent?.trim();
            if (text && text.length > 0) {
              errors.push(text);
            }
          }
        });
      }
      
      // Find forms, buttons, inputs
      const forms = [] as any[];
      document.querySelectorAll('form').forEach((form, index) => {
        const action = form.action || 'no-action';
        const method = form.method || 'GET';
        forms.push(`Form ${index + 1}: ${method} ${action}`);
      });
      
      const buttons = [] as any[];
      document.querySelectorAll('button').forEach((button) => {
        const text = button.textContent?.trim() || 'no-text';
        const type = button.type || 'button';
        const disabled = button.disabled ? ' (disabled)' : '';
        if (text !== 'no-text') {
          buttons.push(`${text} [${type}]${disabled}`);
        }
      });
      
      const inputs = [] as any[];
      document.querySelectorAll('input').forEach((input, index) => {
        const type = input.type || 'text';
        const name = input.name || `input-${index}`;
        const placeholder = input.placeholder || '';
        inputs.push(`${name} [${type}] ${placeholder}`);
      });
      
      // Search-specific analysis
      const searchElements = [] as any[];
      const searchSelectors = [
        'input[placeholder*="search" i]',
        'input[placeholder*="Search" i]',
        'input[name*="search" i]',
        '.search',
        '[data-testid*="search"]'
      ];
      
      for (const selector of searchSelectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el: any) => {
          if (el.offsetParent !== null) {
            const placeholder = el.placeholder || '';
            const name = el.name || '';
            searchElements.push(`Search element: ${selector} - ${placeholder} ${name}`);
          }
        });
      }
      
      // Key elements based on focus
      const keyElements = [] as any[];
      if (focusArea === 'search functionality') {
        if (document.querySelector('input[placeholder*="Search Contacts" i]')) {
          keyElements.push('Search Contacts field found');
        }
        if (document.querySelector('.search')) {
          keyElements.push('Search container found');
        }
      }
      
      return {
        url: currentUrl,
        title: pageTitle,
        status,
        content: bodyText,
        errors,
        forms,
        buttons,
        inputs,
        keyElements,
        searchElements,
      };
    }, focus);
    
    console.log('Page analysis completed:', analysis);
    return analysis;
    
  } catch (error: any) {
    console.error('Page analysis failed:', error);
    
    return {
      url: page.url(),
      title: await page.title(),
      status: 'analysis_failed',
      content: '',
      errors: [error.message],
      forms: [],
      buttons: [],
      inputs: [],
      keyElements: [],
      searchElements: [],
    };
  }
};

// Screenshot helper function
const captureAndStoreScreenshot = async (
  page: Page, 
  name: string, 
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>,
  description?: string
): Promise<string> => {
  try {
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const s3Url = await saveScreenshotToS3(screenshot, name, description || `Screenshot: ${name}`);
    screenshots.push({
      name,
      s3Url,
      description: description || `Screenshot: ${name}`,
      timestamp: new Date().toISOString(),
    });
    return s3Url;
  } catch (error) {
    console.error(`Failed to capture screenshot ${name}:`, error);
    return '';
  }
};

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
    console.log(`Screenshot saved: ${s3Url}`);
    return s3Url;

  } catch (error: any) {
    console.error('Error saving screenshot:', error);
    throw error;
  }
};

const enhancedInstructions = `
You are a specialized CRM automation assistant that excels at login, search, and data extraction tasks.

## Your Mission
Extract phone numbers from CRM search results by:
1. Logging into the system with provided credentials
2. Using the CRM's search functionality 
3. Finding and extracting phone numbers from results

## Available Tools
- **comprehensiveBrowserTool**: Complete automation workflow (login + search + extraction)
- **screenshotTool**: Capture current page state for verification
- **pageAnalysisTool**: Analyze page structure when needed

## Primary Workflow
When given a task like "login and search for a person", use this approach:

1. **Use comprehensiveBrowserTool** with all required parameters:
   - url: The login URL
   - credentials: {username, password} 
   - searchTerm: The person to search for
   - objective: Clear description of the goal

2. **Analyze Results**: The tool will return:
   - loginResult: Success/failure of authentication
   - searchResult: Success/failure and phone number if found
   - screenshots: Visual documentation of each step

3. **Extract Key Information**: Focus on the phone number in searchResult.phoneNumber

## Response Format
Always provide:
- **Login Status**: Success or failure with details
- **Search Status**: Whether search completed successfully  
- **Phone Number**: The extracted phone number (if found)
- **Screenshots**: References to visual evidence

## Error Handling
If the comprehensive tool fails:
1. Use pageAnalysisTool to understand current page state
2. Use screenshotTool to capture current visual state
3. Provide detailed diagnostic information

## Example Response
"**🎯 Action Taken**: Used comprehensive browser automation to login and search for 'jim johnson'
**👁️ Observation**: Successfully logged in and found search results in modal popup  
**🧠 Decision**: Extracted phone number from first search result
**📱 Phone Number**: (555) 123-4567

Screenshots captured: login-page, search-results-modal, extraction-complete"

Always end with the phone number clearly stated if found.
`;

const enhancedAgent = new Agent({
  name: 'CRM Search Specialist',
  instructions: enhancedInstructions,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { comprehensiveBrowserTool, screenshotTool, pageAnalysisTool },
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
  console.log('Enhanced Browser Agent invoked');
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
            'Navigate to the login page, login with provided credentials, search for "jim johnson" and extract phone number'
          ]
        }),
      };
    }

    const threadId: string = event.thread_id || crypto.randomUUID();
    const jobId: string = event.jobId;
    const startTime = Date.now();

    // Set job ID in environment for screenshot naming
    process.env.JOB_ID = jobId;

    console.log(`Processing enhanced browser automation with thread ID: ${threadId}, job ID: ${jobId}`);

    const result = await enhancedAgent.generate(event.input, {
      threadId,
      resourceId: "enhanced-browser-automation",
    });

    const processingTime = Date.now() - startTime;
    console.log(`Enhanced browser automation completed in ${processingTime}ms`);

    const response = {
      thread_id: threadId,
      job_id: jobId,
      processingTime,
      automationType: 'enhanced-browser',
      features: ['session-management', 'login-automation', 'crm-search', 'data-extraction', 'visual-documentation'],
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
    console.error('Enhanced browser automation error:', error);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        automationType: 'enhanced-browser',
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