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

// Independent screenshot tool that Claude can call at any time
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
    
    // This will be called with the current page context
    return await captureIndependentScreenshot(context.filename, context.description, context.fullPage);
  },
});

// Page analysis tool for Claude to understand current state
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
  }),  
  execute: async ({ context }): Promise<any> => {
    console.log(`Analyzing page with focus: ${context.focus || 'general'}`);
    
    return await analyzeCurrentPage(context.focus);
  },
});

// Updated observational browser tool with screenshot access
const enhancedObservationalBrowserTool = createTool({
  id: 'enhanced-observational-browser-automation',
  description: 'Browser automation with built-in screenshot and analysis capabilities',
  inputSchema: z.object({
    url: z.string().describe('URL to navigate to'),
    credentials: z.object({
      username: z.string(),
      password: z.string(),
    }).optional().describe('Login credentials if needed'),
    searchTerm: z.string().optional().describe('Term to search for'),
    objective: z.string().describe('What we are trying to accomplish'),
    customActions: z.array(z.object({
      type: z.enum(['screenshot', 'wait', 'analyze']),
      filename: z.string().optional(),
      description: z.string().optional(),
      duration: z.number().optional(),
      focus: z.string().optional(),
    })).optional().describe('Additional actions to perform'),
    maxActions: z.number().default(10).describe('Maximum number of actions to attempt'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    finalUrl: z.string(),
    pageTitle: z.string(),
    objective: z.string(),
    actionsTaken: z.array(z.object({
      step: z.number(),
      action: z.string(),
      observation: z.string(),
      decision: z.string(),
      screenshot: z.string().optional(),
    })),
    finalObservation: z.string(),
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
    console.log(`Starting enhanced observational automation for: ${context.objective}`);
    return await performEnhancedObservationalAutomation(context);
  },
});

// Global page reference for screenshot tools
let currentPage: Page | null = null;

// Set the current page context for tools to use
const setCurrentPageContext = (page: Page | null) => {
  currentPage = page;
};

// Independent screenshot function
const captureIndependentScreenshot = async (
  filename: string,
  description: string,
  fullPage: boolean = true
): Promise<any> => {
  
  if (!currentPage) {
    return {
      success: false,
      s3Url: '',
      filename,
      description,
      timestamp: new Date().toISOString(),
      error: 'No active page context available'
    };
  }

  try {
    console.log(`Capturing independent screenshot: ${filename}`);
    
    const screenshot = await currentPage.screenshot({ 
      fullPage, 
      type: 'png',
    });
    
    // Clean filename to ensure it ends with .png
    const cleanFilename = filename.endsWith('.png') ? filename : `${filename}.png`;
    
    const s3Url = await saveScreenshotToS3(screenshot, cleanFilename.replace('.png', ''), description);
    
    return {
      success: true,
      s3Url,
      filename: cleanFilename,
      description,
      timestamp: new Date().toISOString(),
    };
    
  } catch (error: any) {
    console.error(`Failed to capture screenshot ${filename}:`, error);
    
    return {
      success: false,
      s3Url: '',
      filename,
      description,
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
};

// Independent page analysis function
const analyzeCurrentPage = async (focus?: string): Promise<any> => {
  
  if (!currentPage) {
    return {
      url: '',
      title: '',
      status: 'No active page context',
      content: '',
      errors: ['No active page context available'],
      forms: [],
      buttons: [],
      inputs: [],
      keyElements: [],
    };
  }

  try {
    console.log(`Analyzing current page with focus: ${focus || 'general'}`);
    
    const analysis = await currentPage.evaluate((focusArea) => {
      const currentUrl = window.location.href;
      const pageTitle = document.title;
      
      // Get page status
      let status = 'loaded';
      if (currentUrl.includes('login') || currentUrl.includes('auth')) {
        status = 'login_page';
      } else if (currentUrl.includes('dashboard') || document.querySelector('.dashboard')) {
        status = 'dashboard_page';
      } else if (document.querySelector('.search-results')) {
        status = 'search_results_page';
      }
      
      // Get visible content (first 1000 chars)
      const bodyText = document.body?.innerText?.substring(0, 1000) || '';
      
      // Find errors
      const errorSelectors = ['.error', '.alert-danger', '.text-red-500', '.text-destructive', '[role="alert"]'];
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
        })
      }
      
      // Find forms
      const forms = [] as any[];
      document.querySelectorAll('form').forEach((form, index) => {
        const action = form.action || 'no-action';
        const method = form.method || 'GET';
        forms.push(`Form ${index + 1}: ${method} ${action}`);
      });
      
      // Find buttons
      const buttons = [] as any[];
      document.querySelectorAll('button').forEach((button, index) => {
        const text = button.textContent?.trim() || 'no-text';
        const type = button.type || 'button';
        const disabled = button.disabled ? ' (disabled)' : '';
        buttons.push(`${text} [${type}]${disabled}`);
      });
      
      // Find inputs
      const inputs = [] as any[];
      document.querySelectorAll('input').forEach((input, index) => {
        const type = input.type || 'text';
        const name = input.name || `input-${index}`;
        const placeholder = input.placeholder || '';
        const value = input.value ? `value: ${input.value.substring(0, 20)}...` : 'empty';
        inputs.push(`${name} [${type}] ${placeholder} (${value})`);
      });
      
      // Find key elements based on focus
      const keyElements = [] as any[];
      if (focusArea === 'login status') {
        // Look for login-related elements
        if (document.querySelector('input[type="password"]')) keyElements.push('Password field present');
        if (document.querySelector('button:contains("Sign")')) keyElements.push('Sign in button present');
        if (currentUrl.includes('login')) keyElements.push('On login page');
      } else if (focusArea === 'search results') {
        // Look for search-related elements
        if (document.querySelector('.search-results')) keyElements.push('Search results container');
        if (document.querySelector('input[type="search"]')) keyElements.push('Search input field');
      } else {
        // General key elements
        const mainElement = document.querySelector('main, #main, .main');
        if (mainElement) keyElements.push('Main content area found');
        
        const navElement = document.querySelector('nav, .navbar, .navigation');
        if (navElement) keyElements.push('Navigation element found');
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
      };
    }, focus);
    
    console.log('Page analysis completed:', analysis);
    return analysis;
    
  } catch (error: any) {
    console.error('Page analysis failed:', error);
    
    return {
      url: currentPage.url(),
      title: await currentPage.title(),
      status: 'analysis_failed',
      content: '',
      errors: [error.message],
      forms: [],
      buttons: [],
      inputs: [],
      keyElements: [],
    };
  }
};

// Enhanced automation function with tool access
const performEnhancedObservationalAutomation = async (context: any): Promise<any> => {
  let browser: Browser | null = null;
  const startTime = Date.now();
  const actionsTaken: Array<{step: number, action: string, observation: string, decision: string, screenshot?: string}> = [];
  const screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}> = [];
  const errors: string[] = [];
  let currentStep = 0;

  const result = {
    success: false,
    finalUrl: '',
    pageTitle: '',
    objective: context.objective,
    actionsTaken: [] as any[],
    finalObservation: '',
    screenshots: [] as any[],
    errors: [] as any[],
    executionTime: 0,
  };

  try {
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
      ],
    });

    const browserContext = await browser.newContext();
    
    const page: Page = await browserContext.newPage();

    // Set global page context for tools
    setCurrentPageContext(page);

    // Step 1: Navigate to URL
    currentStep++;
    console.log(`Step ${currentStep}: Navigating to ${context.url}`);
    
    await page.goto(context.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const initialObservation = await observePage(page, 'after_navigation');
    const initialScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-navigation`, screenshots);
    
    actionsTaken.push({
      step: currentStep,
      action: `Navigate to ${context.url}`,
      observation: initialObservation.summary,
      decision: 'Proceeding based on page analysis',
      screenshot: initialScreenshot,
    });

    result.finalUrl = page.url();
    result.pageTitle = await page.title();

    // Handle login if needed (same enhanced login logic as before)
    if (context.credentials && initialObservation.hasLoginForm) {
      const loginResult = await performObservationalLogin(page, context.credentials, currentStep, actionsTaken, screenshots);
      
      if (!loginResult.success) {
        errors.push(`Login failed: ${loginResult.error}`);
        result.success = false;
        result.finalObservation = `Login failed: ${loginResult.error}`;
        await browser.close();
        return result;
      }
      
      currentStep = loginResult.nextStep;
    }

    // Handle search if needed
    if (context.searchTerm) {
      const searchResult = await performObservationalSearch(page, context.searchTerm, currentStep, actionsTaken, screenshots);
      if (!searchResult.success) {
        errors.push(`Search failed: ${searchResult.error}`);
      }
      currentStep = searchResult.nextStep;
    }

    // Handle custom actions (including custom screenshots)
    if (context.customActions && context.customActions.length > 0) {
      for (const customAction of context.customActions) {
        currentStep++;
        
        if (customAction.type === 'screenshot') {
          const filename = customAction.filename || `custom-screenshot-${currentStep}`;
          const description = customAction.description || 'Custom screenshot';
          
          const screenshotResult = await captureIndependentScreenshot(filename, description);
          
          if (screenshotResult.success) {
            screenshots.push({
              name: screenshotResult.filename,
              s3Url: screenshotResult.s3Url,
              description: screenshotResult.description,
              timestamp: screenshotResult.timestamp,
            });
          }
          
          actionsTaken.push({
            step: currentStep,
            action: `Take custom screenshot: ${filename}`,
            observation: screenshotResult.success ? 'Screenshot captured successfully' : `Screenshot failed: ${screenshotResult.error}`,
            decision: 'Custom screenshot action completed',
            screenshot: screenshotResult.success ? screenshotResult.s3Url : undefined,
          });
          
        } else if (customAction.type === 'wait') {
          const duration = 5000;
          await page.waitForTimeout(duration);
          
          actionsTaken.push({
            step: currentStep,
            action: `Wait for ${duration}ms`,
            observation: `Waited ${duration} milliseconds`,
            decision: 'Wait completed, continuing',
          });
          
        } else if (customAction.type === 'analyze') {
          const analysis = await analyzeCurrentPage(customAction.focus);
          
          actionsTaken.push({
            step: currentStep,
            action: `Analyze page (focus: ${customAction.focus || 'general'})`,
            observation: `Page analysis: ${analysis.status}, ${analysis.errors.length} errors, ${analysis.buttons.length} buttons`,
            decision: 'Page analysis completed',
          });
        }
      }
    }

    // Final observation
    const finalObservation = await observePage(page, 'final_state');
    
    result.finalObservation = finalObservation.summary;
    result.success = errors.length === 0 && !finalObservation.hasErrors;
    result.actionsTaken = actionsTaken;
    result.screenshots = screenshots;
    result.errors = errors;
    result.finalUrl = page.url();
    result.pageTitle = await page.title();

    await browser.close();
    setCurrentPageContext(null); // Clear context

    return result;

  } catch (error: any) {
    console.error('Enhanced observational automation failed:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
    setCurrentPageContext(null);

    result.errors = [...errors, `Automation failed: ${error.message}`];
    result.executionTime = Date.now() - startTime;
    return result;
  } finally {
    result.executionTime = Date.now() - startTime;
  }
};

// Enhanced observation that recognizes async operations and waits appropriately
const observePage = async (page: Page, context: string): Promise<any> => {
  console.log(`=== OBSERVING PAGE: ${context} ===`);
  
  const observation = await page.evaluate(() => {
    const currentUrl = window.location.href;
    const pageTitle = document.title;
    
    // Check for login form
    const loginForms = document.querySelectorAll('form');
    const emailInputs = document.querySelectorAll('input[type="email"], input[name="email"], input[name="username"]');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    const hasLoginForm = loginForms.length > 0 && emailInputs.length > 0 && passwordInputs.length > 0;
    
    // Check for search functionality
    const searchInputs = document.querySelectorAll('input[type="search"], input[name="search"], input[placeholder*="search" i]');
    const hasSearchForm = searchInputs.length > 0;
    
    // Check for error messages
    const errorSelectors = [
      '.error', '.alert-danger', '.text-red-500', '.text-destructive', 
      '[role="alert"]', '.error-message', '[class*="error"]'
    ];
    const errorElements = [] as any[];
    for (const selector of errorSelectors) {
      const elements = document.querySelectorAll(selector);
      elements.forEach( (el: any ) => {
        if (el.offsetParent !== null) { // visible elements only
          const text = el.textContent?.trim();
          if (text && text.length > 0) {
            errorElements.push(text);
          }
        }
      })
    }
    
    // Check for success indicators
    const successSelectors = [
      '.success', '.alert-success', '.text-green-500', '.success-message',
      '[class*="success"]', '.dashboard', '[data-testid*="dashboard"]'
    ];
    const successElements = [] as any[];
    for (const selector of successSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        successElements.push(selector);
      }
    }
    
    // **NEW: Check for loading/processing indicators**
    const loadingIndicators = [] as any[];
    const loadingSelectors = [
      '.loading', '.spinner', '.processing',
      '[class*="loading"]', '[class*="spinner"]'
    ];
    
    // Check button text specifically for async states
    const buttons = document.querySelectorAll('button');
    buttons.forEach((button : any) => {
      const text = button.textContent?.trim().toLowerCase();
      if (text?.includes('signing in') || 
          text?.includes('loading') || 
          text?.includes('processing') ||
          text?.includes('please wait') ||
          text?.includes('submitting')) {
        loadingIndicators.push(`Button: "${button.textContent?.trim()}"`);
      }
      
      // Check if button is disabled (another loading indicator)
      if (button.disabled && text) {
        loadingIndicators.push(`Disabled button: "${text}"`);
      }
    })
    
    // Check for other loading elements
    for (const selector of loadingSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        loadingIndicators.push(`Loading element: ${selector}`);
      }
    }
    
    // Get visible text content (first 500 chars)
    const bodyText = document.body?.innerText?.substring(0, 500) || '';
    
    // Check if we're still on login page
    const isLoginPage = currentUrl.includes('login') || currentUrl.includes('auth') || 
                       pageTitle.toLowerCase().includes('login') || pageTitle.toLowerCase().includes('sign in');
    
    // Check for specific form field values
    const emailFieldValue = emailInputs.length > 0 ? (emailInputs[0] as HTMLInputElement).value : '';
    const passwordFieldValue = passwordInputs.length > 0 ? (passwordInputs[0] as HTMLInputElement).value.length : 0;
    
    // **NEW: Determine if we're in a processing state**
    const isProcessing = loadingIndicators.length > 0;
    
    return {
      url: currentUrl,
      title: pageTitle,
      hasLoginForm,
      hasSearchForm,
      isLoginPage,
      isProcessing,
      loadingIndicators,
      errors: errorElements,
      successIndicators: successElements,
      bodyText,
      emailFieldValue,
      passwordFieldLength: passwordFieldValue,
      visibleElements: {
        loginForms: loginForms.length,
        emailInputs: emailInputs.length,
        passwordInputs: passwordInputs.length,
        searchInputs: searchInputs.length,
      }
    };
  });
  
  // Create human-readable summary with async awareness
  let summary = `URL: ${observation.url}\nTitle: ${observation.title}\n`;
  
  // **NEW: Process async state detection**
  if (observation.isProcessing) {
    summary += `STATUS: ⏳ PROCESSING - ${observation.loadingIndicators.join(', ')}\n`;
  } else if (observation.isLoginPage) {
    summary += `STATUS: Still on login page\n`;
  } else {
    summary += `STATUS: Not on login page (login may have succeeded)\n`;
  }
  
  if (observation.errors.length > 0) {
    summary += `ERRORS FOUND: ${observation.errors.join(', ')}\n`;
  }
  
  if (observation.successIndicators.length > 0) {
    summary += `SUCCESS INDICATORS: ${observation.successIndicators.join(', ')}\n`;
  }
  
  if (observation.emailFieldValue) {
    summary += `EMAIL FIELD: ${observation.emailFieldValue}\n`;
  }
  
  if (observation.passwordFieldLength > 0) {
    summary += `PASSWORD FIELD: ${observation.passwordFieldLength} characters\n`;
  }
  
  summary += `VISIBLE CONTENT: ${observation.bodyText.substring(0, 200)}...`;
  
  console.log('Page Observation:', summary);
  
  return {
    ...observation,
    summary,
    hasErrors: observation.errors.length > 0,
    needsMoreWaiting: observation.isProcessing,
  };
};

// Enhanced login function that waits for async operations
const performObservationalLogin = async (
  page: Page, 
  credentials: any, 
  startStep: number, 
  actionsTaken: any[], 
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>
): Promise<{success: boolean, error?: string, nextStep: number}> => {
  
  let currentStep = startStep;
  
  try {
    // Fill email field (same as before)
    console.log(`Step ${currentStep}: Filling email field`);
    currentStep++
    
    const emailField = page.locator('input[type="email"], input[name="email"], input[name="username"]').first();
    await emailField.waitFor({ state: 'visible', timeout: 5000 });
    
    await emailField.click({ clickCount: 3 });
    await page.waitForTimeout(200);
    await page.keyboard.type(credentials.username);
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    
    const emailObservation = await observePage(page, 'after_email_entry');
    const emailScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-email-entry`, screenshots);
    
    actionsTaken.push({
      step: currentStep,
      action: `Fill email field with: ${credentials.username}`,
      observation: emailObservation.summary,
      decision: emailObservation.hasErrors ? 'Email entry failed - checking for errors' : 'Email entered successfully, proceeding to password',
      screenshot: emailScreenshot,
    });
    
    if (emailObservation.hasErrors) {
      return { success: false, error: `Email entry failed: ${emailObservation.errors.join(', ')}`, nextStep: currentStep };
    }
    
    // Fill password field (same as before)
    currentStep++;
    console.log(`Step ${currentStep}: Filling password field`);
    
    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.waitFor({ state: 'visible', timeout: 5000 });
    
    await passwordField.click();
    await passwordField.clear();
    await passwordField.fill(credentials.password);
    await page.waitForTimeout(500);
    
    const passwordObservation = await observePage(page, 'after_password_entry');
    const passwordScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-password-entry`, screenshots);
    
    actionsTaken.push({
      step: currentStep,
      action: 'Fill password field',
      observation: passwordObservation.summary,
      decision: 'Password entered, proceeding to submit',
      screenshot: passwordScreenshot,
    });
    
    // Submit login form
    currentStep++;
    console.log(`Step ${currentStep}: Submitting login form`);
    
    const submitButton = page.locator('button:has-text("Sign In"), button:has-text("Sign in"), button[type="submit"]').first();
    await submitButton.waitFor({ state: 'visible', timeout: 5000 });
    await submitButton.click();
    
    // **NEW: Enhanced waiting for async login process**
    console.log('Waiting for login process to complete...');
    
    let waitAttempts = 0;
    const maxWaitAttempts = 12; // 12 * 2.5s = 30 seconds max wait
    let finalObservation;
    
    while (waitAttempts < maxWaitAttempts) {
      await page.waitForTimeout(2500); // Wait 2.5 seconds between checks
      waitAttempts++;
      
      finalObservation = await observePage(page, `login_check_attempt_${waitAttempts}`);
      console.log(`Login check attempt ${waitAttempts}: ${finalObservation.isProcessing ? 'STILL PROCESSING' : 'COMPLETED'}`);
      
      // If no longer processing, break out of wait loop
      if (!finalObservation.needsMoreWaiting) {
        console.log('Login process completed (no more loading indicators)');
        break;
      }
      
      console.log(`Still processing (${finalObservation.loadingIndicators.join(', ')}), waiting more...`);
    }
    
    // Final observation after waiting
    if (!finalObservation) {
      finalObservation = await observePage(page, 'final_login_state');
    }
    
    const submitScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-login-final`, screenshots);
    
    // Determine if login was successful after proper waiting
    const loginSuccessful = !finalObservation.isLoginPage && !finalObservation.hasErrors && !finalObservation.needsMoreWaiting;
    
    let decision;
    if (finalObservation.needsMoreWaiting) {
      decision = `Login still processing after ${waitAttempts * 2.5} seconds - may need more time`;
    } else if (loginSuccessful) {
      decision = 'Login successful - redirected from login page';
    } else if (finalObservation.hasErrors) {
      decision = `Login failed with errors: ${finalObservation.errors.join(', ')}`;
    } else {
      decision = 'Login failed - still on login page with no processing indicators';
    }
    
    actionsTaken.push({
      step: currentStep,
      action: `Submit login form and wait for completion (waited ${waitAttempts * 2.5}s)`,
      observation: finalObservation.summary,
      decision,
      screenshot: submitScreenshot,
    });
    
    if (finalObservation.needsMoreWaiting) {
      return { 
        success: false, 
        error: `Login still processing after ${waitAttempts * 2.5} seconds - authentication server may be slow`, 
        nextStep: currentStep 
      };
    }
    
    if (!loginSuccessful) {
      const errorMessage = finalObservation.hasErrors ? 
        finalObservation.errors.join(', ') : 
        'Still on login page after submission with no processing indicators';
      return { success: false, error: errorMessage, nextStep: currentStep };
    }
    
    return { success: true, nextStep: currentStep };
    
  } catch (error: any) {
    return { success: false, error: error.message, nextStep: currentStep };
  }
};

// Observational search with verification
const performObservationalSearch = async (
  page: Page, 
  searchTerm: string, 
  startStep: number, 
  actionsTaken: any[], 
  screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>
): Promise<{success: boolean, error?: string, nextStep: number}> => {
  
  let currentStep = startStep;
  
  try {
    // First observe if search functionality is available
    const preSearchObservation = await observePage(page, 'before_search');
    
    if (!preSearchObservation.hasSearchForm) {
      return { success: false, error: 'No search functionality found on page', nextStep: currentStep };
    }
    
    currentStep++;
    console.log(`Step ${currentStep}: Performing search for "${searchTerm}"`);
    
    const searchField = page.locator('input[type="search"], input[name="search"], input[placeholder*="search" i]').first();
    await searchField.waitFor({ state: 'visible', timeout: 5000 });
    
    await searchField.click();
    await searchField.clear();
    await searchField.fill(searchTerm);
    await page.keyboard.press('Enter');
    
    // Wait for search results and observe
    await page.waitForTimeout(3000);
    
    const searchObservation = await observePage(page, 'after_search');
    const searchScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-search-results`, screenshots);
    
    actionsTaken.push({
      step: currentStep,
      action: `Search for: ${searchTerm}`,
      observation: searchObservation.summary,
      decision: 'Search completed, results should be visible',
      screenshot: searchScreenshot,
    });
    
    return { success: true, nextStep: currentStep };
    
  } catch (error: any) {
    return { success: false, error: error.message, nextStep: currentStep };
  }
};

// Capture and store screenshot
const captureAndStoreScreenshot = async (page: Page, name: string, screenshots: Array<{name: string, s3Url: string, description: string, timestamp: string}>): Promise<string> => {
  try {
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const s3Url = await saveScreenshotToS3(screenshot, name, `Screenshot: ${name}`);
    screenshots.push({
        name,
        s3Url, 
        description: `Screenshot: ${name}`,
        timestamp: new Date().toISOString(),
      })
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


// Agent with observational capabilities and visual decision making
const observationalBrowserAgent = new Agent({
  name: 'Observational Browser Agent',
  instructions: `
    You are an observational browser automation assistant that can SEE and ANALYZE what happens on web pages, 
    just like how you analyze web search results. You make decisions based on what you actually observe, 
    not assumptions about what should have happened.
    
    ## Core Principle: OBSERVE THEN DECIDE
    
    After each action, you will receive:
    1. **Screenshot** - Visual evidence of the current page state
    2. **Page Analysis** - Detailed breakdown of what's on the page
    3. **Error Detection** - Any error messages or issues found
    4. **Success Indicators** - Evidence of successful actions
    
    ## Your Process:
    
    ### 1. EXECUTE Action
    Perform the requested browser action (navigate, fill form, click, etc.)
    
    ### 2. OBSERVE Result  
    Analyze the screenshot and page state to understand what actually happened:
    - Are we still on the same page?
    - Did any error messages appear?
    - Did the action have the expected effect?
    - What is the current state of form fields?
    - Does something appear to be loading?
    
    ### 3. DECIDE Next Step
    Based on your observation, decide:
    - Was the action successful?
    - Should we retry with a different approach?
    - Should we proceed to the next step?
    - Should we abort due to errors?
    - Should we wait, take another screenshot, and analyze again? (if content appears to be loading)
    
    ### 4. REPORT Findings
    Clearly communicate what you observed and why you made each decision.
    
    ## Example Decision Making:
    
    **Scenario**: Attempting to log in
    
    **Action**: Fill email field with credentials
    **Observation**: Screenshot shows red error "Please enter a valid email address"
    **Decision**: Email entry failed, need to retry or use different format
    **Next Action**: Try different email format or report login failure
    
    vs.
    
    **Action**: Fill email field with credentials  
    **Observation**: Screenshot shows field filled correctly, no errors
    **Decision**: Email entry successful, proceed to password
    **Next Action**: Fill password field
    
    ## Login Success Verification:
    
    **NEVER assume login succeeded just because you clicked submit.**
    
    Always verify by checking:
    - Are we still on a login page? (URL contains 'login', 'auth', or 'signin')
    - Are there any error messages visible?
    - Did the page title or content change to indicate success?
    - Are we now on a dashboard or main application page?
    - Does some content appear to be loading (loading spinner, loading related text, loading skeleton)
    
    ## Search Success Verification:
    
    **NEVER assume search succeeded just because you pressed Enter.**
    
    Always verify by checking:
    - Did the page content change?
    - Are search results visible?
    - Is there a "no results" message?
    - Did the URL change to include search parameters?
    
    ## Response Format:
    
    For each major step, report:
    
    **🎯 Action Taken**: [What you did]
    **👁️ Observation**: [What you saw in the screenshot/page analysis]  
    **🧠 Decision**: [What you decided based on the observation]
    **➡️ Next Step**: [What you'll do next]
    
    ## Final Assessment:
    
    **✅ SUCCESS CRITERIA**:
    - Login: Successfully reached a non-login page without errors
    - Search: Search results are visible or clear "no results" message
    - Navigation: Reached the intended page
    
    **❌ FAILURE INDICATORS**:
    - Still on login page after submission
    - Error messages present
    - Unexpected page state
    - Unable to complete requested actions
    
    ## Key Principle:
    **Trust what you observe, not what you expected to happen.**
    
    If you see error messages, acknowledge them.
    If you're still on a login page, admit the login failed.
    If search results aren't visible, don't claim the search succeeded.
    
    Be honest about what you can actually see and accomplish.

    You have access to the enhancedObservationalBrowserTool, screenshotTool, and pageAnalysisTool to assist you.
  `,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { enhancedObservationalBrowserTool, screenshotTool, pageAnalysisTool},
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

    const result = await observationalBrowserAgent.generate(event.input, {
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