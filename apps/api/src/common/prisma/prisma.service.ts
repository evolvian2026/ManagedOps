import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Models carrying `deletedAt`, which reads must filter out by default. */
const SOFT_DELETE_MODELS = new Set([
  'User',
  'Project',
  'Position',
  'Candidate',
  'Application',
  'Interview',
  'Offer',
  'Trainer',
  'Assignment',
  'Asset',
  'FileObject',
]);

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Applies the soft-delete policy globally: reads on a soft-deletable model get
 * `deletedAt: null` merged into their filter, so no service can forget it. A
 * query that genuinely needs deleted rows — the audit trail, a restore flow —
 * sets `deletedAt` in its own `where`, which is respected as written.
 */
function withSoftDelete(client: PrismaClient) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !SOFT_DELETE_MODELS.has(model) || !READ_OPERATIONS.has(operation)) {
            return query(args);
          }
          const typedArgs = args as { where?: Record<string, unknown> };
          const where = typedArgs.where ?? {};
          if (!('deletedAt' in where)) {
            typedArgs.where = { ...where, deletedAt: null };
          }
          return query(typedArgs);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof withSoftDelete>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: PrismaClient;
  /** Use this for all ordinary work — soft-deleted rows are already excluded. */
  readonly db: ExtendedPrismaClient;

  constructor() {
    this.base = new PrismaClient();
    this.db = withSoftDelete(this.base);
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /** Escape hatch for the rare query that must see soft-deleted rows. */
  get raw(): PrismaClient {
    return this.base;
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /** Wipes every table between integration tests, respecting FK order. */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Refusing to truncate a production database');
    }
    const tables = await this.base.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.base.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
