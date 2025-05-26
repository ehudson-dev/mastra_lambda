import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';
import { AdaptiveSelectorEngine } from '../../lib/adaptive_selectors/index.js';

export const smartSearchTool = createTool({
  id: "smart-search",
  description: "Find search field, perform search, wait for results, and optionally take screenshot",
  inputSchema: z.object({
    query: z.string().describe("Search query to execute"),
    waitForResults: z.number().default(5000).describe("Ms to wait for search results"),
    takeScreenshot: z.boolean().default(false).describe("Take screenshot of results"),
    screenshotName: z.string().optional().describe("Name for screenshot if taken"),
    pressEnter: z.boolean().default(true).describe("Press Enter after typing"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    searchPerformed: z.boolean(),
    resultsAppeared: z.boolean(),
    screenshotTaken: z.boolean(),
    searchField: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`🔍 Smart search: "${context.query}"`);

      // Find search field using adaptive patterns
      const searchResult = await AdaptiveSelectorEngine.findBestSelector(
        page,
        'input[type="search"]',
        'search'
      );

      if (!searchResult.found) {
        return {
          success: false,
          searchPerformed: false,
          resultsAppeared: false,
          screenshotTaken: false,
          message: "Could not find search field",
        };
      }

      const searchSelector = searchResult.workingSelector || 'input[type="search"]';
      console.log(`🎯 Using search field: ${searchSelector}`);

      // Perform search
      const searchElement = page.locator(searchSelector).first();
      await searchElement.waitFor({ state: 'visible', timeout: 5000 });
      await searchElement.clear();
      await searchElement.fill(context.query);

      if (context.pressEnter) {
        await searchElement.press('Enter');
      }

      console.log(`✅ Search performed: "${context.query}"`);

      // Wait for results
      let resultsAppeared = false;
      if (context.waitForResults > 0) {
        console.log(`⏳ Waiting ${context.waitForResults}ms for results...`);
        await page.waitForTimeout(context.waitForResults);
        
        // Check if modal or results appeared
        try {
          const commonResultsSelectors = [
            '[role="dialog"]', '.modal', '.search-results',
            'table', '.results-table', '.MuiDialog-root'
          ];
          
          for (const selector of commonResultsSelectors) {
            const elements = await page.locator(selector).all();
            if (elements.length > 0) {
              resultsAppeared = true;
              console.log(`✅ Results container found: ${selector}`);
              break;
            }
          }
        } catch (e) {
          console.log('⚠️ Could not verify results appearance');
        }
      }

      // Optional screenshot
      let screenshotTaken = false;
      if (context.takeScreenshot && context.screenshotName) {
        try {
          await page.screenshot({
            path: `/tmp/${context.screenshotName}.png`,
            fullPage: true,
            type: 'png'
          });
          screenshotTaken = true;
          console.log(`📸 Screenshot taken: ${context.screenshotName}`);
        } catch (e) {
          console.log(`⚠️ Screenshot failed: ${e}`);
        }
      }

      browserManager.updateActivity();

      return {
        success: true,
        searchPerformed: true,
        resultsAppeared,
        screenshotTaken,
        searchField: searchSelector,
        message: `Search completed: "${context.query}" - Results: ${resultsAppeared ? 'appeared' : 'unknown'}`,
      };

    } catch (error: any) {
      console.error("Smart search failed:", error);
      return {
        success: false,
        searchPerformed: false,
        resultsAppeared: false,
        screenshotTaken: false,
        message: `Search failed: ${error.message}`,
      };
    }
  },
});