// src/handlers/containers/browser_automation/tools/wait.ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowserContextManager } from '../../browser_context_manager';

export const waitTool = createTool({
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