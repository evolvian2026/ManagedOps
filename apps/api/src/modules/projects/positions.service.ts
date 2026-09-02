import { Injectable } from '@nestjs/common';
import type { CreatePositionInput, PositionQuery, UpdatePositionInput } from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { positionScope, projectScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['createdAt', 'title', 'headcount', 'status'] as const;

/** The stages the Open Positions board breaks each position's applicants into. */
const PIPELINE_STAGES = {
  applied: ['applied', 'screening'],
  interviewing: ['interviewing'],
  offer: ['offer_stage'],
  hired: ['hired'],
  closed: [
    'rejected_screening',
    'rejected_interview',
    'not_available',
    'offer_declined',
    'withdrawn',
  ],
} as const;

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Open Positions card grid. Each card needs its applicant count and the
   * stage breakdown, so both are aggregated here rather than leaving the client
   * to fetch every application just to count them.
   */
  async list(query: PositionQuery, user: AuthenticatedUser) {
    const where = scopedWhere(positionScope(user), {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
    });

    const page = toPrismaPage(query, SORTABLE);
    const [rows, total] = await Promise.all([
      this.prisma.db.position.findMany({
        where,
        ...page,
        select: {
          id: true,
          title: true,
          headcount: true,
          filledCount: true,
          description: true,
          status: true,
          createdAt: true,
          project: { select: { id: true, name: true, code: true, clientName: true } },
        },
      }),
      this.prisma.db.position.count({ where }),
    ]);

    const stages = await this.stageCounts(rows.map((row) => row.id));
    return paginate(
      rows.map((row) => ({ ...row, applicants: stages[row.id] ?? emptyStages() })),
      total,
      query,
    );
  }

  async get(id: string, user: AuthenticatedUser) {
    const position = await this.prisma.db.position.findFirst({
      where: scopedWhere(positionScope(user), { id }),
      select: {
        id: true,
        title: true,
        headcount: true,
        filledCount: true,
        description: true,
        status: true,
        closedAt: true,
        createdAt: true,
        project: { select: { id: true, name: true, code: true, clientName: true } },
      },
    });
    if (!position) throw new NotFoundProblem('That position');

    const stages = await this.stageCounts([id]);
    return { ...position, applicants: stages[id] ?? emptyStages() };
  }

  async create(input: CreatePositionInput, actor: AuthenticatedUser) {
    const project = await this.prisma.db.project.findFirst({
      where: scopedWhere(projectScope(actor), { id: input.projectId }),
    });
    if (!project) throw new NotFoundProblem('That project');

    if (project.status === 'completed' || project.status === 'cancelled') {
      throw new DomainRuleProblem(
        'project-not-hiring',
        `${project.name} is ${project.status}, so it cannot take new positions.`,
      );
    }

    return this.prisma.db.position.create({
      data: {
        id: newId(),
        projectId: input.projectId,
        title: input.title,
        headcount: input.headcount,
        description: input.description,
        createdById: actor.userId,
      },
      select: {
        id: true,
        title: true,
        headcount: true,
        filledCount: true,
        status: true,
        project: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async update(id: string, input: UpdatePositionInput, actor: AuthenticatedUser) {
    const position = await this.prisma.db.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundProblem('That position');

    if (input.headcount !== undefined && input.headcount < position.filledCount) {
      throw new ValidationProblem(
        `${position.filledCount} people have already been hired into this position, so the headcount cannot drop below that.`,
        [{ path: 'headcount', message: `must be at least ${position.filledCount}` }],
      );
    }

    return this.prisma.db.position.update({
      where: { id },
      data: { ...input, updatedById: actor.userId },
      select: { id: true, title: true, headcount: true, filledCount: true, status: true },
    });
  }

  /**
   * Closing a position stops new applications. Anyone already in the pipeline
   * keeps their application — closing a requisition is not a reason to lose
   * a candidate who is mid-interview.
   */
  async close(id: string, actor: AuthenticatedUser) {
    const position = await this.prisma.db.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundProblem('That position');
    if (position.status === 'closed') return { id, status: position.status };

    const inFlight = await this.prisma.db.application.count({
      where: {
        positionId: id,
        status: { in: ['applied', 'screening', 'interviewing', 'offer_stage'] },
      },
    });

    const updated = await this.prisma.db.position.update({
      where: { id },
      data: { status: 'closed', closedAt: new Date(), updatedById: actor.userId },
      select: { id: true, title: true, status: true, closedAt: true },
    });

    return { ...updated, applicationsStillInPipeline: inFlight };
  }

  /** Called when a candidate is hired, so a filled position closes itself. */
  async recordHire(positionId: string): Promise<void> {
    const position = await this.prisma.db.position.findUnique({ where: { id: positionId } });
    if (!position) return;

    const filledCount = position.filledCount + 1;
    await this.prisma.db.position.update({
      where: { id: positionId },
      data: {
        filledCount,
        ...(filledCount >= position.headcount
          ? { status: 'filled' as const, closedAt: new Date() }
          : {}),
      },
    });
  }

  private async stageCounts(positionIds: string[]) {
    if (positionIds.length === 0) return {};

    const rows = await this.prisma.db.application.groupBy({
      by: ['positionId', 'status'],
      where: { positionId: { in: positionIds } },
      _count: { _all: true },
    });

    const result: Record<string, ReturnType<typeof emptyStages>> = {};
    for (const row of rows) {
      const bucket = (result[row.positionId] ??= emptyStages());
      const count = row._count._all;
      bucket.total += count;
      for (const [stage, statuses] of Object.entries(PIPELINE_STAGES)) {
        if ((statuses as readonly string[]).includes(row.status)) {
          bucket[stage as keyof typeof PIPELINE_STAGES] += count;
        }
      }
    }
    return result;
  }
}

function emptyStages() {
  return { total: 0, applied: 0, interviewing: 0, offer: 0, hired: 0, closed: 0 };
}
