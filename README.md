# Mastra AI Serverless Implementation

A serverless AI agent system built with [Mastra.ai](https://mastra.ai) and AWS CDK. This implementation provides scalable, container-based AI agents that can perform complex browser automation, API interactions, and other AI-powered tasks.

> **Note**: This repo implements Mastra.ai as a serverless solution using AWS infrastructure. It does not build Mastra itself or use their hosted server/API.

## Architecture Overview

- **API Gateway**: RESTful endpoints for job management
- **Lambda Functions**: Containerized AI agents with specialized tools
- **SQS**: Asynchronous job queue for long-running tasks
- **DynamoDB**: Agent memory and conversation storage
- **S3**: Results storage and screenshot management
- **Rate Limiting**: Intelligent Anthropic API usage management

## Key Features

- 🚀 **Serverless & Scalable**: AWS Lambda containers with automatic scaling
- 🤖 **Multiple Agent Types**: Direct agents and background container jobs
- 🌐 **Browser Automation**: Full Playwright integration with screenshot capture
- ⚡ **Async Processing**: SQS-based job queue for long-running tasks
- 💾 **Persistent Memory**: DynamoDB-backed conversation history
- 🔄 **Rate Limiting**: Smart Anthropic API usage with header-based limits
- 📊 **Job Tracking**: Complete job lifecycle management with status API

## API Usage

### Starting Jobs

**Endpoint**: `POST /api/job/start`

#### Background Container Jobs (Recommended for complex tasks)

For browser automation, web scraping, or other long-running tasks:

```json
{
  "container": "browser_automation",
  "prompt": "Navigate to github.com, search for 'mastra', and take a screenshot of the first repository result",
  "thread_id": "optional-thread-id"
}
```

**Response**:
```json
{
  "jobId": "uuid-generated-job-id",
  "status": "queued",
  "containerName": "browser_automation",
  "checkStatusUrl": "/api/job/uuid-generated-job-id",
  "timestamp": "2025-01-XX..."
}
```

**Available Containers**:
- `browser_automation` - Full browser automation with Playwright

#### Direct Agent Invocation (For simple, fast responses)

For quick tasks (under 30 seconds, the API gateway maximum timeout), there is an example agent (the mastra.ai weather agent example) that can be invoked in a direct request/response model:

```json
{
  "agent": "weatherAgent", 
  "prompt": "What's the weather in Seattle?",
  "thread_id": "optional-thread-id"
}
```

**Response**:
```json
{
  "thread_id": "uuid-thread-id",
  "text": "The current weather in Seattle is...",
  "toolResults": [...],
  "usage": {...}
}
```

### Checking Job Status

**Endpoint**: `GET /api/job/{job_id}`

**Response**:
```json
{
  "jobId": "uuid-job-id",
  "status": "completed", // queued | processing | completed | failed
  "containerName": "browser_automation",
  "submittedAt": "2025-01-XX...",
  "completedAt": "2025-01-XX...",
  "processingTime": 45000,
  "result": {
    "text": "I successfully navigated to GitHub...",
    "toolResults": [...],
    "screenshots": ["s3://bucket/path/screenshot.png"]
  }
}
```

## Browser Automation Capabilities

The `browser_automation` container supports complex web interactions:

```json
{
  "container": "browser_automation",
  "prompt": "Go to example.com, fill out the contact form with name 'John Doe' and email 'john@example.com', submit it, and take a screenshot of the confirmation page"
}
```

**Supported Actions**:
- Navigation and page analysis
- Form filling and submission  
- Element finding and interaction
- Screenshot capture with S3 storage
- JavaScript execution in page context
- Multi-step workflows with memory

## Installation & Deployment

### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 20.x or higher
- Docker (for container builds)

### Environment Setup

Configure these secrets in your GitHub repository or deployment environment:

```bash
# Required AWS Configuration
AWS_ACCOUNT_ID=your-aws-account-id
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# Required API Keys  
ANTHROPIC_API_KEY=your-anthropic-api-key

# Optional
PINECONE_API_KEY=your-pinecone-key  # For future vector storage
```

### Deploy to AWS

```bash
# Install dependencies
npm install
cd src/dependencies/nodejs && npm install && cd -

# Build and deploy
npm run build
npm run cdk deploy -- -c anthropic_api_key=$ANTHROPIC_API_KEY
```

### Local Development

```bash
# Install dependencies
npm install
cd src/dependencies/nodejs && npm install

# Build TypeScript
npm run build

# Deploy with CDK
cdk deploy -c anthropic_api_key=$ANTHROPIC_API_KEY
```

## Rate Limiting & Performance

- **Intelligent Rate Limiting**: Monitors Anthropic API headers and proactively manages usage
- **Container Optimization**: Playwright containers optimized for Lambda environment
- **Memory Management**: Automatic browser cleanup and resource management
- **Cost Efficient**: Pay-per-use Lambda pricing with automatic scaling

## Differences from Standard Mastra

This implementation differs from standard Mastra.ai usage by:

- **Serverless Architecture**: No persistent servers, scales to zero
- **Container-based Tools**: Heavy workloads run in Lambda containers
- **Async Job Processing**: Long-running tasks processed via SQS
- **AWS-native Storage**: Uses DynamoDB and S3 instead of traditional databases
- **Fault Tolerant**: Includes rate limiting, error handling, and monitoring

# Browser Automation Module

This directory contains a modular browser automation system built with Mastra.ai and Playwright, designed to run in AWS Lambda containers.

## Directory Structure

```
src/handlers/containers/browser_automation/
├── index.ts                                  # Main Lambda handler
├── agent/                                    # Browser automation agent
│   └── index.ts                              # Agent setup and configuration
├── lib/                                      # Core library components
│   ├── anthropic/                            # Anthropic API integration
│   │   └── index.ts                          # Rate limiting and API client setup
│   ├── browser_context_manager/              # Browser lifecycle management
│   │   └── index.ts                          # Browser context singleton
│   └── utils/                                # Utility functions
│       └── index.ts                          # S3 screenshot storage utilities
├── tools/                                    # Individual browser automation tools
│   ├── execute_js/                           # JavaScript execution tool
│   │   └── index.ts
│   ├── fill_form/                            # Multi-field form filling tool
│   │   └── index.ts
│   ├── find_and_click/                       # Combined find + click tool
│   │   └── index.ts
│   ├── find_and_type/                        # Combined find + type tool
│   │   └── index.ts
│   ├── find_elements/                        # Element finding tool
│   │   └── index.ts
│   ├── navigate_and_analyze/                 # Navigation + page analysis tool
│   │   └── index.ts
│   ├── screenshot/                           # Screenshot capture tool
│   │   └── index.ts
│   └── wait/                                 # Wait/delay tool
│       └── index.ts
├── types.ts                                  # Shared TypeScript interfaces
├── package.json                              # Package dependencies
├── tsconfig.json                             # TypeScript configuration
└── Dockerfile                                # Container build configuration
```

## Key Components

### 1. Browser Context Manager (`/lib/browser_context_manager`)
- Singleton pattern for managing Playwright browser instances
- Automatic cleanup after 5 minutes of inactivity  
- Optimized for Lambda container environments
- Handles browser initialization with appropriate Chrome flags

### 2. Rate Limiting (`/lib/anthropic`)
- Intelligent Anthropic API rate limiting
- Monitors token usage and request counts from response headers
- Implements adaptive delays and proactive waiting
- Prevents rate limit violations that could cause job failures

### 3. Tools (`/tools`)
Each tool is designed for specific browser automation tasks:

- **Bundled Tools** (Preferred - reduce API calls):
  - `find-and-type` - Find input fields and type in one operation
  - `find-and-click` - Find clickable elements and click in one operation
  - `navigate-and-analyze` - Navigate to URL and analyze page structure
  - `fill-form` - Fill multiple form fields and optionally submit

- **Individual Tools** (Use sparingly):
  - `find-elements` - Find elements using CSS selectors
  - `wait` - Add delays for page loading
  - `screenshot` - Capture screenshots and store in S3
  - `execute-js` - Execute custom JavaScript in page context

### 4. Agent (`/agent`)
- Mastra Agent configured with specialized browser automation instructions
- Uses Claude 3-7 Sonnet because Claude 4 does not yet support the beta header `token-efficient-tools-2025-02-19`, if you don't care about this, you can use Claude 4
- Emphasizes bundled tools to reduce API calls
- Includes comprehensive CSS selector guidance

### 5. Main Handler (`index.ts`) 
- Lambda entry point
- Error handling and response formatting
- Environment setup for screenshot naming
- Browser cleanup management

## Usage

The module accepts natural language prompts for browser automation:

```json
{
  "input": "Go to example.com, fill out the contact form with test data, and take a screenshot",
  "thread_id": "optional-thread-id",
  "jobId": "unique-job-id"
}
```

## Development

### Building
```bash
npm run build
```

### Key Features
- **Modular Design**: Each component has a single responsibility
- **Type Safety**: Comprehensive TypeScript interfaces
- **Rate Limiting**: Intelligent API usage management  
- **Error Handling**: Robust error recovery at tool and agent levels
- **Resource Management**: Automatic browser cleanup
- **S3 Integration**: Screenshot storage with metadata

### CSS Selector Guidelines
The agent is trained to use standard CSS selectors only:

✅ **Valid**: `input[type="email"]`, `.class-name`, `#element-id`  
❌ **Invalid**: `:contains()`, `:visible`, `:eq()` (jQuery syntax)

### Adding New Tools
1. Create new tool file in `tools/` directory
2. Follow existing tool patterns with Zod schemas
3. Export from `tools/index.ts`
4. Add to agent configuration in `/agent/index.ts`

This modular structure makes the codebase maintainable, testable, and easy to extend with additional browser automation capabilities.