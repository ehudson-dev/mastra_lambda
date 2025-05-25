// src/handlers/containers/browser_automation/rate-limiting.ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { RateLimitState } from "../../types";

let currentRateLimit: RateLimitState | null = null;

// Custom fetch with dynamic rate limiting
export const createRateLimitingFetch = (originalFetch = fetch) => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    
    // Only apply rate limiting to Anthropic API calls
    if (!url.includes('api.anthropic.com')) {
      return originalFetch(input, init);
    }

    // Check if we need to wait based on current rate limit state
    if (currentRateLimit) {
      await checkAndWaitForRateLimit();
    }

    console.log(`🌐 Making Anthropic API call at ${new Date().toISOString()}`);
    
    try {
      // Make the actual API call
      const response = await originalFetch(input, init);

      //log anthropic headers in cloudwatch
      let headers = {} as any;
      response.headers.forEach((value: string, key: string) =>{
        headers[key] = value;
      })
      console.log(`Anthropic Response Headers: \n ${JSON.stringify(headers)}`)

      // Extract and update rate limit information from response headers
      updateRateLimitFromHeaders(response.headers);
      
      // Log current rate limit status
      logRateLimitStatus();
      
      return response;
      
    } catch (error: any) {
      console.error('❌ API call failed:', error.message);
      
      // If it's a rate limit error despite our protection, add penalty delay
      if (error.message?.includes('rate limit')) {
        console.log('🚨 Rate limit hit despite protection - adding penalty delay');
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60s penalty
      }
      
      throw error;
    }
  };
};

// Check current rate limit and wait if necessary
const checkAndWaitForRateLimit = async (): Promise<void> => {
  if (!currentRateLimit) return;

  const now = new Date();
  const { inputTokensRemaining, inputTokensReset, requestsRemaining, requestsReset } = currentRateLimit;

  // Check if rate limit has naturally reset
  if (now >= inputTokensReset) {
    console.log('✅ Rate limit window has reset naturally');
    currentRateLimit = null;
    return;
  }

  // Calculate minimum tokens needed for next call (estimated)
  const MIN_TOKENS_NEEDED = 6000; // Conservative estimate based on your logs
  const MIN_REQUESTS_NEEDED = 1;

  // Check input tokens
  if (inputTokensRemaining < MIN_TOKENS_NEEDED) {
    const waitTimeMs = inputTokensReset.getTime() - now.getTime();
    console.log(`🚦 INPUT TOKENS LOW: ${inputTokensRemaining}/${currentRateLimit.inputTokensLimit} remaining`);
    console.log(`⏰ Waiting ${Math.round(waitTimeMs / 1000)}s until reset at ${inputTokensReset.toISOString()}`);
    
    if (waitTimeMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTimeMs + 1000)); // +1s buffer
    }
    return;
  }

  // Check request count
  if (requestsRemaining < MIN_REQUESTS_NEEDED) {
    const waitTimeMs = requestsReset.getTime() - now.getTime();
    console.log(`🚦 REQUESTS LOW: ${requestsRemaining}/${currentRateLimit.requestsLimit} remaining`);
    console.log(`⏰ Waiting ${Math.round(waitTimeMs / 1000)}s until reset at ${requestsReset.toISOString()}`);
    
    if (waitTimeMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTimeMs + 1000)); // +1s buffer
    }
    return;
  }

  // Adaptive delay based on remaining tokens
  if (inputTokensRemaining < 8000) { // Less than 40% remaining
    const delayMs = Math.max(5000, (8000 - inputTokensRemaining) * 2); // Scale delay
    console.log(`⚡ ADAPTIVE DELAY: ${inputTokensRemaining} tokens remaining, waiting ${delayMs}ms`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
};

// Extract rate limit info from response headers
const updateRateLimitFromHeaders = (headers: Headers): void => {
  try {
    const inputTokensRemaining = parseInt(headers.get('anthropic-ratelimit-input-tokens-remaining') || '0');
    const inputTokensLimit = parseInt(headers.get('anthropic-ratelimit-input-tokens-limit') || '20000');
    const inputTokensResetStr = headers.get('anthropic-ratelimit-input-tokens-reset');
    
    const requestsRemaining = parseInt(headers.get('anthropic-ratelimit-requests-remaining') || '0');
    const requestsLimit = parseInt(headers.get('anthropic-ratelimit-requests-limit') || '50');
    const requestsResetStr = headers.get('anthropic-ratelimit-requests-reset');

    if (inputTokensResetStr && requestsResetStr) {
      currentRateLimit = {
        inputTokensRemaining,
        inputTokensLimit,
        inputTokensReset: new Date(inputTokensResetStr),
        requestsRemaining,
        requestsLimit,
        requestsReset: new Date(requestsResetStr),
        lastUpdated: new Date(),
      };
    }
  } catch (error) {
    console.error('Error parsing rate limit headers:', error);
  }
};

// Log current rate limit status
const logRateLimitStatus = (): void => {
  if (!currentRateLimit) {
    console.log('📊 Rate Limit Status: No data available');
    return;
  }

  const { inputTokensRemaining, inputTokensLimit, requestsRemaining, requestsLimit } = currentRateLimit;
  const tokenPercentage = Math.round((inputTokensRemaining / inputTokensLimit) * 100);
  const requestPercentage = Math.round((requestsRemaining / requestsLimit) * 100);

  console.log(`📊 Rate Limit Status:`);
  console.log(`   🎯 Input Tokens: ${inputTokensRemaining}/${inputTokensLimit} (${tokenPercentage}%)`);
  console.log(`   📞 Requests: ${requestsRemaining}/${requestsLimit} (${requestPercentage}%)`);
  
  if (tokenPercentage < 25) {
    console.log(`   ⚠️  WARNING: Low token availability`);
  }
  
  if (currentRateLimit.inputTokensReset) {
    const resetIn = Math.round((currentRateLimit.inputTokensReset.getTime() - Date.now()) / 1000);
    console.log(`   ⏰ Resets in: ${resetIn}s`);
  }
};

export const createRateLimitedAnthropic = () => {
  const customFetch = createRateLimitingFetch();
  
  return createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    headers: {
      'anthropic-beta': 'token-efficient-tools-2025-02-19'
    },
    fetch: customFetch,
  });
};