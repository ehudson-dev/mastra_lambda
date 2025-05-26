// src/handlers/containers/browser_automation/rate-limiting.ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { RateLimitState } from "../../types";

let currentRateLimit: RateLimitState | null = null;

// Custom fetch with dynamic rate limiting and retry logic
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

    // Retry logic for overloaded errors
    const maxRetries = 3;
    const retryDelays = [30000, 60000]; // 30s, 1min for first two retries
    
    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
      console.log(`🌐 Making Anthropic API call at ${new Date().toISOString()}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries - 1})` : ''}`);
      
      try {
        // Make the actual API call
        const response = await originalFetch(input, init);

        // Log anthropic headers in cloudwatch
        let headers = {} as any;
        response.headers.forEach((value: string, key: string) => {
          headers[key] = value;
        });
        console.log(`Anthropic Response Headers: \n ${JSON.stringify(headers)}`);

        // Check for overloaded error (529)
        if (response.status === 529) {
          const responseText = await response.text();
          console.log(`🚨 Anthropic API overloaded (529) - Response: ${responseText}`);
          
          // Check if this is specifically an overloaded error
          try {
            const errorData = JSON.parse(responseText);
            if (errorData?.error?.type === 'overloaded_error') {
              // If we've exhausted retries, throw the error
              if (retryCount >= maxRetries - 1) {
                console.error(`❌ Anthropic API overloaded after ${maxRetries} attempts - giving up`);
                throw new Error(`Anthropic API overloaded after ${maxRetries} attempts: ${errorData.error.message}`);
              }
              
              // Wait before retry
              const delay = retryDelays[retryCount];
              console.log(`⏰ Waiting ${delay/1000}s before retry ${retryCount + 1}/${maxRetries - 1}...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              
              // Continue to next retry iteration
              continue;
            }
          } catch (parseError) {
            console.error('Error parsing overloaded response:', parseError);
          }
        }

        // For successful responses or non-overloaded errors, extract rate limit info and return
        if (response.ok) {
          updateRateLimitFromHeaders(response.headers);
          logRateLimitStatus();
          return response;
        } else {
          // For other error types, don't retry - just handle rate limit info and throw
          updateRateLimitFromHeaders(response.headers);
          const errorText = await response.text();
          throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
        }
        
      } catch (error: any) {
        console.error(`❌ API call failed (attempt ${retryCount + 1}/${maxRetries}):`, error.message);
        
        // If it's an overloaded error that we're retrying, continue to retry logic
        if (error.message?.includes('Anthropic API overloaded after') && retryCount < maxRetries - 1) {
          continue;
        }
        
        // If it's a rate limit error despite our protection, add penalty delay
        if (error.message?.includes('rate limit')) {
          console.log('🚨 Rate limit hit despite protection - adding penalty delay');
          await new Promise(resolve => setTimeout(resolve, 60000)); // 60s penalty
        }
        
        // For the final retry or non-overloaded errors, throw immediately
        if (retryCount >= maxRetries - 1 || !error.message?.includes('overloaded')) {
          throw error;
        }
        
        // Wait before retry for other errors that might benefit from retry
        const delay = retryDelays[retryCount] || 60000;
        console.log(`⏰ Waiting ${delay/1000}s before retry due to error...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // This should never be reached, but just in case
    throw new Error('Unexpected end of retry loop');
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