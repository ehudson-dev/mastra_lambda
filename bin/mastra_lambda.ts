#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MastraLambdaStack } from '../lib/mastra_lambda-stack';

const MastraLambdaApp = new cdk.App();

export const anthropic_api_key = MastraLambdaApp.node.tryGetContext('anthropic_api_key');
export const pinecone_api_key = MastraLambdaApp.node.tryGetContext('pinecone_api_key');

new MastraLambdaStack(MastraLambdaApp, `MastraLambda`, {});
