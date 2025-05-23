# Mastra AI Lambda Implementation

This repo uses the Mastra AI Weather example code, transformed to run serverless in a Lambda function.

It does not build Mastra, or use their server or API. A simple API gateway has been provided as an example.

Due to my inability to figure out their interoperability between CJS and ESM modules, a `fix-compilation.cjs` runs after the compiler and transforms imports that end in `/index` and files to `.mjs`.

## Storage

It uses DynamoDB for Mastras storage engine. 

## Installation Requirements

In your github repo / fork, configure the following environment secrets:

- `AWS_ACCOUNT_ID`
- `AWS_ACCESS_KEY`
- `AWS_SECRET_ACCESS_KEY`
- `ANTHROPIC_API_KEY`
