import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  buildRuntimeDatabaseUrl,
  databasePoolSnapshot,
  resolveDatabasePoolConfig,
} from './database-pool.config';

/**
 * Prisma client bound to the application lifecycle.
 *
 * Pool sizing (#951): before the client is constructed, any explicitly
 * configured pool parameters (`DATABASE_POOL_SIZE`,
 * `DATABASE_POOL_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`) are
 * applied to `DATABASE_URL`. Prisma reads the datasource from the environment,
 * so this is how the pool ceiling is pinned per deployment. With none of those
 * variables set the URL is untouched and Prisma's engine default applies —
 * see docs/DB-POOL-SIZING.md.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const runtimeUrl = buildRuntimeDatabaseUrl();
    if (runtimeUrl !== undefined) {
      // Secret-free log: only the resolved sizing, never the URL itself.
      process.env.DATABASE_URL = runtimeUrl;
    }

    super({
      log: ['error', 'warn'],
    });

    this.logger.log(
      `db pool ${JSON.stringify(databasePoolSnapshot(resolveDatabasePoolConfig()))}`,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
