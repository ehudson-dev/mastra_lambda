import { Mastra } from '@mastra/core/mastra';
import { DynamoDBStore } from "@mastra/dynamodb";
import { weatherAgent }  from './agents/weather/index';

export const mastra : Mastra = new Mastra({
  agents: { weatherAgent },
  storage: new DynamoDBStore({
    name: "dynamodb",
    config: {
      tableName: process.env.MASTRA_TABLE_NAME,
      region: process.env.REGION
    }
  }),
});
