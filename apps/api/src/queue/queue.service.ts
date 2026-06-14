import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { BULL_QUEUE } from '../bull/bull.module.js';
import type { CreateJobDto } from './dto/create-job.dto.js';
import type { QueueJob } from '@claude-queue/shared-types';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(BULL_QUEUE) private readonly queue: Queue,
  ) {}

  async createJob(dto: CreateJobDto) {
    // Verify the account exists
    const account = await this.prisma.account.findUnique({
      where: { id: dto.accountId },
    });

    if (!account) {
      throw new NotFoundException(`Account with id "${dto.accountId}" not found`);
    }

    // Upload attachments to S3/MinIO and collect metadata
    const attachmentRecords: Array<{
      storageKey: string;
      fileName: string;
      mimeType: string;
    }> = [];

    for (const attachment of dto.attachments) {
      const buffer = Buffer.from(attachment.fileBase64, 'base64');
      const storageKey = `attachments/${randomUUID()}/${attachment.fileName}`;

      await this.storage.upload(storageKey, buffer, attachment.mimeType);

      attachmentRecords.push({
        storageKey,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      });
    }

    // Create QueuedMessage + Attachment records in a transaction
    const message = await this.prisma.queuedMessage.create({
      data: {
        account_id: dto.accountId,
        conversation_id: dto.conversationId ?? null,
        prompt_text: dto.promptText,
        model_target: dto.modelTarget,
        thinking_mode: dto.thinkingMode,
        status: 'PENDING',
        scheduled_for: new Date(dto.scheduledFor),
        attachments: {
          create: attachmentRecords.map((a) => ({
            storage_key: a.storageKey,
            file_name: a.fileName,
            mime_type: a.mimeType,
          })),
        },
      },
      include: {
        attachments: true,
      },
    });

    // Calculate BullMQ delay from scheduledFor
    const scheduledMs = new Date(dto.scheduledFor).getTime();
    const nowMs = Date.now();
    const delayMs = Math.max(0, scheduledMs - nowMs);

    // Build the job payload using the shared-types schema shape
    const jobPayload: QueueJob = {
      jobId: message.id,
      accountId: dto.accountId,
      conversationId: dto.conversationId ?? null,
      modelTarget: dto.modelTarget,
      promptText: dto.promptText,
      thinkingMode: dto.thinkingMode,
      attachments: attachmentRecords.map((a) => ({
        storageKey: a.storageKey,
        fileName: a.fileName,
        mimeType: a.mimeType,
      })),
    };

    // Push to BullMQ
    await this.queue.add('process-message', jobPayload, {
      jobId: message.id,
      delay: delayMs,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    });

    this.logger.log(
      `Job ${message.id} created, scheduled in ${Math.round(delayMs / 1000)}s`,
    );

    return message;
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.queuedMessage.findMany({
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          attachments: true,
          account: {
            select: { id: true, account_name: true, status: true },
          },
        },
      }),
      this.prisma.queuedMessage.count(),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: string) {
    const message = await this.prisma.queuedMessage.findUnique({
      where: { id },
      include: {
        attachments: true,
        account: {
          select: { id: true, account_name: true, status: true },
        },
      },
    });

    if (!message) {
      throw new NotFoundException(`Job with id "${id}" not found`);
    }

    return message;
  }
}
