import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
      forcePathStyle: true, // Required for MinIO
    });

    this.bucket = process.env.S3_BUCKET ?? 'claude-queue-attachments';
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const maxRetries = 5;
    const retryDelayMs = 3000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Bucket "${this.bucket}" already exists`);
        return;
      } catch (headErr: unknown) {
        const code = (headErr as { '$metadata'?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        // 404 means bucket doesn't exist — create it
        if (code === 404) {
          try {
            this.logger.log(`Creating bucket "${this.bucket}"...`);
            await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
            this.logger.log(`Bucket "${this.bucket}" created`);
            return;
          } catch (createErr) {
            const msg = createErr instanceof Error ? createErr.message : String(createErr);
            this.logger.error(`Failed to create bucket: ${msg}`);
          }
        } else {
          const msg = headErr instanceof Error ? headErr.message : String(headErr);
          this.logger.warn(`S3 unreachable (attempt ${attempt}/${maxRetries}): ${msg}`);
        }
      }

      if (attempt < maxRetries) {
        this.logger.log(`Retrying in ${retryDelayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    this.logger.warn(
      `Could not ensure bucket "${this.bucket}" after ${maxRetries} attempts. ` +
      `The API will start but S3 operations may fail until MinIO is ready.`,
    );
  }

  async upload(key: string, buffer: Buffer, mimeType: string): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    this.logger.debug(`Uploaded object: ${key}`);
    return key;
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    const stream = response.Body;
    if (!stream) {
      throw new Error(`Empty response body for key: ${key}`);
    }

    // Convert the readable stream to a Buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }
}
