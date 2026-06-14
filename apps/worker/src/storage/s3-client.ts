import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { config } from '../config.js';

const s3 = new S3Client({
  endpoint: config.s3Endpoint,
  region: 'us-east-1', // MinIO requires a region but ignores it
  credentials: {
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
  },
  forcePathStyle: true, // Required for MinIO
});

/**
 * Download an attachment from S3/MinIO by its storage key.
 * Returns the file contents as a Buffer.
 */
export async function downloadAttachment(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
  });

  const response = await s3.send(command);

  if (!response.Body) {
    throw new Error(`S3 response body is empty for key: ${key}`);
  }

  // response.Body can be a Readable stream in Node.js
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks);
}
