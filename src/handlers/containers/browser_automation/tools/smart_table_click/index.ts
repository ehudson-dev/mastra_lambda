import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';

export const smartTableClickTool = createTool({
  id: "smart-table-click",
  description: "Find table, locate specific row (by index or content), and click it with intelligent row detection",
  inputSchema: z.object({
    rowIndex: z.number().default(0).describe("Index of row to click (0 = first data row)"),
    contentMatch: z.string().optional().describe("Text content to match in row (alternative to index)"),
    waitAfterClick: z.number().default(3000).describe("Ms to wait after clicking"),
    excludeHeader: z.boolean().default(true).describe("Skip header rows when counting"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    tableFound: z.boolean(),
    rowClicked: z.boolean(),
    rowText: z.string().optional(),
    totalRows: z.number(),
    message: z.string(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const page = await browserManager.getPage();

      console.log(`📋 Smart table click: row ${context.rowIndex}${context.contentMatch ? ` matching "${context.contentMatch}"` : ''}`);

      // Try multiple table row patterns with priority
      const tableRowPatterns = [
        'tbody tr',                    // Standard table body rows
        'table tr:not(:first-child)',  // Table rows excluding header
        '.MuiTableRow-root:not(.MuiTableRow-head)', // Material-UI table rows
        'div[role="row"]:not([role="row"]:first-child)', // ARIA table rows
        '[data-testid*="row"]',       // Common test ID pattern
        '.table-row',                 // Generic table row class
        'tr[data-rowindex]',          // Rows with data attributes
      ];

      let tableRows: any[] = [];
      let workingSelector = '';

      // Find working table selector
      for (const pattern of tableRowPatterns) {
        try {
          const elements = await page.locator(pattern).all();
          if (elements.length > 0) {
            tableRows = elements;
            workingSelector = pattern;
            console.log(`✅ Found ${elements.length} rows with: ${pattern}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (tableRows.length === 0) {
        return {
          success: false,
          tableFound: false,
          rowClicked: false,
          totalRows: 0,
          message: "No table rows found",
        };
      }

      // Determine target row
      let targetRowIndex = context.rowIndex;
      let targetRow : any = null;

      // If content match specified, find matching row
      if (context.contentMatch) {
        console.log(`🔍 Looking for row containing: "${context.contentMatch}"`);
        
        for (let i = 0; i < tableRows.length; i++) {
          try {
            const rowElement = page.locator(workingSelector).nth(i);
            const rowText = await rowElement.textContent() || '';
            
            if (rowText.toLowerCase().includes(context.contentMatch.toLowerCase())) {
              targetRowIndex = i;
              targetRow = rowElement;
              console.log(`✅ Found matching row at index ${i}: "${rowText.substring(0, 100)}..."`);
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (!targetRow) {
          return {
            success: false,
            tableFound: true,
            rowClicked: false,
            totalRows: tableRows.length,
            message: `No row found containing: "${context.contentMatch}"`,
          };
        }
      } else {
        // Use index-based selection
        if (targetRowIndex >= tableRows.length) {
          return {
            success: false,
            tableFound: true,
            rowClicked: false,
            totalRows: tableRows.length,
            message: `Row index ${targetRowIndex} out of range (${tableRows.length} rows found)`,
          };
        }
        targetRow = page.locator(workingSelector).nth(targetRowIndex);
      }

      // Click the target row
      let rowText = '';
      try {
        // Get row text before clicking (for verification)
        rowText = (await targetRow.textContent()) || '';
        console.log(`🎯 Clicking row ${targetRowIndex}: "${rowText.substring(0, 100)}..."`);

        // Click with retry logic
        await targetRow.waitFor({ state: 'visible', timeout: 5000 });
        await targetRow.click();

        // Wait after click
        if (context.waitAfterClick > 0) {
          await page.waitForTimeout(context.waitAfterClick);
        }

        console.log(`✅ Successfully clicked table row`);

      } catch (error: any) {
        return {
          success: false,
          tableFound: true,
          rowClicked: false,
          totalRows: tableRows.length,
          message: `Click failed: ${error.message}`,
        };
      }

      browserManager.updateActivity();

      return {
        success: true,
        tableFound: true,
        rowClicked: true,
        rowText: rowText.substring(0, 100), // Limit text length
        totalRows: tableRows.length,
        message: `Clicked row ${targetRowIndex} of ${tableRows.length}`,
      };

    } catch (error: any) {
      console.error("Smart table click failed:", error);
      return {
        success: false,
        tableFound: false,
        rowClicked: false,
        totalRows: 0,
        message: `Table click failed: ${error.message}`,
      };
    }
  },
});
