import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  attendanceStatusFromPunches,
  canTransition,
  nonWorkingReason,
  toIstDateString,
  type AttendanceQuery,
  type CorrectionQuery,
  type DecideCorrectionInput,
  type PunchInInput,
  type PunchOutInput,
  type RequestCorrectionInput,
  type TodayState,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { attendanceScope, correctionScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AssignmentContext } from './assignment-context.js';

const SORTABLE = ['workDate', 'status', 'createdAt'] as const;

const ATTENDANCE_SELECT = {
  id: true,
  workDate: true,
  status: true,
  punchInAt: true,
  punchOutAt: true,
  punchInLat: true,
  punchInLng: true,
  punchOutLat: true,
  punchOutLng: true,
  locationStatus: true,
  source: true,
  notes: true,
  assignment: {
    select: {
      id: true,
      role: true,
      project: { select: { id: true, name: true, workStartTime: true, graceMinutes: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

const CORRECTION_SELECT = {
  id: true,
  requestedPunchIn: true,
  requestedPunchOut: true,
  reason: true,
  status: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  requestedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  attendanceRecord: { select: ATTENDANCE_SELECT },
} as const;

/**
 * Attendance: the punch, the day it belongs to, and the corrections that fix it.
 *
 * Two rules shape everything here. First, the unique index on
 * `(assignment_id, work_date)` is what makes "one punch-in and one punch-out per
 * day" true — the checks below exist to explain a refusal in words, not to
 * enforce it, because two taps on a slow connection race past any check but not
 * past the index. Second, location is recorded and never enforced: a denied
 * permission produces a successful punch marked `unavailable`, because refusing
 * to record someone's attendance over a browser setting punishes the wrong
 * person (spec 4.5).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly context: AssignmentContext,
  ) {}

  /* -------------------------------------------------------------- punching */

  async punchIn(input: PunchInInput, user: AuthenticatedUser, now = new Date()) {
    const assignment = await this.context.resolveOwn(input.assignmentId, user);
    const workDate = toIstDateString(now);

    const existing = await this.prisma.db.attendanceRecord.findUnique({
      where: { assignmentId_workDate: { assignmentId: assignment.id, workDate: date(workDate) } },
      select: { id: true, status: true, punchInAt: true },
    });
    if (existing?.punchInAt) {
      throw new DomainRuleProblem(
        'already-punched-in',
        `You punched in at ${istClock(existing.punchInAt)} today. Punch out when you finish.`,
      );
    }

    const status = attendanceStatusFromPunches({
      punchInAt: now,
      punchOutAt: null,
      workStartTime: assignment.project.workStartTime,
      graceMinutes: assignment.project.graceMinutes,
    });
    // A day that is still open reads as `present`/`late`, not `missing_punch_out`
    // — that is what the nightly close decides, hours from now.
    const openStatus = status === 'missing_punch_out' ? this.openStatus(assignment, now) : status;

    const located = input.lat !== undefined && input.lng !== undefined;

    try {
      const record = await this.prisma.db.$transaction(async (tx) => {
        // Consent is recorded once, at the first punch, and never asked again.
        if (input.locationConsent && !assignment.trainer.locationConsentAt) {
          await tx.trainer.update({
            where: { id: assignment.trainer.id },
            data: { locationConsentAt: now },
          });
        }
        return tx.attendanceRecord.create({
          data: {
            id: newId(),
            assignmentId: assignment.id,
            workDate: date(workDate),
            punchInAt: now,
            punchInLat: located ? new Prisma.Decimal(input.lat!) : null,
            punchInLng: located ? new Prisma.Decimal(input.lng!) : null,
            status: openStatus,
            locationStatus: located ? 'captured' : 'unavailable',
            source: 'self',
            notes: input.notes ?? null,
          },
          select: ATTENDANCE_SELECT,
        });
      });
      return record;
    } catch (error) {
      // The index won the race. Say what happened rather than returning a 500.
      if (isUniqueViolation(error)) {
        throw new DomainRuleProblem('already-punched-in', 'You have already punched in today.');
      }
      throw error;
    }
  }

  async punchOut(input: PunchOutInput, user: AuthenticatedUser, now = new Date()) {
    const assignment = await this.context.resolveOwn(input.assignmentId, user);
    const workDate = toIstDateString(now);

    const record = await this.prisma.db.attendanceRecord.findUnique({
      where: { assignmentId_workDate: { assignmentId: assignment.id, workDate: date(workDate) } },
      select: { id: true, status: true, punchInAt: true, punchOutAt: true, locationStatus: true },
    });

    if (!record?.punchInAt) {
      throw new DomainRuleProblem(
        'not-punched-in',
        'You have not punched in today, so there is nothing to punch out of.',
      );
    }
    if (record.punchOutAt) {
      throw new DomainRuleProblem(
        'already-punched-out',
        `You punched out at ${istClock(record.punchOutAt)} today.`,
      );
    }
    if (now <= record.punchInAt) {
      throw new DomainRuleProblem(
        'punch-out-before-punch-in',
        'A punch-out cannot be earlier than the punch-in it closes.',
      );
    }

    const located = input.lat !== undefined && input.lng !== undefined;

    return this.prisma.db.attendanceRecord.update({
      where: { id: record.id },
      data: {
        punchOutAt: now,
        punchOutLat: located ? new Prisma.Decimal(input.lat!) : null,
        punchOutLng: located ? new Prisma.Decimal(input.lng!) : null,
        status: attendanceStatusFromPunches({
          punchInAt: record.punchInAt,
          punchOutAt: now,
          workStartTime: assignment.project.workStartTime,
          graceMinutes: assignment.project.graceMinutes,
        }),
        // One unavailable location makes the day's location incomplete; saying
        // `captured` because the second punch happened to work would overstate it.
        locationStatus:
          located && record.locationStatus === 'captured' ? 'captured' : 'unavailable',
        ...(input.notes ? { notes: input.notes } : {}),
      },
      select: ATTENDANCE_SELECT,
    });
  }

  /**
   * What the trainer's home screen shows: which punch is available, and when
   * none is, the reason. "Not working today" is an answer; a disabled button
   * with no explanation is not.
   */
  async today(user: AuthenticatedUser, now = new Date()): Promise<TodayState> {
    const assignment = await this.context.resolveOwn(undefined, user);
    const workDate = toIstDateString(now);

    const [record, holidays] = await Promise.all([
      this.prisma.db.attendanceRecord.findUnique({
        where: { assignmentId_workDate: { assignmentId: assignment.id, workDate: date(workDate) } },
        select: { id: true, status: true, punchInAt: true, punchOutAt: true },
      }),
      this.context.holidays(assignment.projectId, workDate, workDate),
    ]);

    const closed = nonWorkingReason(workDate, {
      weeklyOffDays: assignment.project.weeklyOffDays,
      holidays,
    });

    let action: TodayState['action'] = 'punch_in';
    let reason: string | null = null;

    if (record && ['on_leave', 'half_day', 'leave_without_pay'].includes(record.status)) {
      action = 'not_working';
      reason = 'You are on approved leave today.';
    } else if (closed) {
      action = 'not_working';
      reason = closed === 'holiday' ? 'Today is a project holiday.' : 'Today is a weekly off.';
    } else if (record?.punchOutAt) {
      action = 'done';
      reason = `You worked ${istClock(record.punchInAt!)} to ${istClock(record.punchOutAt)}.`;
    } else if (record?.punchInAt) {
      action = 'punch_out';
    }

    return {
      workDate,
      assignment: {
        id: assignment.id,
        projectName: assignment.project.name,
        workStartTime: assignment.project.workStartTime,
        graceMinutes: assignment.project.graceMinutes,
      },
      attendance: record
        ? {
            id: record.id,
            status: record.status,
            punchInAt: record.punchInAt?.toISOString() ?? null,
            punchOutAt: record.punchOutAt?.toISOString() ?? null,
          }
        : null,
      action,
      reason,
      locationConsentGiven: assignment.trainer.locationConsentAt !== null,
    };
  }

  /* ---------------------------------------------------------------- reading */

  async list(query: AttendanceQuery, user: AuthenticatedUser) {
    const where = scopedWhere(attendanceScope(user), {
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
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
      this.prisma.db.attendanceRecord.findMany({ where, ...page, select: ATTENDANCE_SELECT }),
      this.prisma.db.attendanceRecord.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /**
   * A month of one assignment, with every date present.
   *
   * Weekly offs and holidays are facts about the project calendar, not about a
   * person, so they are filled in here rather than written as a row per trainer
   * per non-working day. Storing them would be a quarter of a million rows a year
   * that go stale the moment a holiday is added.
   */
  async calendar(month: string, user: AuthenticatedUser, assignmentId?: string) {
    const assignment = assignmentId
      ? await this.context.resolveReadable(assignmentId, user)
      : await this.context.resolveOwn(undefined, user);

    const from = `${month}-01`;
    const to = lastDayOfMonth(month);

    const [records, holidays] = await Promise.all([
      this.prisma.db.attendanceRecord.findMany({
        where: { assignmentId: assignment.id, workDate: { gte: date(from), lte: date(to) } },
        select: ATTENDANCE_SELECT,
        orderBy: { workDate: 'asc' },
      }),
      this.context.holidays(assignment.projectId, from, to),
    ]);

    const byDate = new Map(records.map((record) => [toIstDateString(record.workDate), record]));
    const days: {
      workDate: string;
      status: string;
      record: (typeof records)[number] | null;
      derived: boolean;
    }[] = [];

    for (const day of eachDayOfMonth(from, to)) {
      const record = byDate.get(day);
      if (record) {
        days.push({ workDate: day, status: record.status, record, derived: false });
        continue;
      }
      const closed = nonWorkingReason(day, {
        weeklyOffDays: assignment.project.weeklyOffDays,
        holidays,
      });
      // Today is not over and tomorrow has not started, so neither is an
      // absence yet — that is what the nightly close decides. Only a working day
      // that has already ended and carries no record is an absence.
      const notYetClosed = day >= toIstDateString(new Date());
      days.push({
        workDate: day,
        status: closed ?? (notYetClosed ? 'scheduled' : 'absent'),
        record: null,
        derived: true,
      });
    }

    return {
      month,
      assignment: {
        id: assignment.id,
        project: { id: assignment.projectId, name: assignment.project.name },
      },
      days,
      summary: summarise(days.map((day) => day.status)),
    };
  }

  /* ------------------------------------------------------------ corrections */

  /**
   * A trainer asks for a day to be rewritten.
   *
   * Only one request may be open per day: a second would leave the approver
   * choosing between two versions of the same correction with no way to tell
   * which the trainer meant.
   */
  async requestCorrection(
    recordId: string,
    input: RequestCorrectionInput,
    user: AuthenticatedUser,
  ) {
    const record = await this.prisma.db.attendanceRecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        status: true,
        workDate: true,
        assignment: { select: { id: true, trainerId: true, projectId: true } },
      },
    });
    if (!record) throw new NotFoundProblem('That attendance record');

    if (record.assignment.trainerId !== user.trainerId) {
      throw new ForbiddenProblem('You can only raise corrections on your own attendance.');
    }

    const open = await this.prisma.db.attendanceCorrection.findFirst({
      where: { attendanceRecordId: recordId, status: 'pending' },
      select: { id: true },
    });
    if (open) {
      throw new DomainRuleProblem(
        'correction-already-open',
        'A correction for this day is already waiting for a decision.',
      );
    }

    assertTransition('attendance', record.status, 'correction_pending');

    const correction = await this.prisma.db.$transaction(async (tx) => {
      const created = await tx.attendanceCorrection.create({
        data: {
          id: newId(),
          attendanceRecordId: recordId,
          requestedById: user.userId,
          requestedPunchIn: input.requestedPunchIn ? new Date(input.requestedPunchIn) : null,
          requestedPunchOut: input.requestedPunchOut ? new Date(input.requestedPunchOut) : null,
          reason: input.reason,
          status: 'pending',
        },
        select: CORRECTION_SELECT,
      });
      await tx.attendanceRecord.update({
        where: { id: recordId },
        data: { status: 'correction_pending' },
      });
      return created;
    });

    await this.notifyApprovers(record.assignment.projectId, {
      title: 'An attendance correction needs a decision',
      body: `${correction.requestedBy.name} has asked for ${toIstDateString(record.workDate)} to be corrected.`,
      entityId: correction.id,
    });

    return correction;
  }

  async listCorrections(query: CorrectionQuery, user: AuthenticatedUser) {
    const where = scopedWhere(correctionScope(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId
        ? { attendanceRecord: { assignment: { projectId: query.projectId } } }
        : {}),
    });
    const page = toPrismaPage(query, ['createdAt', 'status'] as const);
    const [rows, total] = await Promise.all([
      this.prisma.db.attendanceCorrection.findMany({ where, ...page, select: CORRECTION_SELECT }),
      this.prisma.db.attendanceCorrection.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /**
   * Approving rewrites the day and marks it `corrected` — never back to
   * `present`, so a day someone amended is always distinguishable from one that
   * was punched cleanly. Rejecting recomputes the day from the punches actually
   * on it, which is the same function that labelled it in the first place.
   */
  async decideCorrection(
    correctionId: string,
    input: DecideCorrectionInput,
    user: AuthenticatedUser,
  ) {
    const correction = await this.prisma.db.attendanceCorrection.findFirst({
      where: scopedWhere(correctionScope(user), { id: correctionId }),
      select: {
        id: true,
        status: true,
        requestedPunchIn: true,
        requestedPunchOut: true,
        requestedById: true,
        requestedBy: { select: { name: true } },
        attendanceRecord: {
          select: {
            id: true,
            workDate: true,
            punchInAt: true,
            punchOutAt: true,
            assignment: {
              select: {
                trainerId: true,
                project: { select: { workStartTime: true, graceMinutes: true } },
              },
            },
          },
        },
      },
    });
    if (!correction) throw new NotFoundProblem('That correction');

    assertTransition('correction', correction.status, input.decision);

    if (correction.requestedById === user.userId) {
      throw new ForbiddenProblem('You cannot approve your own correction request.');
    }

    const record = correction.attendanceRecord;
    const punchInAt = correction.requestedPunchIn ?? record.punchInAt;
    const punchOutAt = correction.requestedPunchOut ?? record.punchOutAt;

    const decided = await this.prisma.db.$transaction(async (tx) => {
      const updated = await tx.attendanceCorrection.update({
        where: { id: correctionId },
        data: {
          status: input.decision,
          reviewedById: user.userId,
          reviewedAt: new Date(),
          reviewNote: input.reviewNote ?? null,
        },
        select: CORRECTION_SELECT,
      });

      if (input.decision === 'approved') {
        await tx.attendanceRecord.update({
          where: { id: record.id },
          data: { punchInAt, punchOutAt, status: 'corrected', source: 'correction' },
        });
      } else {
        await tx.attendanceRecord.update({
          where: { id: record.id },
          data: {
            status: attendanceStatusFromPunches({
              punchInAt: record.punchInAt,
              punchOutAt: record.punchOutAt,
              workStartTime: record.assignment.project.workStartTime,
              graceMinutes: record.assignment.project.graceMinutes,
            }),
          },
        });
      }
      return updated;
    });

    await this.notifications.notify({
      userIds: [correction.requestedById],
      type: 'attendance_correction',
      title:
        input.decision === 'approved'
          ? 'Your attendance correction was approved'
          : 'Your attendance correction was rejected',
      body:
        input.decision === 'approved'
          ? `${toIstDateString(record.workDate)} has been corrected.`
          : (input.reviewNote ?? 'No reason was given.'),
      entityType: 'AttendanceCorrection',
      entityId: correctionId,
      // A rejected correction means a day still counts against them, which is
      // worth knowing before the month closes rather than after.
      mobile: {
        template: 'correction_decided',
        values: {
          name: correction.requestedBy.name,
          date: toIstDateString(record.workDate),
          outcome: input.decision === 'approved' ? 'approved' : 'rejected',
        },
      },
    });

    return decided;
  }

  /* --------------------------------------------------------- day close job */

  /**
   * Closes one working day across every active assignment.
   *
   * Two things happen. A day left open becomes `missing_punch_out`, which is
   * what makes the correction flow reachable — an open day nobody ever closed
   * would sit as `present` forever and quietly count as a full day worked. And a
   * working day with no record at all becomes `absent`, because the absence of a
   * punch on a working day is the fact being recorded.
   *
   * Non-working days are skipped rather than written: a holiday is a property of
   * the project calendar, not of a person, and the calendar view fills them in.
   * Writing them would be a row per trainer per weekend that goes stale the
   * moment a holiday is added.
   *
   * Idempotent: re-running it finds the days already closed and leaves them.
   */
  async closeDay(workDate: string): Promise<{ missingPunchOut: number; absent: number }> {
    const assignments = await this.prisma.db.assignment.findMany({
      where: {
        status: 'active',
        startDate: { lte: date(workDate) },
        OR: [{ endDate: null }, { endDate: { gte: date(workDate) } }],
      },
      select: {
        id: true,
        projectId: true,
        project: { select: { weeklyOffDays: true } },
        attendance: {
          where: { workDate: date(workDate) },
          select: { id: true, status: true, punchInAt: true, punchOutAt: true },
        },
      },
    });

    // One holiday lookup per project, not per assignment.
    const holidaysByProject = new Map<string, string[]>();
    for (const projectId of new Set(assignments.map((row) => row.projectId))) {
      holidaysByProject.set(projectId, await this.context.holidays(projectId, workDate, workDate));
    }

    let missingPunchOut = 0;
    let absent = 0;

    for (const assignment of assignments) {
      const closed = nonWorkingReason(workDate, {
        weeklyOffDays: assignment.project.weeklyOffDays,
        holidays: holidaysByProject.get(assignment.projectId) ?? [],
      });
      if (closed) continue;

      const record = assignment.attendance[0];

      if (!record) {
        await this.prisma.db.attendanceRecord.create({
          data: {
            id: newId(),
            assignmentId: assignment.id,
            workDate: date(workDate),
            status: 'absent',
            source: 'system',
            locationStatus: 'unavailable',
          },
        });
        absent += 1;
        continue;
      }

      if (
        record.punchInAt &&
        !record.punchOutAt &&
        canTransition('attendance', record.status, 'missing_punch_out')
      ) {
        await this.prisma.db.attendanceRecord.update({
          where: { id: record.id },
          data: { status: 'missing_punch_out' },
        });
        missingPunchOut += 1;
      }
    }

    return { missingPunchOut, absent };
  }

  /* ------------------------------------------------------------- internals */

  /** Punched in but the day is not over: present or late, decided by the clock. */
  private openStatus(
    assignment: { project: { workStartTime: string; graceMinutes: number } },
    now: Date,
  ) {
    return attendanceStatusFromPunches({
      punchInAt: now,
      punchOutAt: now,
      workStartTime: assignment.project.workStartTime,
      graceMinutes: assignment.project.graceMinutes,
    });
  }

  private async notifyApprovers(
    projectId: string,
    message: { title: string; body: string; entityId: string },
  ): Promise<void> {
    const project = await this.prisma.db.project.findUnique({
      where: { id: projectId },
      select: { managerId: true, hrId: true, leadTrainerId: true },
    });
    if (!project) return;
    await this.notifications.notify({
      userIds: [project.leadTrainerId, project.managerId, project.hrId].filter((id): id is string =>
        Boolean(id),
      ),
      type: 'attendance_correction',
      title: message.title,
      body: message.body,
      entityType: 'AttendanceCorrection',
      entityId: message.entityId,
    });
  }
}

/* ----------------------------------------------------------------- helpers */

/** A work date is a calendar day, so it is stored at midnight UTC, not "now". */
export function date(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function istClock(instant: Date): string {
  const shifted = new Date(instant.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(11, 16);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function* eachDayOfMonth(from: string, to: string): Generator<string> {
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function summarise(statuses: string[]) {
  const counted = (...wanted: string[]) =>
    statuses.filter((status) => wanted.includes(status)).length;
  return {
    present: counted('present', 'corrected'),
    late: counted('late'),
    absent: counted('absent'),
    onLeave: counted('on_leave', 'half_day', 'leave_without_pay'),
    nonWorking: counted('holiday', 'weekly_off'),
    openIssues: counted('missing_punch_out', 'correction_pending'),
  };
}
