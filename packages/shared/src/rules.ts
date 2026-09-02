import { LEAVE_DAY_TYPES, type LeaveDayType } from './enums.js';

/**
 * Business constants and the pure calculations that depend on them. Kept free of
 * I/O so both the API and the web client can reason about the same numbers, and
 * so every rule here is unit-testable without a database.
 */

/** All operational times are IST. India observes no DST, so this is a fixed offset. */
export const OPERATIONAL_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** Spec assumption A6 — absorbs ordinary commute variance without hiding real lateness. */
export const DEFAULT_GRACE_MINUTES = 15;

/** Spec assumption A5 — per assignment, not per person, and never carried over. */
export const DEFAULT_LEAVE_ALLOWANCE_DAYS = 3;

/** Spec 4.4 — a target that triggers reminders, not a lock-out (spec 15.7). */
export const DOCUMENT_REMINDER_HOURS = [24, 72] as const;

/** Spec 4.6 — how long a leave request may sit before it escalates past the lead. */
export const LEAVE_ESCALATION_HOURS = 24;

/** Spec 4.2 — a missed interview is archived, never deleted. */
export const MISSED_INTERVIEW_ARCHIVE_DAYS = 30;

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 7;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;

/** Presigned download URLs are deliberately short-lived; they are also audited. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export const DAY_TYPE_COST: Readonly<Record<LeaveDayType, number>> = {
  full: 1,
  half: 0.5,
};

/** Renders a Date as the `YYYY-MM-DD` work date it falls on in IST. */
export function toIstDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Minutes past midnight IST, used to decide present vs late. */
export function istMinutesOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Parses `HH:MM` (a project's configured start time) into minutes past midnight. */
export function parseClockTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Expected a HH:MM time, received "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`"${value}" is not a valid time of day`);
  return hours * 60 + minutes;
}

export function isLatePunchIn(
  punchInAt: Date,
  workStartTime: string,
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
): boolean {
  return istMinutesOfDay(punchInAt) > parseClockTime(workStartTime) + graceMinutes;
}

/**
 * Counts the leave days a request consumes. Weekends and holidays inside the
 * range are free (spec 4.6), and a half day is only meaningful on a single date.
 */
export function countLeaveDays(options: {
  startDate: string;
  endDate: string;
  dayType: LeaveDayType;
  holidays?: readonly string[];
  weeklyOffDays?: readonly number[];
}): number {
  const { startDate, endDate, dayType } = options;
  const holidays = new Set(options.holidays ?? []);
  const weeklyOff = new Set(options.weeklyOffDays ?? [0]);

  if (!LEAVE_DAY_TYPES.includes(dayType)) throw new Error(`Unknown leave day type "${dayType}"`);
  if (endDate < startDate) throw new Error('A leave request cannot end before it starts');
  if (dayType === 'half' && startDate !== endDate) {
    throw new Error('A half day applies to a single date');
  }

  let workingDays = 0;
  for (const date of eachDate(startDate, endDate)) {
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weeklyOff.has(dayOfWeek) || holidays.has(date)) continue;
    workingDays += 1;
  }
  return workingDays === 0 ? 0 : workingDays * DAY_TYPE_COST[dayType];
}

export function* eachDate(startDate: string, endDate: string): Generator<string> {
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

export interface LeaveBalance {
  allowance: number;
  used: number;
  remaining: number;
  /** Days beyond the allowance, which are recorded as leave without pay. */
  unpaid: number;
}

export function computeLeaveBalance(
  allowance: number,
  usedDays: number,
  requestedDays = 0,
): LeaveBalance {
  const remaining = Math.max(0, allowance - usedDays);
  const unpaid = Math.max(0, requestedDays - remaining);
  return { allowance, used: usedDays, remaining, unpaid };
}
