import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: process.env.REGION || process.env.AWS_REGION,
});

export const textUploadTool = createTool({
  id: "text_upload",
  description: "Upload arbitrary text content to S3 bucket as a text file",
  inputSchema: z.object({
    content: z.string().describe("The text content to upload"),
    filename: z.string().describe("Name for the text file (without extension)"),
    description: z
      .string()
      .optional()
      .describe("Optional description of the text content"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    s3Url: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }): Promise<any> => {
    try {
      console.log(`Uploading text file: ${context.filename}`);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${context.filename}-${timestamp}.txt`;
      const key = `text_uploads/${process.env.JOB_ID || "unknown"}/${filename}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.RESULTS_BUCKET!,
          Key: key,
          Body: context.content,
          ContentType: "text/plain",
          Metadata: {
            filename: context.filename,
            description: context.description?.substring(0, 1000) || "",
            timestamp,
            jobId: process.env.JOB_ID || "unknown",
          },
        })
      );

      const s3Url = `s3://${process.env.RESULTS_BUCKET}/${key}`;
      console.log(`Text file uploaded: ${s3Url}`);

      return {
        success: true,
        s3Url,
      };
    } catch (error: any) {
      console.error("Text upload failed:", error);
      return {
        success: false,
        error: error.message.substring(0, 100),
      };
    }
  },
});