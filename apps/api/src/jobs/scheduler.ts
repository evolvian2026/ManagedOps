import PgBoss from 'pg-boss';
import { Logger } from '@nestjs/common';

/**
 * Every scheduled job the product runs, in one table.
 *
 * pg-boss keeps the queue in PostgreSQL itself, so the whole system needs no
 * Redis — one fewer service to run, back up and secure, at a scale where a
 * dedicated broker would buy nothing.
 *
 * Cron expressions are evaluated in the operational timezone, which is IST.
 */
export const OPERATIONAL_TZ = 'Asia/Kolkata';

export interface ScheduledJob {
  name: string;
  cron: string;
  description: string;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: 'interview.reminder.daily',
    cron: '0 9 * * *',
    description: "Notify candidates and interviewers about today's interviews",
  },
  {
    name: 'interview.reminder.imminent',
    cron: '*/5 * * * *',
    description: 'Notify about interviews starting in the next 30 to 35 minutes',
  },
  {
    name: 'interview.archive.stale',
    cron: '0 2 * * *',
    description: 'Archive interviews missed more than 30 days ago',
  },
  {
    name: 'attendance.close.day',
    cron: '55 23 * * *',
    description: 'Mark missing punch-outs and write absences for the day',
  },
  {
    name: 'onboarding.document.remind',
    cron: '0 10 * * *',
    description: 'Send 24h and 72h document reminders, escalating to HR at 72h',
  },
  {
    name: 'leave.escalate',
    cron: '0 * * * *',
    description: 'Escalate leave requests undecided for 24 hours',
  },
  {
    name: 'files.cleanup.orphans',
    cron: '0 3 * * 0',
    description: 'Remove uploads that were never attached to a record',
  },
];

export type JobHandler = () => Promise<void>;

/**
 * Wraps a handler so a failure is logged and retried by pg-boss rather than
 * taking the worker process down. Handlers are written to be idempotent, so a
 * retry can never double-send a reminder.
 */
export function safely(name: string, logger: Logger, handler: JobHandler) {
  return async (): Promise<void> => {
    const startedAt = Date.now();
    try {
      await handler();
      logger.log({ job: name, ms: Date.now() - startedAt }, 'Job completed');
    } catch (error) {
      logger.error({ job: name, err: error }, 'Job failed and will be retried');
      throw error;
    }
  };
}

export async function createBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    // Keep the queue tables out of the application schema.
    schema: 'pgboss',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
  await boss.start();
  return boss;
}
