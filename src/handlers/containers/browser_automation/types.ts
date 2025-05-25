// src/handlers/containers/browser_automation/types.ts
export interface RateLimitState {
  inputTokensRemaining: number;
  inputTokensLimit: number;
  inputTokensReset: Date;
  requestsRemaining: number;
  requestsLimit: number;
  requestsReset: Date;
  lastUpdated: Date;
}

export interface ContainerResult {
  success: boolean;
  error?: any;
  data?: any;
  processingTime?: number;
  timestamp?: string;
  jobId?: string;
  containerName?: string;
  functionStatusCode?: number;
  logs?: any;
}