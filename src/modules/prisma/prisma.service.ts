import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma client wrapper.
 *
 * Prisma 7 removed the bare `new PrismaClient()` form: clients must be built
 * with either an `accelerateUrl` (`prisma+postgres://…`) or a driver adapter.
 * We use the `@prisma/adapter-pg` driver because the Prisma Postgres
 * connection URL we get from Vercel's integration is a standard
 * `postgres://…@db.prisma.io:5432/…` string. `prisma.config.ts` is only read
 * by the Prisma CLI (generate/migrate) — at runtime we have to wire the URL
 * ourselves through `process.env.DATABASE_URL`.
 *
 * We deliberately do NOT call `$connect()` eagerly. Calling it on every cold
 * start blocks bootstrap on the database round-trip, which (combined with
 * scanner/bot traffic) was burning the function's `maxDuration` budget.
 * Prisma connects lazily on the first query — the supported pattern for
 * Vercel serverless. `$disconnect()` is only useful on long-running hosts;
 * Vercel freezes/recycles the runtime between invocations.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required to construct PrismaClient');
    }
    super({
      adapter: new PrismaPg({ connectionString: url }),
      log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
