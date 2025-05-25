// src/handlers/containers/browser_automation/utils.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: process.env.REGION || process.env.AWS_REGION,
});

// Utility function to save screenshots
export const saveScreenshotToS3 = async (
  screenshot: Buffer,
  name: string,
  description: string
): Promise<string> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${name}-${timestamp}.png`;
    const key = `browser_automation/${process.env.JOB_ID || "unknown"}/${filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.RESULTS_BUCKET!,
        Key: key,
        Body: screenshot,
        ContentType: "image/png",
        Metadata: {
          screenshotName: name,
          description: description.substring(0, 1000),
          timestamp,
          jobId: process.env.JOB_ID || "unknown",
        },
      })
    );

    const s3Url = `s3://${process.env.RESULTS_BUCKET}/${key}`;
    return s3Url;
  } catch (error: any) {
    console.error("Error saving screenshot:", error);
    throw error;
  }
};