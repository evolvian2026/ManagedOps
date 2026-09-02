import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  can,
  computeLeaveBalance,
  countLeaveDays,
  eachDate,
  toIstDateString,
  type CreateLeaveInput,
  type DecideLeaveInput,
  type LeaveQuery,
  type LeaveStatus,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { leaveScope, ownAssignmentFilter, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AssignmentContext, type AssignmentContextRow } from './assignment-context.js';
import { date } from './attendance.service.js';

const SORTABLE = ['startDate', 'createdAt', 'status'] as const;

const LEAVE_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  dayType: true,
  daysCount: true,
  unpaidDays: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  escalatedAt: true,
  createdAt: true,
  approver: { select: { id: true, name: true } },
  assignment: {
    select: {
      id: true,
      leaveAllowanceDays: true,
      project: { select: { id: true, name: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

/** Statuses that still count against the balance. A rejection frees the days. */
const CONSUMING_STATUSES: LeaveStatus[] = ['submitted', 'escalated', 'approved'];

/** What "pending" means to an approver working their queue. */
const AWAITING_DECISION: LeaveStatus[] = ['submitted', 'escalated'];

/**
 * Leave: three days per assignment, spent half a day at a time.
 *
 * Two decisions here are worth naming. A request over the balance is accepted
 * rather than refused — the trainer may genuinely need the time, and the
 * approver is the one who should weigh that — but the overage is computed up
 * front and shown to them, and lands as `leave_without_pay` if they approve
 * (spec 4.6). And an approval writes the attendance days immediately, because a
 * day marked "on leave" only after the fact is a day the nightly close has
 * already recorded as an absence.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly context: AssignmentContext,
  ) {}

  async create(input: CreateLeaveInput, user: AuthenticatedUser) {
    const assignment = await this.context.resolveOwn(input.assignmentId, user);

    if (input.startDate < toIstDateString(assignment.startDate)) {
      throw new DomainRuleProblem(
        'leave-before-assignment',
        `Your assignment to ${assignment.project.name} starts on ${toIstDateString(assignment.startDate)}.`,
      );
    }

    const overlap = await this.prisma.db.leaveRequest.findFirst({
      where: {
        assignmentId: assignment.id,
        status: { in: CONSUMING_STATUSES },
        startDate: { lte: date(input.endDate) },
        endDate: { gte: date(input.startDate) },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    });
    if (overlap) {
      throw new DomainRuleProblem(
        'leave-overlaps',
        `You already have ${overlap.status} leave from ${toIstDateString(overlap.startDate)} to ${toIstDateString(overlap.endDate)}.`,
      );
    }

    const holidays = await this.context.holidays(
      assignment.projectId,
      input.startDate,
      input.endDate,
    );
    const daysCount = countLeaveDays({
      startDate: input.startDate,
      endDate: input.endDate,
      dayType: input.dayType,
      holidays,
      weeklyOffDays: assignment.project.weeklyOffDays,
    });

    if (daysCount === 0) {
      throw new DomainRuleProblem(
        'leave-has-no-working-days',
        'Every day in that range is already a holiday or a weekly off, so there is no leave to take.',
      );
    }

    const balance = await this.balanceFor(assignment, daysCount);

    const request = await this.prisma.db.leaveRequest.create({
      data: {
        id: newId(),
        assignmentId: assignment.id,
        startDate: date(input.startDate),
        endDate: date(input.endDate),
        dayType: input.dayType,
        daysCount: new Prisma.Decimal(daysCount),
        unpaidDays: new Prisma.Decimal(balance.unpaid),
        reason: input.reason,
        status: 'submitted',
      },
      select: LEAVE_SELECT,
    });

    const { leadUserId, escalation } = await this.context.approvers(assignment.projectId);
    // The lead decides first; the others are told so nobody is surprised later.
    await this.notifications.notify({
      userIds: [leadUserId, ...escalation].filter((id): id is string => Boolean(id)),
      type: 'leave_submitted',
      title: `${assignment.trainer.user.name} has requested leave`,
      body:
        `${input.startDate} to ${input.endDate} — ${daysCount} day(s)` +
        (balance.unpaid > 0 ? `, of which ${balance.unpaid} would be unpaid.` : '.'),
      entityType: 'LeaveRequest',
      entityId: request.id,
    });

    return { ...request, balance };
  }

  async list(query: LeaveQuery, user: AuthenticatedUser) {
    // `status` and `pending` constrain the same column, so exactly one of them
    // is written. Spreading both would let whichever came later in the literal
    // silently discard the other — the same shape of defect `scopedWhere` exists
    // to prevent. An explicit status wins over the shorthand.
    const statusFilter = query.status
      ? { status: query.status }
      : query.pending === 'true'
        ? { status: { in: AWAITING_DECISION } }
        : {};

    const where = scopedWhere(leaveScope(user, capabilityFor(user)), {
      ...statusFilter,
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
    });

    const page = toPrismaPage(query, SORTABLE, { createdAt: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.leaveRequest.findMany({ where, ...page, select: LEAVE_SELECT }),
      this.prisma.db.leaveRequest.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const request = await this.prisma.db.leaveRequest.findFirst({
      where: scopedWhere(leaveScope(user, capabilityFor(user)), { id }),
      select: LEAVE_SELECT,
    });
    if (!request) throw new NotFoundProblem('That leave request');
    return request;
  }

  /** The balance card on the trainer's leave screen. */
  async balance(user: AuthenticatedUser, assignmentId?: string) {
    const assignment = assignmentId
      ? await this.context.resolveReadable(assignmentId, user)
      : await this.context.resolveOwn(undefined, user);
    const balance = await this.balanceFor(assignment, 0);
    return {
      assignment: {
        id: assignment.id,
        project: { id: assignment.projectId, name: assignment.project.name },
      },
      ...balance,
    };
  }

  /**
   * Approve or reject. Any single approval is sufficient (spec 15.4): the lead
   * decides first, and once escalated the manager or HR may decide instead. A
   * trainer never decides on their own request, even a lead who holds
   * `leave.approve` for their project — which is exactly the case the check
   * below exists for.
   */
  async decide(id: string, input: DecideLeaveInput, user: AuthenticatedUser) {
    const request = await this.prisma.db.leaveRequest.findFirst({
      where: scopedWhere(leaveScope(user, 'leave.approve'), { id }),
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        dayType: true,
        daysCount: true,
        unpaidDays: true,
        assignment: {
          select: {
            id: true,
            trainerId: true,
            projectId: true,
            project: { select: { name: true, weeklyOffDays: true } },
            trainer: { select: { user: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    if (!request) throw new NotFoundProblem('That leave request');

    if (request.assignment.trainerId === user.trainerId) {
      throw new ForbiddenProblem('You cannot decide on your own leave request.');
    }

    assertTransition('leave', request.status, input.decision);

    const holidays = await this.context.holidays(
      request.assignment.projectId,
      toIstDateString(request.startDate),
      toIstDateString(request.endDate),
    );

    await this.prisma.db.$transaction(async (tx) => {
      await tx.leaveRequest.update({
        where: { id },
        data: {
          status: input.decision,
          approverId: user.userId,
          decidedAt: new Date(),
          decisionNote: input.decisionNote ?? null,
        },
      });

      if (input.decision !== 'approved') return;

      // Paid days first, then the overage as leave without pay — the trainer
      // should lose pay for the last days of a long leave, not the first.
      const paidDays = Number(request.daysCount) - Number(request.unpaidDays);
      let spent = 0;

      for (const day of eachDate(
        toIstDateString(request.startDate),
        toIstDateString(request.endDate),
      )) {
        const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay();
        if (request.assignment.project.weeklyOffDays.includes(dayOfWeek)) continue;
        if (holidays.includes(day)) continue;

        const cost = request.dayType === 'half' ? 0.5 : 1;
        const paid = spent + cost <= paidDays;
        spent += cost;

        const status = !paid
          ? 'leave_without_pay'
          : request.dayType === 'half'
            ? 'half_day'
            : 'on_leave';

        // A day already punched keeps its punches; upsert would otherwise
        // silently overwrite a real morning's work with "on leave".
        await tx.attendanceRecord.upsert({
          where: {
            assignmentId_workDate: { assignmentId: request.assignment.id, workDate: date(day) },
          },
          create: {
            id: newId(),
            assignmentId: request.assignment.id,
            workDate: date(day),
            status,
            source: 'leave',
            locationStatus: 'unavailable',
          },
          update: { status, source: 'leave' },
        });
      }
    });

    await this.notifications.notify({
      userIds: [request.assignment.trainer.user.id],
      type: 'leave_decided',
      title: input.decision === 'approved' ? 'Your leave was approved' : 'Your leave was rejected',
      body:
        `${toIstDateString(request.startDate)} to ${toIstDateString(request.endDate)}` +
        (input.decisionNote ? ` — ${input.decisionNote}` : '.'),
      entityType: 'LeaveRequest',
      entityId: id,
    });

    return this.get(id, user);
  }

  /** A trainer withdraws their own request, up to the day before it starts. */
  async cancel(id: string, user: AuthenticatedUser) {
    const request = await this.prisma.db.leaveRequest.findFirst({
      where: scopedWhere(leaveScope(user, 'leave.request'), { id }),
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        assignment: { select: { id: true, trainerId: true } },
      },
    });
    if (!request) throw new NotFoundProblem('That leave request');

    if (request.assignment.trainerId !== user.trainerId) {
      throw new ForbiddenProblem('You can only cancel your own leave.');
    }

    assertTransition('leave', request.status, 'cancelled');

    const today = toIstDateString(new Date());
    if (toIstDateString(request.startDate) <= today) {
      throw new DomainRuleProblem(
        'leave-already-started',
        'Leave that has already started cannot be cancelled — ask your approver to correct the days instead.',
      );
    }

    await this.prisma.db.$transaction(async (tx) => {
      await tx.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
      // An approved-then-cancelled leave leaves days behind that were never taken.
      await tx.attendanceRecord.deleteMany({
        where: {
          assignmentId: request.assignment.id,
          source: 'leave',
          workDate: { gte: request.startDate, lte: request.endDate },
        },
      });
    });

    return this.get(id, user);
  }

  /** Requests still sitting with the lead after the escalation window. */
  async dueForEscalation(now: Date, hours: number) {
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return this.prisma.db.leaveRequest.findMany({
      where: { status: 'submitted', createdAt: { lte: cutoff } },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        daysCount: true,
        assignment: {
          select: {
            projectId: true,
            project: { select: { name: true } },
            trainer: { select: { user: { select: { name: true } } } },
          },
        },
      },
    });
  }

  async markEscalated(id: string): Promise<void> {
    await this.prisma.db.leaveRequest.update({
      where: { id },
      data: { status: 'escalated', escalatedAt: new Date() },
    });
  }

  /* ------------------------------------------------------------- internals */

  private async balanceFor(assignment: AssignmentContextRow, requestedDays: number) {
    const consumed = await this.prisma.db.leaveRequest.aggregate({
      where: { assignmentId: assignment.id, status: { in: CONSUMING_STATUSES } },
      _sum: { daysCount: true, unpaidDays: true },
    });
    // Unpaid days were never drawn from the allowance, so they do not spend it.
    const used = Number(consumed._sum.daysCount ?? 0) - Number(consumed._sum.unpaidDays ?? 0);
    return computeLeaveBalance(Number(assignment.leaveAllowanceDays), used, requestedDays);
  }
}

/**
 * One list endpoint serves both audiences. An approver reads the queue their
 * `leave.approve` scope defines; anyone without it reads their own requests
 * through `leave.request`. Choosing by capability rather than by role means a
 * project lead — who holds both — gets the project queue without a role name
 * appearing in a service.
 */
function capabilityFor(user: AuthenticatedUser) {
  return can(user.role, 'leave.approve') ? ('leave.approve' as const) : ('leave.request' as const);
}
