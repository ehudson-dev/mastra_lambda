// src/handlers/containers/browser_automation/browser-context-manager.ts
import { chromium, Page, Browser, BrowserContext } from "playwright-core";

export class BrowserContextManager {
  private static instance: BrowserContextManager;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastActivity: number = Date.now();
  private readonly TIMEOUT_MS = 900000; // 15 minutes

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