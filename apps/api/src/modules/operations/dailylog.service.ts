import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  toIstDateString,
  type CreateDailyLogInput,
  type DailyLogQuery,
  type UnlockDailyLogInput,
  type UpdateDailyLogInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { dailyLogScope, ownAssignmentFilter, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { AssignmentContext } from './assignment-context.js';
import { date } from './attendance.service.js';

const SORTABLE = ['workDate', 'sessionNo', 'createdAt'] as const;

const LOG_SELECT = {
  id: true,
  workDate: true,
  sessionNo: true,
  topic: true,
  hours: true,
  notes: true,
  submittedAt: true,
  locked: true,
  createdAt: true,
  assignment: {
    select: {
      id: true,
      project: { select: { id: true, name: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

/** A day's teaching cannot sensibly exceed this across all its sessions. */
const MAX_HOURS_PER_DAY = 14;

/**
 * The daily log: what was taught, for how long, on which day.
 *
 * Sessions lock as soon as they are written (spec 2.3) — the log is a record of
 * what happened, and a record that can be edited a fortnight later is a draft.
 * An administrator can unlock one, and the audit trail carries who did it and
 * the reason they gave, which is the whole point of making it an explicit
 * action rather than a permanently editable field.
 *
 * The session number is assigned by the server. Two tabs open on the same day
 * would otherwise both choose "session 2", and one of them would lose to the
 * unique index with an error the trainer can do nothing about.
 */
@Injectable()
export class DailyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AssignmentContext,
  ) {}

  async create(input: CreateDailyLogInput, user: AuthenticatedUser) {
    const assignment = await this.context.resolveOwn(input.assignmentId, user);

    const today = toIstDateString(new Date());
    if (input.workDate > today) {
      throw new DomainRuleProblem(
        'log-in-the-future',
        'You cannot log a session for a day that has not happened yet.',
      );
    }
    if (input.workDate < toIstDateString(assignment.startDate)) {
      throw new DomainRuleProblem(
        'log-before-assignment',
        `Your assignment to ${assignment.project.name} starts on ${toIstDateString(assignment.startDate)}.`,
      );
    }

    const existing = await this.prisma.db.dailyLog.aggregate({
      where: { assignmentId: assignment.id, workDate: date(input.workDate) },
      _max: { sessionNo: true },
      _sum: { hours: true },
    });

    const totalHours = Number(existing._sum.hours ?? 0) + input.hours;
    if (totalHours > MAX_HOURS_PER_DAY) {
      throw new DomainRuleProblem(
        'day-too-long',
        `That would make ${totalHours} hours on ${input.workDate}. Check the hours — the day already has ${Number(existing._sum.hours ?? 0)}.`,
      );
    }

    return this.prisma.db.dailyLog.create({
      data: {
        id: newId(),
        assignmentId: assignment.id,
        workDate: date(input.workDate),
        sessionNo: (existing._max.sessionNo ?? 0) + 1,
        topic: input.topic,
        hours: new Prisma.Decimal(input.hours),
        notes: input.notes ?? null,
        // Written and locked in one step: the log records what happened.
        submittedAt: new Date(),
        locked: true,
      },
      select: LOG_SELECT,
    });
  }

  async list(query: DailyLogQuery, user: AuthenticatedUser) {
    const where = scopedWhere(dailyLogScope(user), {
      ...(query.mine === 'true' ? ownAssignmentFilter(user) : {}),
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.trainerId || query.projectId
        ? {
            assignment: {
              ...(query.trainerId ? { trainerId: query.trainerId } : {}),
              ...(query.projectId ? { projectId: query.projectId } : {}),
            },
          }
        : {}),
      ...(query.from || query.to
        ? {
            workDate: {
              ...(query.from ? { gte: date(query.from) } : {}),
              ...(query.to ? { lte: date(query.to) } : {}),
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { workDate: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.dailyLog.findMany({
        where,
        ...page,
        select: LOG_SELECT,
        orderBy: [{ workDate: 'desc' }, { sessionNo: 'asc' }],
      }),
      this.prisma.db.dailyLog.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /** Editing is only possible on a session an administrator has unlocked. */
  async update(id: string, input: UpdateDailyLogInput, user: AuthenticatedUser) {
    const log = await this.prisma.db.dailyLog.findFirst({
      where: scopedWhere(dailyLogScope(user, 'dailylogs.write'), { id }),
      select: { id: true, locked: true, assignment: { select: { trainerId: true } } },
    });
    if (!log) throw new NotFoundProblem('That session');

    if (log.assignment.trainerId !== user.trainerId) {
      throw new ForbiddenProblem('You can only edit your own daily log.');
    }
    if (log.locked) {
      throw new DomainRuleProblem(
        'log-locked',
        'This session is locked. Ask an administrator to unlock it if it needs correcting.',
      );
    }

    return this.prisma.db.dailyLog.update({
      where: { id },
      data: {
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.hours !== undefined ? { hours: new Prisma.Decimal(input.hours) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        // Re-locks on save: one unlock buys one correction, not open season.
        locked: true,
        submittedAt: new Date(),
      },
      select: LOG_SELECT,
    });
  }

  /**
   * Unlocks one session for correction. The reason is required and the audit
   * interceptor records it against the actor — that trail is what makes an
   * editable historical record acceptable at all.
   */
  async unlock(id: string, _input: UnlockDailyLogInput, user: AuthenticatedUser) {
    const log = await this.prisma.db.dailyLog.findFirst({
      where: scopedWhere(dailyLogScope(user, 'dailylogs.unlock'), { id }),
      select: { id: true, locked: true },
    });
    if (!log) throw new NotFoundProblem('That session');

    if (!log.locked) {
      throw new DomainRuleProblem('log-not-locked', 'This session is already open for editing.');
    }

    return this.prisma.db.dailyLog.update({
      where: { id },
      data: { locked: false },
      select: LOG_SELECT,
    });
  }
}
