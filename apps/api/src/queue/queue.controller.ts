import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QueueService } from './queue.service.js';
import { CreateJobSchema } from './dto/create-job.dto.js';
import type { ZodError } from 'zod';

@Controller('jobs')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createJob(@Body() body: unknown) {
    const parsed = CreateJobSchema.safeParse(body);

    if (!parsed.success) {
      const zodError = parsed.error as ZodError;
      throw new BadRequestException({
        message: 'Validation failed',
        errors: zodError.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const job = await this.queueService.createJob(parsed.data);

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
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    if (isNaN(pageNum) || pageNum < 1) {
      throw new BadRequestException('page must be a positive integer');
    }
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const result = await this.queueService.findAll(pageNum, limitNum);

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

  @Get(':id')
  async getJob(@Param('id') id: string) {
    const job = await this.queueService.findById(id);

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
