import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Delete,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { QueueService } from './queue.service.js';
import { CreateJobSchema } from './dto/create-job.dto.js';
import type { ZodError } from 'zod';

@Controller('jobs')
export class QueueController {
  private readonly logger = new Logger(QueueController.name);

  constructor(private readonly queueService: QueueService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createJob(@Body() body: unknown) {
    const parsed = CreateJobSchema.safeParse(body);

    if (!parsed.success) {
      const zodError = parsed.error as ZodError;
      this.logger.warn(`❌ Job validation failed: ${zodError.errors.map(e => e.message).join(', ')}`);
      throw new BadRequestException({
        message: 'Validation failed',
        errors: zodError.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    this.logger.log(`📝 Creating job for account ${parsed.data.accountId}`);
    this.logger.debug(`   Model: ${parsed.data.modelTarget}, Thinking: ${parsed.data.thinkingMode}`);
    this.logger.debug(`   Prompt: "${parsed.data.promptText.substring(0, 100)}${parsed.data.promptText.length > 100 ? '...' : ''}"`);
    this.logger.debug(`   Attachments: ${parsed.data.attachments.length}`);

    const job = await this.queueService.createJob(parsed.data);

    this.logger.log(`✅ Job ${job.id} created, status: ${job.status}`);

    return {
      id: job.id,
      accountId: job.account_id,
      conversationId: job.conversation_id,
      modelTarget: job.model_target,
      promptText: job.prompt_text,
      thinkingMode: job.thinking_mode,
      status: job.status,
      scheduledFor: job.scheduled_for.toISOString(),
      createdAt: job.created_at.toISOString(),
      attachments: job.attachments.map((a) => ({
        id: a.id,
        storageKey: a.storage_key,
        fileName: a.file_name,
        mimeType: a.mime_type,
      })),
    };
  }

  @Get()
  async listJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    if (isNaN(pageNum) || pageNum < 1) {
      throw new BadRequestException('page must be a positive integer');
    }
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    const ALLOWED = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
    if (status && !ALLOWED.includes(status)) {
      throw new BadRequestException(`status must be one of ${ALLOWED.join(', ')}`);
    }

    const result = await this.queueService.findAll(pageNum, limitNum, { accountId, status });

    this.logger.log(`📋 Listed ${result.items.length}/${result.total} jobs (page ${pageNum})`);

    return {
      ...result,
      items: result.items.map((job) => ({
        id: job.id,
        accountId: job.account_id,
        conversationId: job.conversation_id,
        modelTarget: job.model_target,
        promptText: job.prompt_text,
        thinkingMode: job.thinking_mode,
        status: job.status,
        scheduledFor: job.scheduled_for.toISOString(),
        createdAt: job.created_at.toISOString(),
        account: job.account,
        attachments: job.attachments.map((a) => ({
          id: a.id,
          storageKey: a.storage_key,
          fileName: a.file_name,
          mimeType: a.mime_type,
        })),
      })),
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelJob(
    @Param('id') id: string,
    @Query('accountId') accountId?: string,
  ) {
    this.logger.log(`🗑️  Canceling job ${id} (account: ${accountId ?? 'not provided'})`);
    return this.queueService.cancelJob(id, accountId);
  }

  @Get(':id')
  async getJob(@Param('id') id: string) {
    this.logger.log(`🔍 Getting job ${id}`);
    const job = await this.queueService.findById(id);

    this.logger.debug(`   Job ${id} status: ${job.status}`);

    return {
      id: job.id,
      accountId: job.account_id,
      conversationId: job.conversation_id,
      modelTarget: job.model_target,
      promptText: job.prompt_text,
      thinkingMode: job.thinking_mode,
      status: job.status,
      scheduledFor: job.scheduled_for.toISOString(),
      createdAt: job.created_at.toISOString(),
      account: job.account,
      attachments: job.attachments.map((a) => ({
        id: a.id,
        storageKey: a.storage_key,
        fileName: a.file_name,
        mimeType: a.mime_type,
      })),
    };
  }
}
