import {
  LEAVE_DAY_TYPES,
  PROFICIENCIES,
  PROFICIENCY_RANK,
  type LeaveDayType,
  type Proficiency,
  type SkillRequirement,
} from './enums.js';

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

/* ---------------------------------------------------------------- matching */

/**
 * Scoring a trainer against what a position needs.
 *
 * The output is a number and a list of sentences, and the sentences are the
 * point. A ranked list of people with a bare "87" against each name tells a
 * staffer nothing they can act on or argue with, so every component of the
 * score also states itself in words.
 *
 * Two rules shape the arithmetic:
 *
 *  - An essential skill that is missing is disqualifying, not merely costly.
 *    Ranking somebody top because they are strong on four desirable skills
 *    while lacking the one thing the position exists for is exactly the
 *    plausible-looking answer that makes people stop trusting the tool.
 *  - Recency counts. A skill last used four years ago is a different
 *    proposition from the same skill used last month, and pretending they are
 *    equal would flatter a stale profile.
 */

export interface RequiredSkill {
  skillId: string;
  name: string;
  requirement: SkillRequirement;
  /** The floor, when one matters. Null means any level counts. */
  minProficiency?: Proficiency | null;
}

export interface HeldSkill {
  skillId: string;
  proficiency: Proficiency;
  years?: number | null;
  /** `YYYY-MM-DD`, or null when nobody has said. */
  lastUsedOn?: string | null;
}

export interface SkillMatch {
  skillId: string;
  name: string;
  requirement: SkillRequirement;
  held: boolean;
  proficiency: Proficiency | null;
  /** Held, but below the level the position asked for. */
  belowRequestedLevel: boolean;
}

export interface MatchResult {
  /** 0 to 100. Zero when an essential skill is missing. */
  score: number;
  /** True when every essential skill is held at or above the level asked for. */
  eligible: boolean;
  matches: SkillMatch[];
  /** Plain sentences explaining the score, strongest reason first. */
  reasons: string[];
}

/** Weights: essentials carry the decision, the rest adjust it. */
const ESSENTIAL_WEIGHT = 60;
const DESIRABLE_WEIGHT = 25;
const DEPTH_WEIGHT = 10;
const RECENCY_WEIGHT = 5;

/** Beyond this, a skill is treated as stale rather than current. */
const STALE_AFTER_MONTHS = 24;

export function scoreMatch(
  required: readonly RequiredSkill[],
  held: readonly HeldSkill[],
  options: { today?: string } = {},
): MatchResult {
  const byId = new Map(held.map((skill) => [skill.skillId, skill]));
  const essentials = required.filter((skill) => skill.requirement === 'essential');
  const desirables = required.filter((skill) => skill.requirement === 'desirable');

  const matches: SkillMatch[] = required.map((requirement) => {
    const holding = byId.get(requirement.skillId);
    const meetsLevel =
      holding != null &&
      (requirement.minProficiency == null ||
        PROFICIENCY_RANK[holding.proficiency] >= PROFICIENCY_RANK[requirement.minProficiency]);

    return {
      skillId: requirement.skillId,
      name: requirement.name,
      requirement: requirement.requirement,
      held: meetsLevel,
      proficiency: holding?.proficiency ?? null,
      belowRequestedLevel: holding != null && !meetsLevel,
    };
  });

  // Only the missing ones need naming: reaching past the early return below
  // means every essential was met.
  const essentialsMissing = matches.filter((m) => m.requirement === 'essential' && !m.held);
  const desirablesMet = matches.filter((m) => m.requirement === 'desirable' && m.held);

  const reasons: string[] = [];

  // A position with no stated essentials cannot disqualify anybody on them.
  if (essentialsMissing.length > 0) {
    const short = essentialsMissing.map((m) =>
      m.belowRequestedLevel ? `${m.name} (below the level asked for)` : m.name,
    );
    reasons.push(`Missing an essential skill: ${short.join(', ')}.`);
    return { score: 0, eligible: false, matches, reasons };
  }

  reasons.push(
    essentials.length === 0
      ? 'This position lists no essential skills, so nobody is ruled out on them.'
      : `Has all ${essentials.length} essential skill${essentials.length === 1 ? '' : 's'}.`,
  );

  let score = ESSENTIAL_WEIGHT;

  if (desirables.length > 0) {
    score += (desirablesMet.length / desirables.length) * DESIRABLE_WEIGHT;
    reasons.push(
      `Has ${desirablesMet.length} of ${desirables.length} desirable skill${desirables.length === 1 ? '' : 's'}.`,
    );
  } else {
    // Nothing desirable to distinguish people on, so the band is not withheld
    // from everybody — it would only compress the whole list against the top.
    score += DESIRABLE_WEIGHT;
  }

  // Depth across the skills that were actually asked for.
  const relevant = required
    .map((requirement) => byId.get(requirement.skillId))
    .filter((skill): skill is HeldSkill => skill != null);

  if (relevant.length > 0) {
    const depth =
      relevant.reduce((total, skill) => total + PROFICIENCY_RANK[skill.proficiency], 0) /
      (relevant.length * (PROFICIENCIES.length - 1));
    score += depth * DEPTH_WEIGHT;

    const strongest = [...relevant].sort(
      (a, b) => PROFICIENCY_RANK[b.proficiency] - PROFICIENCY_RANK[a.proficiency],
    )[0]!;
    if (PROFICIENCY_RANK[strongest.proficiency] >= PROFICIENCY_RANK.advanced) {
      const name =
        required.find((r) => r.skillId === strongest.skillId)?.name ?? 'a required skill';
      reasons.push(`${strongest.proficiency} in ${name}.`);
    }
  }

  // Recency is judged on the essential skills alone where there are any.
  //
  // Measuring it across everything the position asked for lets a current soft
  // skill vouch for a technical one nobody has touched in years: somebody whose
  // Python is three years stale but who taught a class last month reads as
  // "used within six months", which is true of the wrong skill and exactly the
  // plausible-looking answer that costs a tool its credibility.
  const essentialIds = new Set(essentials.map((skill) => skill.skillId));
  const judged =
    essentialIds.size > 0 ? relevant.filter((skill) => essentialIds.has(skill.skillId)) : relevant;

  const recency = recencyOf(judged, options.today, essentialIds.size > 0);
  score += recency.fraction * RECENCY_WEIGHT;
  if (recency.note) reasons.push(recency.note);

  return { score: Math.round(score), eligible: true, matches, reasons };
}

/** How current the judged skills are, and whether that is worth saying. */
function recencyOf(
  judged: readonly HeldSkill[],
  today: string | undefined,
  essentialsOnly: boolean,
): { fraction: number; note: string | null } {
  const noun = essentialsOnly ? 'the essential skills' : 'these skills';
  const dated = judged.filter((skill) => skill.lastUsedOn);
  // Nobody has said when these were last used. Neither credited nor punished:
  // an unfilled field is missing information, not evidence of staleness.
  if (dated.length === 0) return { fraction: 0.5, note: null };

  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const months = dated.map((skill) => monthsSince(skill.lastUsedOn!, now));
  // The staleness that matters is the worst of them: a position needing Python
  // and SQL is not served by somebody current on one and years off the other.
  const stalest = Math.max(...months);

  if (stalest <= 6) return { fraction: 1, note: `Used ${noun} within six months.` };
  if (stalest >= STALE_AFTER_MONTHS) {
    const years = Math.floor(stalest / 12);
    return {
      fraction: 0,
      note: `Has not used ${noun} in ${years} year${years === 1 ? '' : 's'}.`,
    };
  }
  return { fraction: 1 - (stalest - 6) / (STALE_AFTER_MONTHS - 6), note: null };
}

function monthsSince(date: string, now: Date): number {
  const then = new Date(`${date}T00:00:00Z`);
  return Math.max(
    0,
    (now.getUTCFullYear() - then.getUTCFullYear()) * 12 + (now.getUTCMonth() - then.getUTCMonth()),
  );
}

/* ------------------------------------------------------------ availability */

export interface Commitment {
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, or null for an assignment with no agreed end. */
  endDate: string | null;
  allocationPercent: number;
}

export interface Availability {
  /** How much of them is already spoken for at the busiest point in the window. */
  committedPercent: number;
  /** What is left at that busiest point. Zero means fully booked. */
  availablePercent: number;
  /**
   * The first date they have any capacity, or null when nothing frees up.
   *
   * Null is the honest answer for an open-ended commitment: "we do not know
   * when they are free again" is different from "never", and different again
   * from a date. A caller that wants a date must chase the assignment's end.
   */
  availableFrom: string | null;
  /** True when they have no commitments in the window at all. */
  onBench: boolean;
}

/**
 * What is left of somebody between two dates.
 *
 * Measured at the busiest point in the window rather than averaged across it:
 * a trainer who is free for three weeks and fully booked for the fourth cannot
 * take a month-long posting, and an average would say they were 75% free.
 */
export function availabilityIn(
  commitments: readonly Commitment[],
  window: { from: string; to: string },
): Availability {
  const overlapping = commitments.filter(
    (c) => c.startDate <= window.to && (c.endDate == null || c.endDate >= window.from),
  );

  if (overlapping.length === 0) {
    return {
      committedPercent: 0,
      availablePercent: 100,
      availableFrom: window.from,
      onBench: true,
    };
  }

  // The busiest day is always the start of some commitment, so only those
  // boundaries need checking rather than every date in the window.
  const boundaries = [
    window.from,
    ...overlapping.map((c) => (c.startDate > window.from ? c.startDate : window.from)),
  ];

  let committedPercent = 0;
  for (const day of boundaries) {
    const load = overlapping
      .filter((c) => c.startDate <= day && (c.endDate == null || c.endDate >= day))
      .reduce((total, c) => total + c.allocationPercent, 0);
    committedPercent = Math.max(committedPercent, load);
  }

  const availablePercent = Math.max(0, 100 - committedPercent);

  return {
    committedPercent,
    availablePercent,
    availableFrom: availablePercent > 0 ? window.from : freesUpOn(overlapping),
    onBench: false,
  };
}

/** The day after the last commitment ends, or null when one never does. */
function freesUpOn(commitments: readonly Commitment[]): string | null {
  if (commitments.some((c) => c.endDate == null)) return null;

  const last = commitments
    .map((c) => c.endDate!)
    .sort()
    .at(-1)!;
  const next = new Date(`${last}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------- payroll */

/**
 * What the register is, and what it deliberately is not.
 *
 * It is an *input* register: the days and money ManagedOps actually knows
 * about, in the shape a payroll system wants them. It is not a payroll engine.
 * Nothing here computes PF, ESI, professional tax or TDS, because those are
 * statutory, they change, and a wrong number that looks official is worse than
 * no number at all. Deductions belong to whoever files the returns.
 */

/** One attendance record, flattened to what payroll cares about. */
export interface PayrollDayRecord {
  /** `YYYY-MM-DD`. */
  workDate: string;
  status: string;
}

export interface PayrollDays {
  /** Distinct dates that were working days at all. */
  workingDays: number;
  /** Distinct working dates that earned a day's pay. */
  payableDays: number;
  /** Working dates recorded but earning nothing — absence and leave without pay. */
  lopDays: number;
  /** Payable dates spent on approved leave rather than delivering. */
  leaveDays: number;
}

/**
 * A month of attendance, resolved per person rather than per assignment.
 *
 * Attendance is recorded against an assignment, so somebody split across two
 * projects has two records for the same Tuesday. They are paid for that Tuesday
 * once. Every figure here is therefore counted over distinct dates, and a date
 * resolves to its best outcome: if any assignment records them as working or on
 * approved leave, the day is payable — they were demonstrably somewhere.
 */
export function summarisePayrollDays(records: readonly PayrollDayRecord[]): PayrollDays {
  const byDate = new Map<string, { working: boolean; payable: boolean; worked: boolean }>();

  for (const record of records) {
    const value = DAY_VALUE[record.status as AttendanceStatusLike];
    if (!value) continue;

    const existing = byDate.get(record.workDate) ?? {
      working: false,
      payable: false,
      worked: false,
    };
    byDate.set(record.workDate, {
      working: existing.working || value.working > 0,
      payable: existing.payable || value.payable > 0,
      worked: existing.worked || value.billable > 0,
    });
  }

  let workingDays = 0;
  let payableDays = 0;
  let leaveDays = 0;

  for (const day of byDate.values()) {
    if (!day.working) continue;
    workingDays += 1;
    if (day.payable) {
      payableDays += 1;
      // Paid, and nothing delivered anywhere: approved leave.
      if (!day.worked) leaveDays += 1;
    }
  }

  return { workingDays, payableDays, lopDays: workingDays - payableDays, leaveDays };
}

export interface MonthlyPay {
  /** A twelfth of the annual salary, before anything is deducted. */
  monthlyGross: number;
  /** What the days actually worked and paid come to. */
  earnedGross: number;
  /** The difference, which is what unpaid days cost them. */
  lopDeduction: number;
}

/**
 * A month's earnings from the days that earned them.
 *
 * Prorated over the month's *calendar* working days, not the days attendance
 * happened to be written for — otherwise a month with records missing would
 * quietly raise the value of every recorded day and overpay.
 */
export function computeMonthlyPay(input: {
  salaryAnnual: number | null;
  payableDays: number;
  workingDaysInMonth: number;
}): MonthlyPay {
  const monthlyGross = input.salaryAnnual == null ? 0 : round2(input.salaryAnnual / 12);

  // No working days in the month means nothing to prorate over and nothing
  // earned in it either; paying a full month against a zero denominator would
  // be the one arithmetic mistake nobody would catch until payday.
  const share =
    input.workingDaysInMonth > 0
      ? Math.min(1, Math.max(0, input.payableDays / input.workingDaysInMonth))
      : 0;

  const earnedGross = round2(monthlyGross * share);
  return { monthlyGross, earnedGross, lopDeduction: round2(monthlyGross - earnedGross) };
}

export interface PayrollReadiness {
  /** Safe to pay from: every day is accounted for and nothing is awaiting a decision. */
  ready: boolean;
  /** What is unresolved, in sentences somebody can act on. */
  blockers: string[];
}

/**
 * Whether a row is safe to pay from.
 *
 * A register that looks final while a correction is still pending is how
 * somebody gets underpaid, so unresolved data is stated rather than rounded
 * past. Every blocker names a number and a thing to go and do.
 */
export function payrollReadiness(input: {
  /** Working days in the month with no attendance recorded at all. */
  unrecordedDays: number;
  /** Attendance corrections still awaiting a decision. */
  pendingCorrections: number;
  /** Leave requests overlapping the month that nobody has decided. */
  undecidedLeave: number;
  /** True when the person has no salary on record, so there is nothing to pay. */
  salaryMissing: boolean;
}): PayrollReadiness {
  const blockers: string[] = [];

  if (input.salaryMissing) {
    blockers.push('No annual salary on record, so nothing can be worked out.');
  }
  if (input.unrecordedDays > 0) {
    blockers.push(
      `${input.unrecordedDays} working day${input.unrecordedDays === 1 ? '' : 's'} with no attendance recorded.`,
    );
  }
  if (input.pendingCorrections > 0) {
    blockers.push(
      `${input.pendingCorrections} attendance correction${input.pendingCorrections === 1 ? '' : 's'} awaiting a decision.`,
    );
  }
  if (input.undecidedLeave > 0) {
    blockers.push(
      `${input.undecidedLeave} leave request${input.undecidedLeave === 1 ? '' : 's'} still undecided.`,
    );
  }

  return { ready: blockers.length === 0, blockers };
}
