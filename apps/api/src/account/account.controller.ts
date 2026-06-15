import {
  Controller,
  Post,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AccountService } from './account.service.js';
import { SyncAccountSchema } from './dto/sync-account.dto.js';
import type { ZodError } from 'zod';

@Controller('accounts')
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  constructor(private readonly accountService: AccountService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncAccount(@Body() body: unknown) {
    const parsed = SyncAccountSchema.safeParse(body);

    if (!parsed.success) {
      const zodError = parsed.error as ZodError;
      this.logger.warn(`❌ Account sync validation failed: ${zodError.errors.map(e => e.message).join(', ')}`);
      throw new BadRequestException({
        message: 'Validation failed',
        errors: zodError.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    this.logger.log(`🔄 Syncing account: "${parsed.data.accountName}"`);

    const account = await this.accountService.syncAccount(parsed.data);

    this.logger.log(`✅ Account synced: id=${account.id}, name=${account.account_name}, status=${account.status}`);

    return {
      id: account.id,
      accountId: account.id,
      accountName: account.account_name,
      status: account.status,
      createdAt: account.created_at.toISOString(),
    };
  }
}
