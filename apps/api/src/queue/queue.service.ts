import { Injectable, Logger, NotFoundException, ConflictException, Inject } from '@nestjs/common';
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

    // Resolve scheduled time: absolute timestamp or relative delay
    const scheduledFor = dto.scheduledFor
      ? new Date(dto.scheduledFor)
      : new Date(Date.now() + (dto.delaySeconds ?? 0) * 1000);

    // Create QueuedMessage + Attachment records in a transaction
    const message = await this.prisma.queuedMessage.create({
      data: {
        account_id: dto.accountId,
        conversation_id: dto.conversationId ?? null,
        prompt_text: dto.promptText,
        model_target: dto.modelTarget,
        thinking_mode: dto.thinkingMode,
        status: 'PENDING',
        scheduled_for: scheduledFor,
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

    // Calculate BullMQ delay from resolved scheduled time
    const delayMs = Math.max(0, scheduledFor.getTime() - Date.now());

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

  async findAll(
    page = 1,
    limit = 20,
    filters: { accountId?: string; status?: string } = {},
  ) {
    const skip = (page - 1) * limit;

    const where: { account_id?: string; status?: string } = {};
    if (filters.accountId) where.account_id = filters.accountId;
    if (filters.status) where.status = filters.status;

    const [items, total] = await Promise.all([
      this.prisma.queuedMessage.findMany({
        where,
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
      this.prisma.queuedMessage.count({ where }),
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

  async cancelJob(id: string) {
    const job = await this.prisma.queuedMessage.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job with id "${id}" not found`);
    }
    if (job.status !== 'PENDING') {
      throw new ConflictException('Job is no longer cancelable');
    }

    // Remove the delayed BullMQ job (added with jobId = message.id).
    try {
      const bull = await this.queue.getJob(id);
      if (bull) await bull.remove();
    } catch (err) {
      this.logger.warn(`BullMQ remove failed for ${id}: ${String(err)}`);
    }

    await this.prisma.queuedMessage.delete({ where: { id } });
    this.logger.log(`Job ${id} canceled and removed`);
    return { ok: true };
  }
}
