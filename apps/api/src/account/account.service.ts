import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SyncAccountDto } from './dto/sync-account.dto.js';
import type { Account } from '@prisma/client';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert an account: create if it doesn't exist by name, or update session profile.
   */
  async syncAccount(dto: SyncAccountDto): Promise<Account> {
    const existing = await this.prisma.account.findFirst({
      where: { account_name: dto.accountName },
    });

    if (existing) {
      this.logger.log(`Updating account "${dto.accountName}" (${existing.id})`);
      return this.prisma.account.update({
        where: { id: existing.id },
        data: {
          session_profile: dto.sessionProfile as object,
          status: 'ACTIVE',
        },
      });
    }

    this.logger.log(`Creating new account "${dto.accountName}"`);
    return this.prisma.account.create({
      data: {
        account_name: dto.accountName,
        session_profile: dto.sessionProfile as object,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Find an account by its UUID.
   */
  async findById(id: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { id } });
  }

  /**
   * List all accounts.
   */
  async findAll(): Promise<Account[]> {
    return this.prisma.account.findMany({
      orderBy: { created_at: 'desc' },
    });
  }
}
