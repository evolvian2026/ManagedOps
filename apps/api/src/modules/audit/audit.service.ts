import { Injectable } from '@nestjs/common';
import { paginationSchema, type Paginated, type PaginationQuery } from '@managedops/shared';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';

export const auditQuerySchema = paginationSchema
  .extend({
    actorUserId: z.string().uuid().optional(),
    entityType: z.string().min(1).max(64).optional(),
    entityId: z.string().uuid().optional(),
    action: z.string().min(1).max(200).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEntryInput {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

const SORTABLE = ['createdAt', 'action', 'entityType'] as const;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntryInput): Promise<void> {
    await this.prisma.db.auditLog.create({
      data: {
        id: newId(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: (entry.before ?? undefined) as never,
        after: (entry.after ?? undefined) as never,
        ip: entry.ip,
        userAgent: entry.userAgent,
        requestId: entry.requestId,
      },
    });
  }

  /**
   * Reads of salary and identity documents are audited too (spec 3.3), which is
   * why this exists separately from the mutation interceptor.
   */
  async recordSensitiveRead(options: {
    actorUserId: string;
    entityType: string;
    entityId: string;
    field: string;
  }): Promise<void> {
    await this.record({
      actorUserId: options.actorUserId,
      action: `READ ${options.field}`,
      entityType: options.entityType,
      entityId: options.entityId,
    });
  }

  async list(query: AuditQuery): Promise<Paginated<unknown>> {
    const where = {
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: { contains: query.action, mode: 'insensitive' as const } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const page = toPrismaPage(query as PaginationQuery, SORTABLE);
    const [rows, total] = await Promise.all([
      this.prisma.db.auditLog.findMany({
        where,
        ...page,
        include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.db.auditLog.count({ where }),
    ]);

    return paginate(rows, total, query as PaginationQuery);
  }
}
