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

If you want to directly invoke an agent (the only agent using this format is the example weather aget from mastra.ai):

```
{
    "agent": "weatherAgent",
    "prompt": "What's the weather in Seattle"
}

```

To check the status of a job:

`GET /api/job/{job_id}`


## Agents

### Browser Automation Agent

This agent runs in a containerized Lambda function. It uses claude to navigate the web and interact with web applications through a generic set of web tools.

Features:

- Adaptive rate limiting to avoid input token overconsumption
- Multi step web workflow support
- Outputs report and screenshots to S3

### Weather Agent

This is the example agent from mastra.ai. It is used here as an example how to have a directly invoked agent in a lambda function in a request/response model.

## Storage

It uses DynamoDB for Mastras storage engine. 

## Installation Requirements

In your github repo / fork, configure the following environment secrets:

- `AWS_ACCOUNT_ID`
- `AWS_ACCESS_KEY`
- `AWS_SECRET_ACCESS_KEY`
- `ANTHROPIC_API_KEY`
