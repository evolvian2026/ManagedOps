import { Injectable, Logger } from '@nestjs/common';
import { OPERATIONAL_TIMEZONE } from '@managedops/shared';
import { InterviewsService } from '../modules/recruitment/interviews.service.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';

/**
 * The scheduled work recruitment owns.
 *
 * Every handler is idempotent: a reminder stamps the row it sent for, and the
 * queries only ever select rows without that stamp. pg-boss retries a failed job,
 * so a handler that could double-send would eventually double-send.
 */
@Injectable()
export class InterviewJobs {
  private readonly logger = new Logger(InterviewJobs.name);

  constructor(
    private readonly interviews: InterviewsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 09:00 IST — everything happening today. */
  async sendDayReminders(now = new Date()): Promise<number> {
    const due = await this.interviews.dueForDayReminder(now);

    for (const interview of due) {
      await this.remind(interview, 'Interview today');
      await this.interviews.markReminderSent(interview.id, 'day');
    }

    if (due.length > 0) this.logger.log({ count: due.length }, 'Sent day-of interview reminders');
    return due.length;
  }

  /** Every five minutes — anything starting in the next half hour. */
  async sendImminentReminders(now = new Date()): Promise<number> {
    const due = await this.interviews.dueForImminentReminder(now);

    for (const interview of due) {
      await this.remind(interview, 'Interview in 30 minutes');
      await this.interviews.markReminderSent(interview.id, 'imminent');
    }

    if (due.length > 0) this.logger.log({ count: due.length }, 'Sent imminent interview reminders');
    return due.length;
  }

  /**
   * Nightly tidy-up. Interviews whose time passed hours ago become missed, and
   * ones missed for more than thirty days are archived — archived, never
   * deleted (spec 15.8).
   */
  async archiveStale(now = new Date()): Promise<{ markedMissed: number; archived: number }> {
    const markedMissed = await this.interviews.sweepOverdue(now);
    const archived = await this.interviews.archiveStaleMissed(now);

    if (markedMissed > 0 || archived > 0) {
      this.logger.log({ markedMissed, archived }, 'Tidied up stale interviews');
    }
    return { markedMissed, archived };
  }

  private async remind(
    interview: {
      id: string;
      scheduledAt: Date;
      meetingUrl: string | null;
      interviewer: { id: string; name: string } | null;
      application: {
        candidate: { name: string; email: string };
        position: { title: string };
      };
    },
    title: string,
  ): Promise<void> {
    const when = `${interview.scheduledAt.toLocaleString('en-IN', {
      timeZone: OPERATIONAL_TIMEZONE,
      dateStyle: 'medium',
      timeStyle: 'short',
    })} IST`;

    await this.notifications.notify({
      userIds: interview.interviewer ? [interview.interviewer.id] : [],
      type: 'interview_reminder',
      title,
      body: `${interview.application.candidate.name} — ${interview.application.position.title}, ${when}.`,
      entityType: 'Interview',
      entityId: interview.id,
      email: {
        to: interview.application.candidate.email,
        subject: `${title}: ${interview.application.position.title}`,
        text:
          `Hello ${interview.application.candidate.name},\n\n` +
          `A reminder that your interview for ${interview.application.position.title} is at ${when}.\n` +
          (interview.meetingUrl ? `\nJoin here: ${interview.meetingUrl}\n` : '') +
          `\nGood luck.\n`,
      },
    });
  }
}
