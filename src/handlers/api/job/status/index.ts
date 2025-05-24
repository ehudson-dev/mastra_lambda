// src/handlers/job-status/index.ts - Job status checker
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { HttpResponse } from "/opt/nodejs/utils/index";

const s3Client = new S3Client({
  region: process.env.REGION || process.env.AWS_REGION,
});

interface JobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'not_found';
  containerName?: string;
  submittedAt?: string;
  completedAt?: string;
  processingTime?: number;
  result?: any;
  error?: any;
  resultUrl?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Job Status Handler invoked:', JSON.stringify(event, null, 2));

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  try {
    const jobId = event.pathParameters?.job_id;
    
    if (!jobId) {
      return HttpResponse(400, {
        error: 'Missing job_id parameter',
        usage: 'GET /jobs/{job_id}',
      });
    }

    console.log(`Checking status for job: ${jobId}`);

    const jobStatus = await getJobStatus(jobId);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(jobStatus),
    };

  } catch (error: any) {
    console.error('Job status handler error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message,
        type: error.constructor?.name || 'Error',
        timestamp: new Date().toISOString(),
      }),
    };
  }
};

const getJobStatus = async (jobId: string): Promise<JobStatus> => {
  const bucketName = process.env.RESULTS_BUCKET!;
  
  try {
    // First, try to find the job result in S3 by searching for the jobId
    // Since we don't know the container name, we need to search
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: '', // Search all containers
      MaxKeys: 1000, // Reasonable limit
    });

    const listResponse = await s3Client.send(listCommand);
    
    if (!listResponse.Contents) {
      return {
        jobId,
        status: 'not_found',
      };
    }

    // Look for our job result file
    const jobResultKey = listResponse.Contents.find(obj => 
      obj.Key?.includes(`/${jobId}/result.json`)
    )?.Key;

    if (!jobResultKey) {
      // Job not found in results, might still be processing
      return {
        jobId,
        status: 'processing',
      };
    }

    // Found the result file, fetch it
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: jobResultKey,
    });

    const response = await s3Client.send(getCommand);
    
    if (!response.Body) {
      return {
        jobId,
        status: 'not_found',
      };
    }

    // Parse the job result
    const resultContent = await response.Body.transformToString();
    const jobResult = JSON.parse(resultContent);

    // Extract container name from the S3 key (format: containerName/jobId/result.json)
    const containerName = jobResultKey.split('/')[0];

    const jobStatus: JobStatus = {
      jobId,
      status: jobResult.result.success ? 'completed' : 'failed',
      containerName,
      submittedAt: jobResult.job.submittedAt,
      completedAt: jobResult.job.completedAt,
      processingTime: jobResult.job.processingTime,
      resultUrl: `s3://${bucketName}/${jobResultKey}`,
    };

    // Include result data if successful, error details if failed
    if (jobResult.result.success) {
      jobStatus.result = jobResult.result.data;
    } else {
      jobStatus.error = jobResult.result.error;
    }

    return jobStatus;

  } catch (error: any) {
    console.error(`Error getting job status for ${jobId}:`, error);
    
    if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
      // Job might still be queued or processing
      return {
        jobId,
        status: 'queued',
      };
    }
    
    throw error;
  }
};

// Additional helper function to get job result with full details
export const getJobResult = async (jobId: string, containerName: string): Promise<any> => {
  const bucketName = process.env.RESULTS_BUCKET!;
  const key = `${containerName}/${jobId}/result.json`;

  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    const response = await s3Client.send(getCommand);
    
    if (!response.Body) {
      throw new Error('Empty response body');
    }

    const resultContent = await response.Body.transformToString();
    return JSON.parse(resultContent);
    
  } catch (error: any) {
    console.error(`Error fetching job result for ${jobId}:`, error);
    throw error;
  }
};