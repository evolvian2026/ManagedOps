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

/**
 * What a day's status is, given only the punches on it.
 *
 * Used when a punch is recorded, when the nightly close runs, and when a
 * rejected correction has to put a day back the way it was. One function for all
 * three means a day cannot end up labelled differently depending on which path
 * last touched it.
 */
export function attendanceStatusFromPunches(options: {
  punchInAt: Date | null;
  punchOutAt: Date | null;
  workStartTime: string;
  graceMinutes?: number;
}): 'present' | 'late' | 'missing_punch_out' | 'absent' {
  const { punchInAt, punchOutAt, workStartTime, graceMinutes } = options;
  if (!punchInAt) return 'absent';
  if (!punchOutAt) return 'missing_punch_out';
  return isLatePunchIn(punchInAt, workStartTime, graceMinutes) ? 'late' : 'present';
}

/** Statuses that mean the day was accounted for by leave rather than worked. */
export const LEAVE_ATTENDANCE_STATUSES = ['on_leave', 'half_day', 'leave_without_pay'] as const;

/**
 * Whether a calendar date is a working day for a project.
 *
 * Weekly offs and holidays are properties of the calendar, not of a person, so
 * they are derived here rather than stored per trainer per day.
 */
export function isWorkingDay(
  date: string,
  options: { weeklyOffDays?: readonly number[]; holidays?: readonly string[] } = {},
): boolean {
  const weeklyOff = new Set(options.weeklyOffDays ?? [0]);
  const holidays = new Set(options.holidays ?? []);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  return !weeklyOff.has(dayOfWeek) && !holidays.has(date);
}

/** The non-working reason for a date, or null when it is an ordinary working day. */
export function nonWorkingReason(
  date: string,
  options: { weeklyOffDays?: readonly number[]; holidays?: readonly string[] } = {},
): 'holiday' | 'weekly_off' | null {
  const holidays = new Set(options.holidays ?? []);
  if (holidays.has(date)) return 'holiday';
  const weeklyOff = new Set(options.weeklyOffDays ?? [0]);
  return weeklyOff.has(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 'weekly_off' : null;
}

/** Spec 4.7 — HR approves up to this; above it a Manager must sign off. */
export const REIMBURSEMENT_HR_LIMIT = 10_000;

export function needsHighValueApproval(amount: number): boolean {
  return amount > REIMBURSEMENT_HR_LIMIT;
}

/* ------------------------------------------------------------- commercials */

/** Kept structural so this file does not depend on the Prisma enum's identity. */
type AttendanceStatusLike =
  | 'present'
  | 'late'
  | 'corrected'
  | 'missing_punch_out'
  | 'correction_pending'
  | 'half_day'
  | 'on_leave'
  | 'holiday'
  | 'weekly_off'
  | 'absent'
  | 'leave_without_pay';

interface DayValue {
  /** Does the client pay for it? Only days actually delivered. */
  billable: number;
  /** Does the trainer earn a working day's pay for it? */
  payable: number;
  /** Is it a working day at all — that is, part of the denominator? */
  working: number;
}

/**
 * How a day's attendance status turns into money.
 *
 * Three questions get asked of every recorded day and they have three different
 * answers, which is why this is a table rather than a pair of booleans.
 *
 * The one that is easy to get wrong is `working`. A weekly off or a holiday is
 * not an unpaid day — nobody is docked for a Sunday — but neither is it a day
 * of pay earned. It sits outside the working calendar altogether, which is
 * exactly how it has to be treated for a salary to prorate correctly: a month's
 * pay is spread over its *working* days, so counting Sundays into either side
 * of that ratio would quietly understate the cost of every day taught.
 *
 * `half_day` is written only when half a day of *paid* leave is approved, so
 * the trainer delivered half a day and earned a full one. Leave beyond the
 * allowance becomes `leave_without_pay`, which earns nothing.
 *
 * `missing_punch_out` and `correction_pending` are billable because the trainer
 * was demonstrably there. Somebody still has to decide what time they left, but
 * not whether they came.
 */
const DAY_VALUE: Record<AttendanceStatusLike, DayValue> = {
  present: { billable: 1, payable: 1, working: 1 },
  late: { billable: 1, payable: 1, working: 1 },
  corrected: { billable: 1, payable: 1, working: 1 },
  missing_punch_out: { billable: 1, payable: 1, working: 1 },
  correction_pending: { billable: 1, payable: 1, working: 1 },
  half_day: { billable: 0.5, payable: 1, working: 1 },
  on_leave: { billable: 0, payable: 1, working: 1 },
  absent: { billable: 0, payable: 0, working: 1 },
  leave_without_pay: { billable: 0, payable: 0, working: 1 },
  holiday: { billable: 0, payable: 0, working: 0 },
  weekly_off: { billable: 0, payable: 0, working: 0 },
};

export interface DayTally {
  /** Days the client is charged for. */
  billableDays: number;
  /** Working days the trainer earned pay for. */
  payableDays: number;
  /** Working days covered by these records, ignoring weekly offs and holidays. */
  workingDays: number;
}

/** Adds up what a set of attendance days is worth on each side of the ledger. */
export function tallyDays(statuses: readonly string[]): DayTally {
  let billableDays = 0;
  let payableDays = 0;
  let workingDays = 0;

  for (const status of statuses) {
    const value = DAY_VALUE[status as AttendanceStatusLike];
    // An unrecognised status is not silently treated as free labour: it counts
    // as nothing anywhere, and the totals visibly fail to add up.
    if (!value) continue;
    billableDays += value.billable;
    payableDays += value.payable;
    workingDays += value.working;
  }

  return {
    billableDays: round2(billableDays),
    payableDays: round2(payableDays),
    workingDays: round2(workingDays),
  };
}

export interface MarginInput {
  /** Days delivered, from `tallyDays`. */
  billableDays: number;
  /** INR per delivered day. Null when the work is not billed at all. */
  dayRate: number | null;
  /** The trainer's annual salary in INR, or null when it is not recorded. */
  salaryAnnual: number | null;
  /** Working days this assignment earned pay for, from `tallyDays`. */
  payableDays: number;
  /**
   * Working days the whole period contains for this project.
   *
   * The denominator is the period, never the assignment. An assignment that
   * began halfway through the month has half the payable days and must
   * therefore carry half the month's salary — measuring it against its own
   * length would charge every partial assignment a full month.
   */
  workingDaysInPeriod: number;
  /** Calendar months the period spans; 1 for a single month. */
  months?: number;
  /** Reimbursements approved in the period, in INR. */
  reimbursements?: number;
}

export interface Margin {
  revenue: number;
  salaryCost: number;
  reimbursements: number;
  cost: number;
  margin: number;
  /** Margin as a percentage of revenue, or null when there was no revenue. */
  marginPercent: number | null;
  /** No rate agreed, so a zero margin means "not sold", not "sold at cost". */
  unbilled: boolean;
}

/**
 * What a period of delivery earned and what it cost.
 *
 * Revenue is per delivered day; cost is a monthly salary spread across the
 * period's working days and drawn down by the days this assignment actually
 * earned. That asymmetry is the real one — a client pays for days taught, while
 * a salaried trainer is paid through approved leave — and it is precisely why
 * margin cannot be read off a day rate alone.
 *
 * An assignment with no rate is reported as `unbilled` rather than as a total
 * loss. Booking internal work at a 100% loss would make every roll-up above it
 * meaningless.
 */
export function computeMargin(input: MarginInput): Margin {
  const months = input.months ?? 1;
  const reimbursements = input.reimbursements ?? 0;

  const revenue = input.dayRate == null ? 0 : round2(input.billableDays * input.dayRate);

  const monthlySalary = input.salaryAnnual == null ? 0 : input.salaryAnnual / 12;
  const periodSalary = monthlySalary * months;
  // A period with no working days in it has nothing to spread a salary over,
  // and nothing was earned in it either — so the cost is zero rather than NaN.
  const earnedShare =
    input.workingDaysInPeriod > 0 ? Math.min(1, input.payableDays / input.workingDaysInPeriod) : 0;
  const salaryCost = round2(Math.max(0, periodSalary * earnedShare));

  const cost = round2(salaryCost + reimbursements);
  const margin = round2(revenue - cost);

  return {
    revenue,
    salaryCost,
    reimbursements: round2(reimbursements),
    cost,
    margin,
    marginPercent: revenue > 0 ? round2((margin / revenue) * 100) : null,
    unbilled: input.dayRate == null,
  };
}

/** Money is summed and compared, so it is rounded here rather than at each display. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
