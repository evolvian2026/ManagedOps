import { Injectable } from '@nestjs/common';
import {
  MISSED_INTERVIEW_ARCHIVE_DAYS,
  OPERATIONAL_TIMEZONE,
  assertTransition,
  type InterviewOutcomeInput,
  type InterviewQuery,
  type RescheduleInterviewInput,
  type ScheduleInterviewInput,
  type UpdateInterviewInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { interviewScope, scopedWhere } from '../../common/scope.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { ApplicationsService } from './applications.service.js';

const SORTABLE = ['scheduledAt', 'createdAt', 'round', 'status'] as const;

const ROW_SELECT = {
  id: true,
  round: true,
  scheduledAt: true,
  durationMinutes: true,
  meetingUrl: true,
  recordingUrl: true,
  status: true,
  outcome: true,
  feedback: true,
  conductedAt: true,
  archivedAt: true,
  previousInterviewId: true,
  createdAt: true,
  interviewer: { select: { id: true, name: true, email: true } },
  application: {
    select: {
      id: true,
      status: true,
      candidate: {
        select: { id: true, name: true, email: true, phone: true, resumeFileId: true },
      },
      position: {
        select: {
          id: true,
          title: true,
          project: { select: { id: true, name: true, code: true } },
        },
      },
    },
  },
} as const;

/** What the interview board renders on each position card. */
export interface PositionSummary {
  id: string;
  title: string;
  status: string;
  project: { id: string; name: string; code: string };
}

export interface PipelineCard {
  position: PositionSummary;
  /** Applications in the interview stage with no live round booked. */
  toBeScheduled: number;
  scheduled: number;
  conducted: number;
  missed: number;
  selected: number;
  rejected: number;
}

/** Renders an instant the way it will be read: in IST, because that is the
 *  only timezone the business operates in (spec assumption A3). */
function formatIst(instant: Date): string {
  return `${instant.toLocaleString('en-IN', {
    timeZone: OPERATIONAL_TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  })} IST`;
}

@Injectable()
export class InterviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: InterviewQuery, user: AuthenticatedUser) {
    const where = scopedWhere(interviewScope(user), {
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.positionId ? { application: { positionId: query.positionId } } : {}),
      ...(query.interviewerId ? { interviewerId: query.interviewerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            scheduledAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      // Archived rounds are kept forever but stay out of the working views.
      ...(query.includeArchived === 'true' ? {} : { archivedAt: null }),
    });

    const page = toPrismaPage(query, SORTABLE, { scheduledAt: 'asc' });
    const [data, total] = await Promise.all([
      this.prisma.db.interview.findMany({ where, ...page, select: ROW_SELECT }),
      this.prisma.db.interview.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  /**
   * The Interview Pipeline board: one card per position, carrying the counts the
   * three tabs will show.
   *
   * "To be scheduled" is not a stored state — it is the set of applications in
   * `interviewing` with no live round, derived here so it can never disagree
   * with the interviews themselves.
   */
  async pipeline(user: AuthenticatedUser) {
    const scope = interviewScope(user);

    const [byPosition, awaiting] = await Promise.all([
      this.prisma.db.interview.findMany({
        where: { ...scope, archivedAt: null },
        select: {
          status: true,
          outcome: true,
          application: {
            select: {
              positionId: true,
              position: {
                select: {
                  id: true,
                  title: true,
                  status: true,
                  project: { select: { id: true, name: true, code: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.db.application.findMany({
        where: {
          status: 'interviewing',
          interviews: { none: { status: 'scheduled', archivedAt: null } },
        },
        select: {
          positionId: true,
          position: {
            select: {
              id: true,
              title: true,
              status: true,
              project: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
    ]);

    const cards = new Map<string, PipelineCard>();

    const card = (positionId: string, position: PositionSummary): PipelineCard => {
      let entry = cards.get(positionId);
      if (!entry) {
        entry = {
          position,
          toBeScheduled: 0,
          scheduled: 0,
          conducted: 0,
          missed: 0,
          selected: 0,
          rejected: 0,
        };
        cards.set(positionId, entry);
      }
      return entry;
    };

    for (const row of byPosition) {
      const entry = card(row.application.positionId, row.application.position);
      if (row.status === 'scheduled') entry.scheduled += 1;
      if (row.status === 'completed') entry.conducted += 1;
      if (row.status === 'missed') entry.missed += 1;
      if (row.outcome === 'selected') entry.selected += 1;
      if (row.outcome === 'rejected') entry.rejected += 1;
    }

    for (const row of awaiting) {
      card(row.positionId, row.position).toBeScheduled += 1;
    }

    return {
      data: [...cards.values()].sort((a, b) => a.position.title.localeCompare(b.position.title)),
    };
  }

  async get(id: string, user: AuthenticatedUser) {
    const interview = await this.prisma.db.interview.findFirst({
      where: scopedWhere(interviewScope(user), { id }),
      select: ROW_SELECT,
    });
    if (!interview) throw new NotFoundProblem('That interview');
    return interview;
  }

  async schedule(input: ScheduleInterviewInput, actor: AuthenticatedUser) {
    const application = await this.applications.requireVisible(input.applicationId, actor);

    if (application.status !== 'interviewing') {
      throw new DomainRuleProblem(
        'not-in-interview-stage',
        `${application.candidate.name} is ${application.status.replace(/_/g, ' ')}. Screen them through to interview first.`,
      );
    }

    this.assertFuture(input.scheduledAt);

    const open = await this.prisma.db.interview.findFirst({
      where: { applicationId: input.applicationId, status: 'scheduled', archivedAt: null },
    });
    if (open) {
      throw new DomainRuleProblem(
        'interview-already-scheduled',
        `${application.candidate.name} already has an interview booked for ${formatIst(open.scheduledAt)}. Reschedule that one instead.`,
      );
    }

    await this.assertInterviewerIsValid(input.interviewerId);

    const round = await this.nextRound(input.applicationId);
    const interview = await this.prisma.db.interview.create({
      data: {
        id: newId(),
        applicationId: input.applicationId,
        round,
        scheduledAt: input.scheduledAt,
        durationMinutes: input.durationMinutes,
        meetingUrl: input.meetingUrl,
        interviewerId: input.interviewerId,
        createdById: actor.userId,
      },
      select: ROW_SELECT,
    });

    await this.announce(interview, 'interview_scheduled', 'Interview scheduled');
    return interview;
  }

  async update(id: string, input: UpdateInterviewInput, actor: AuthenticatedUser) {
    const interview = await this.prisma.db.interview.findUnique({ where: { id } });
    if (!interview) throw new NotFoundProblem('That interview');

    if (interview.status !== 'scheduled') {
      throw new DomainRuleProblem(
        'interview-not-open',
        `This interview is ${interview.status}, so its details can no longer be changed.`,
      );
    }
    if (input.scheduledAt) this.assertFuture(input.scheduledAt);
    await this.assertInterviewerIsValid(input.interviewerId);

    return this.prisma.db.interview.update({
      where: { id },
      data: {
        ...input,
        // Moving the time invalidates any reminder already sent for the old one.
        ...(input.scheduledAt ? { dayReminderSentAt: null, imminentReminderSentAt: null } : {}),
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });
  }

  /**
   * Records what happened. Selecting advances the application to the offer
   * stage; rejecting closes it and leaves the person in the pool with a reason.
   */
  async recordOutcome(id: string, input: InterviewOutcomeInput, actor: AuthenticatedUser) {
    const interview = await this.prisma.db.interview.findFirst({
      where: scopedWhere(interviewScope(actor, 'interviews.record_outcome'), { id }),
      include: { application: { select: { id: true, status: true } } },
    });
    if (!interview) throw new NotFoundProblem('That interview');

    assertTransition('interview', interview.status, 'completed');

    const updated = await this.prisma.db.interview.update({
      where: { id },
      data: {
        status: 'completed',
        outcome: input.outcome,
        feedback: input.feedback,
        recordingUrl: input.recordingUrl,
        conductedAt: new Date(),
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });

    if (input.outcome === 'selected') {
      await this.applications.advance(interview.applicationId, 'offer_stage', actor);
    } else {
      await this.applications.advance(interview.applicationId, 'rejected_interview', actor, {
        rejectionReason: input.feedback.slice(0, 500),
      });
    }

    return updated;
  }

  /**
   * A missed interview is never rewritten into a new booking. Rescheduling
   * creates the next round linked back to it, so the fact that someone missed
   * an interview survives in the record.
   */
  async reschedule(id: string, input: RescheduleInterviewInput, actor: AuthenticatedUser) {
    const previous = await this.prisma.db.interview.findUnique({
      where: { id },
      include: { application: { select: { id: true, status: true } } },
    });
    if (!previous) throw new NotFoundProblem('That interview');

    if (previous.status !== 'missed' && previous.status !== 'scheduled') {
      throw new DomainRuleProblem(
        'cannot-reschedule',
        `This interview is ${previous.status}, so there is nothing to reschedule.`,
      );
    }
    // The replacement round points back at this one, so its existence is the
    // check — there is no forward pointer to keep in step.
    const replacement = await this.prisma.db.interview.findFirst({
      where: { previousInterviewId: id },
      select: { id: true, round: true },
    });
    if (replacement) {
      throw new DomainRuleProblem(
        'already-rescheduled',
        `This interview was already rescheduled into round ${replacement.round}.`,
      );
    }

    this.assertFuture(input.scheduledAt);
    await this.assertInterviewerIsValid(input.interviewerId);

    const round = await this.nextRound(previous.applicationId);

    // Marking the old round missed and creating the replacement is one change:
    // a failure between them would leave the candidate with two live rounds.
    const [, created] = await this.prisma.db.$transaction([
      this.prisma.db.interview.update({
        where: { id },
        data: {
          status: 'missed',
          updatedById: actor.userId,
        },
      }),
      this.prisma.db.interview.create({
        data: {
          id: newId(),
          applicationId: previous.applicationId,
          round,
          scheduledAt: input.scheduledAt,
          durationMinutes: previous.durationMinutes,
          meetingUrl: input.meetingUrl ?? previous.meetingUrl,
          interviewerId: input.interviewerId ?? previous.interviewerId,
          previousInterviewId: id,
          createdById: actor.userId,
        },
        select: ROW_SELECT,
      }),
    ]);

    await this.announce(created, 'interview_scheduled', 'Interview rescheduled');
    return created;
  }

  async markMissed(id: string, actor: AuthenticatedUser) {
    const interview = await this.prisma.db.interview.findUnique({ where: { id } });
    if (!interview) throw new NotFoundProblem('That interview');

    assertTransition('interview', interview.status, 'missed');
    return this.prisma.db.interview.update({
      where: { id },
      data: { status: 'missed', updatedById: actor.userId },
      select: ROW_SELECT,
    });
  }

  async cancel(id: string, reason: string | undefined, actor: AuthenticatedUser) {
    const interview = await this.prisma.db.interview.findUnique({ where: { id } });
    if (!interview) throw new NotFoundProblem('That interview');

    assertTransition('interview', interview.status, 'cancelled');
    return this.prisma.db.interview.update({
      where: { id },
      data: {
        status: 'cancelled',
        feedback: reason ?? interview.feedback,
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });
  }

  /* --------------------------------------------------------------- jobs */

  /** Interviews starting today, for the 09:00 IST reminder. */
  async dueForDayReminder(now: Date) {
    const endOfDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return this.prisma.db.interview.findMany({
      where: {
        status: 'scheduled',
        archivedAt: null,
        dayReminderSentAt: null,
        scheduledAt: { gte: now, lte: endOfDay },
      },
      select: ROW_SELECT,
      take: 200,
    });
  }

  /** Interviews starting in the next 30 to 35 minutes. */
  async dueForImminentReminder(now: Date) {
    return this.prisma.db.interview.findMany({
      where: {
        status: 'scheduled',
        archivedAt: null,
        imminentReminderSentAt: null,
        scheduledAt: {
          gte: new Date(now.getTime() + 30 * 60 * 1000),
          lte: new Date(now.getTime() + 35 * 60 * 1000),
        },
      },
      select: ROW_SELECT,
      take: 200,
    });
  }

  async markReminderSent(id: string, kind: 'day' | 'imminent'): Promise<void> {
    await this.prisma.db.interview.update({
      where: { id },
      data:
        kind === 'day' ? { dayReminderSentAt: new Date() } : { imminentReminderSentAt: new Date() },
    });
  }

  /**
   * Archives rounds missed more than 30 days ago (spec 15.8). Archived, never
   * deleted: destroying recruitment records on a timer is a data-loss and
   * compliance hazard, and archiving gives the same clean board.
   */
  async archiveStaleMissed(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - MISSED_INTERVIEW_ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.prisma.db.interview.updateMany({
      where: { status: 'missed', archivedAt: null, scheduledAt: { lt: cutoff } },
      data: { archivedAt: now },
    });
    return result.count;
  }

  /** Turns a scheduled interview whose time has passed into a missed one. */
  async sweepOverdue(now: Date): Promise<number> {
    const result = await this.prisma.db.interview.updateMany({
      // A grace window stops an interview being marked missed while it is
      // still running.
      where: {
        status: 'scheduled',
        archivedAt: null,
        scheduledAt: { lt: new Date(now.getTime() - 4 * 60 * 60 * 1000) },
      },
      data: { status: 'missed' },
    });
    return result.count;
  }

  /* ------------------------------------------------------------ helpers */

  private async nextRound(applicationId: string): Promise<number> {
    const latest = await this.prisma.db.interview.findFirst({
      where: { applicationId },
      orderBy: { round: 'desc' },
      select: { round: true },
    });
    return (latest?.round ?? 0) + 1;
  }

  private assertFuture(when: Date): void {
    if (when.getTime() <= Date.now()) {
      throw new ValidationProblem('Choose a time in the future.', [
        { path: 'scheduledAt', message: 'is in the past' },
      ]);
    }
  }

  private async assertInterviewerIsValid(interviewerId?: string): Promise<void> {
    if (!interviewerId) return;
    const user = await this.prisma.db.user.findFirst({
      where: { id: interviewerId, status: 'active' },
      select: { role: true, name: true },
    });
    if (!user) {
      throw new ValidationProblem('That interviewer is not an active account.', [
        { path: 'interviewerId', message: 'is not an active account' },
      ]);
    }
    if (!['interviewer', 'manager', 'hr', 'super_admin'].includes(user.role)) {
      throw new ValidationProblem(
        `${user.name} is a ${user.role.replace(/_/g, ' ')} and cannot be assigned as an interviewer.`,
        [{ path: 'interviewerId', message: 'cannot conduct interviews' }],
      );
    }
  }

  private async announce(
    interview: {
      id: string;
      scheduledAt: Date;
      meetingUrl: string | null;
      interviewer: { id: string; name: string } | null;
      application: { candidate: { name: string; email: string }; position: { title: string } };
    },
    type: 'interview_scheduled' | 'interview_reminder',
    title: string,
  ): Promise<void> {
    const when = formatIst(interview.scheduledAt);
    const body = `${interview.application.candidate.name} — ${interview.application.position.title}, ${when}.`;

    await this.notifications.notify({
      userIds: interview.interviewer ? [interview.interviewer.id] : [],
      type,
      title,
      body,
      entityType: 'Interview',
      entityId: interview.id,
      email: {
        to: interview.application.candidate.email,
        subject: `${title}: ${interview.application.position.title}`,
        text:
          `Hello ${interview.application.candidate.name},\n\n` +
          `Your interview for ${interview.application.position.title} is on ${when}.\n` +
          (interview.meetingUrl ? `\nJoin here: ${interview.meetingUrl}\n` : '') +
          `\nIf that time does not work, reply to this email and we will rearrange it.\n`,
      },
    });
  }
}
