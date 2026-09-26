import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
// The Prisma client is generated to `src/generated/prisma` (see the generator
// block in prisma/schema.prisma), which is the only location Prisma 7's
// `prisma-client` provider populates. Importing `@prisma/client` resolves to
// the legacy `.prisma/client` shim, which is never written for a custom output
// path and makes every AppModule boot fail with MODULE_NOT_FOUND.
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Prisma 7 requires an explicit driver adapter. The connection is opened
    // lazily (on first query), so the placeholder below is inert in offline
    // unit/e2e suites; a real deployment is gated by `validateEnv()`, which
    // requires DATABASE_URL before the process is allowed to boot.
    const adapter = new PrismaPg({
      connectionString:
        process.env.DATABASE_URL ?? 'postgresql://localhost:5432/mux_offline',
    });

    super({
      adapter,
      log: ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
