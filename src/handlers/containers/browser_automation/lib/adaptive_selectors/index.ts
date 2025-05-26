import { Page } from "playwright-core";

export interface ElementSearchResult {
  selector: string;
  found: boolean;
  count: number;
  workingSelector?: string;
}

const userSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[id="email"]',
        'input[name*="email"]',
        'input[id*="email"]',
        'input[placeholder*="email" i]',
        'input[aria-label*="email" i]',
        'input[class*="email"]',
        'input[name="user"]',
        'input[name="username"]',
        'input[name="login"]',
        ];

export class AdaptiveSelectorEngine {
  // Common patterns for different input types
  private static readonly SELECTOR_PATTERNS = {
    email: userSelectors,
    username: userSelectors,
    password: [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]',
      'input[name*="pass"]',
      'input[id*="pass"]',
      'input[placeholder*="password" i]',
      'input[aria-label*="password" i]',
    ],
    search: [
      'input[type="search"]',
      'input[name="search"]',
      'input[id="search"]',
      'input[name="q"]',
      'input[name="query"]',
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
      'input[class*="search"]',
      "#search",
      ".search-input",
      '[role="searchbox"]',
    ],
    submit: [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("submit")',
      'button:has-text("login")',
      'button:has-text("sign in")',
      'button:has-text("log in")',
      'button:has-text("continue")',
      'button[class*="submit"]',
      'button[class*="login"]',
      ".submit-btn",
      ".login-btn",
    ],
  };

  static async findBestSelector(
    page: Page,
    originalSelector: string,
    elementType?: "email" | "password" | "search" | "submit"
  ): Promise<ElementSearchResult> {
    // First try the original selector
    try {
      const originalElements = await page.locator(originalSelector).all();
      if (originalElements.length > 0) {
        return {
          selector: originalSelector,
          found: true,
          count: originalElements.length,
          workingSelector: originalSelector,
        };
      }
    } catch (e) {
      console.log(`Original selector failed: ${originalSelector}`);
    }

    // If original failed and we know the element type, try common patterns
    if (elementType && this.SELECTOR_PATTERNS[elementType]) {
      for (const pattern of this.SELECTOR_PATTERNS[elementType]) {
        try {
          const elements = await page.locator(pattern).all();
          if (elements.length > 0) {
            console.log(
              `✅ Found working selector: ${pattern} (${elements.length} elements)`
            );
            return {
              selector: originalSelector,
              found: true,
              count: elements.length,
              workingSelector: pattern,
            };
          }
        } catch (e) {
          // Continue trying other patterns
        }
      }
    }

    // If still no luck, try generic variations of the original selector
    const variations = this.generateSelectorVariations(originalSelector);
    for (const variation of variations) {
      try {
        const elements = await page.locator(variation).all();
        if (elements.length > 0) {
          console.log(`✅ Found working variation: ${variation}`);
          return {
            selector: originalSelector,
            found: true,
            count: elements.length,
            workingSelector: variation,
          };
        }
      } catch (e) {
        // Continue trying
      }
    }

    return {
      selector: originalSelector,
      found: false,
      count: 0,
    };
  }

  private static generateSelectorVariations(selector: string): string[] {
    const variations: string[] = [];

    // Remove quotes variations
    variations.push(selector.replace(/'/g, '"'));
    variations.push(selector.replace(/"/g, "'"));
    variations.push(selector.replace(/['"]/g, ""));

    // Case insensitive attribute matching
    if (selector.includes("=")) {
      const caseInsensitive = selector.replace(/=("[^"]*"|'[^']*')/, "=$1 i");
      variations.push(caseInsensitive);
    }

    // Partial matching variations
    if (selector.includes("name=")) {
      const partial = selector.replace(/name="([^"]*)"/, 'name*="$1"');
      variations.push(partial);
    }
    if (selector.includes("id=")) {
      const partial = selector.replace(/id="([^"]*)"/, 'id*="$1"');
      variations.push(partial);
    }

    return [...new Set(variations)]; // Remove duplicates
  }

  // Smart form field detection
  static async detectFormStructure(page: Page): Promise<{
    emailField?: string;
    passwordField?: string;
    submitButton?: string;
    allInputs: Array<{
      selector: string;
      type: string;
      name?: string;
      placeholder?: string;
    }>;
  }> {
    const structure = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map(
        (input, i) => ({
          selector: `input:nth-child(${i + 1})`,
          type: input.type || "text",
          name: input.name || "",
          placeholder: input.placeholder || "",
          id: input.id || "",
        })
      );

      return { inputs };
    });

    const result: any = { allInputs: structure.inputs };

    // Find email field
    for (const pattern of this.SELECTOR_PATTERNS.email) {
      try {
        const elements = await page.locator(pattern).all();
        if (elements.length > 0) {
          result.emailField = pattern;
          break;
        }
      } catch (e) {}
    }

    // Find password field
    for (const pattern of this.SELECTOR_PATTERNS.password) {
      try {
        const elements = await page.locator(pattern).all();
        if (elements.length > 0) {
          result.passwordField = pattern;
          break;
        }
      } catch (e) {}
    }

    // Find submit button
    for (const pattern of this.SELECTOR_PATTERNS.submit) {
      try {
        const elements = await page.locator(pattern).all();
        if (elements.length > 0) {
          result.submitButton = pattern;
          break;
        }
      } catch (e) {}
    }

    return result;
  }
}
