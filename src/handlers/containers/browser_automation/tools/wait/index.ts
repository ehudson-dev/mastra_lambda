import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../lib/browser_context_manager/index.js';

export const waitTool = createTool({
  id: "wait",
  description: "Wait for 10 seconds",
  outputSchema: z.object({
    success: z.boolean(),
    ms: z.number(), // Shortened from 'waited'
    error: z.string().optional(),
  }),
  execute: async (): Promise<any> => {
    try {
      const browserManager = BrowserContextManager.getInstance();
      const startTime = Date.now();

      await new Promise((resolve) => setTimeout(resolve, 10000));

      const ms = Date.now() - startTime;
      browserManager.updateActivity();
      console.log(`Wait completed in ${ms}ms`);

      return {
        success: true,
        ms,
      };
    } catch (error: any) {
      console.error("Wait failed:", error);
      return {
        success: false,
        ms: 0,
        error: error.message.substring(0, 80),
      };
    }
  },
});