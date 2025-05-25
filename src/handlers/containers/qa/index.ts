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

// Observational browser agent that analyzes page state after each action
const observationalBrowserTool = createTool({
  id: 'observational-browser-automation',
  description: 'Browser automation with visual feedback and decision-making at each step',
  inputSchema: z.object({
    url: z.string().describe('URL to navigate to'),
    credentials: z.object({
      username: z.string(),
      password: z.string(),
    }).optional().describe('Login credentials if needed'),
    searchTerm: z.string().optional().describe('Term to search for'),
    objective: z.string().describe('What we are trying to accomplish'),
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
    screenshots: z.array(z.string()),
    errors: z.array(z.string()),
    executionTime: z.number(),
  }),
  execute: async ({ context }): Promise<any> => {
    console.log(`Starting observational browser automation for: ${context.objective}`);
    return await performObservationalAutomation(context);
  },
});

// Main observational automation function
const performObservationalAutomation = async (context: any): Promise<any> => {
  let browser: Browser | null = null;
  const startTime = Date.now();
  const actionsTaken: Array<{step: number, action: string, observation: string, decision: string, screenshot?: string}> = [];
  const screenshots: string[] = [];
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

    const page: Page = await browser.newPage({
      viewport: { width: 1280, height: 720 }
    });

    // Step 1: Navigate to URL
    currentStep++;
    console.log(`Step ${currentStep}: Navigating to ${context.url}`);
    
    await page.goto(context.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Observe the page after navigation
    const initialObservation = await observePage(page, 'after_navigation');
    const initialScreenshot = await captureAndStoreScreenshot(page, `step-${currentStep}-navigation`, screenshots);
    
    actionsTaken.push({
      step: currentStep,
      action: `Navigate to ${context.url}`,
      observation: initialObservation.summary,
      decision: 'Proceeding based on page analysis',
      screenshot: initialScreenshot,
    });

    console.log(`Initial Observation: ${initialObservation.summary}`);

    result.finalUrl = page.url();
    result.pageTitle = await page.title();

    // Step 2: Handle login if credentials provided
    if (context.credentials && initialObservation.hasLoginForm) {
      currentStep++;
      console.log(`Step ${currentStep}: Attempting login`);
      
      const loginResult = await performObservationalLogin(page, context.credentials, currentStep, actionsTaken, screenshots);
      
      if (!loginResult.success) {
        errors.push(`Login failed: ${loginResult.error}`);
        result.success = false;
        result.finalObservation = `Login failed: ${loginResult.error}`;
        result.actionsTaken = actionsTaken;
        result.screenshots = screenshots;
        result.errors = errors;
        return result;
      }
      
      currentStep = loginResult.nextStep;
    }

    // Step 3: Handle search if search term provided
    if (context.searchTerm) {
      currentStep++;
      console.log(`Step ${currentStep}: Attempting search for "${context.searchTerm}"`);
      
      const searchResult = await performObservationalSearch(page, context.searchTerm, currentStep, actionsTaken, screenshots);
      
      if (!searchResult.success) {
        errors.push(`Search failed: ${searchResult.error}`);
      }
      
      currentStep = searchResult.nextStep;
    }

    // Final observation
    const finalObservation = await observePage(page, 'final_state');
    const finalScreenshot = await captureAndStoreScreenshot(page, 'final-state', screenshots);

    screenshots.push(finalScreenshot);
    
    result.finalObservation = finalObservation.summary;
    result.success = errors.length === 0 && !finalObservation.hasErrors;
    result.actionsTaken = actionsTaken;
    result.screenshots = screenshots;
    result.errors = errors;
    result.finalUrl = page.url();
    result.pageTitle = await page.title();

    await browser.close();

    return result;

  } catch (error: any) {
    console.error('Observational automation failed:', error);
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
  screenshots: string[]
): Promise<{success: boolean, error?: string, nextStep: number}> => {
  
  let currentStep = startStep;
  
  try {
    // Fill email field (same as before)
    console.log(`Step ${currentStep}: Filling email field`);
    
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
  screenshots: string[]
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
const captureAndStoreScreenshot = async (page: Page, name: string, screenshots: string[]): Promise<string> => {
  try {
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const s3Url = await saveScreenshotToS3(screenshot, name, `Screenshot: ${name}`);
    screenshots.push(s3Url);
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
    
    ### 3. DECIDE Next Step
    Based on your observation, decide:
    - Was the action successful?
    - Should we retry with a different approach?
    - Should we proceed to the next step?
    - Should we abort due to errors?
    
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
  `,
  model: anthropic('claude-4-sonnet-20250514'),
  tools: { observationalBrowserTool },
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