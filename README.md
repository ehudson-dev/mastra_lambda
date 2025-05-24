# Mastra AI Lambda Implementation

This repo uses the Mastra AI Library & CDK to deploy serverless Claude agents with the aim of doing dynamic QA on web applications.

It does not build Mastra, or use their server or API.

Due to my inability to figure out their interoperability between CJS and ESM modules, a `fix-compilation.cjs` runs after the compiler and transforms imports that end in `/index` and files to `.mjs`.

## Storage

It uses DynamoDB for Mastras storage engine. 

## Installation Requirements

In your github repo / fork, configure the following environment secrets:

- `AWS_ACCOUNT_ID`
- `AWS_ACCESS_KEY`
- `AWS_SECRET_ACCESS_KEY`
- `ANTHROPIC_API_KEY`
