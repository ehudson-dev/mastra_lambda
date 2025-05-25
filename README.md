# Mastra AI Lambda Implementation

This repo uses the Mastra AI Library & CDK to deploy serverless Claude agents with the aim of doing dynamic QA on web applications.

It does not build Mastra, or use their server or API.

## API

The api uses a format like:

`POST /api/job/start` - start a job

If you want to start a background job:

```
{
 "container": "browser_automation,
 "prompt": "go to google.com and search cats, provide a screenshot and summary of the results"
}

```

If you want to directly invoke an agent (the only agent using this format is the example weather agent from mastra.ai):

```
{
    "agent": "weatherAgent",
    "prompt": "What's the weather in Seattle"
}

```

To check the status of a job:

`GET /api/job/{job_id}`

## Storage

It uses DynamoDB for Mastras storage engine. 

## Installation Requirements

In your github repo / fork, configure the following environment secrets:

- `AWS_ACCOUNT_ID`
- `AWS_ACCESS_KEY`
- `AWS_SECRET_ACCESS_KEY`
- `ANTHROPIC_API_KEY`

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
- Uses Claude 3-7 Sonnet with efficiency-focused prompting
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