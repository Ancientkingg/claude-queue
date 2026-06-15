import {
  Controller,
  Post,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AccountService } from './account.service.js';
import { SyncAccountSchema } from './dto/sync-account.dto.js';
import type { ZodError } from 'zod';

@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncAccount(@Body() body: unknown) {
    const parsed = SyncAccountSchema.safeParse(body);

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

    const account = await this.accountService.syncAccount(parsed.data);

    return {
      id: account.id,
      accountId: account.id,
      accountName: account.account_name,
      status: account.status,
      createdAt: account.created_at.toISOString(),
    };
  }
}
