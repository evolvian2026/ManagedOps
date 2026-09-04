import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRACE_MINUTES,
  DEFAULT_LEAVE_ALLOWANCE_DAYS,
  REIMBURSEMENT_HR_LIMIT,
  attendanceStatusFromPunches,
  computeLeaveBalance,
  countLeaveDays,
  eachDate,
  isLatePunchIn,
  isWorkingDay,
  istMinutesOfDay,
  needsHighValueApproval,
  nonWorkingReason,
  parseClockTime,
  formatIstDate,
  toIstDateString,
} from '../src/rules.js';

/** IST is UTC+5:30 year round, so a punch late in the UTC evening is tomorrow. */
describe('IST handling', () => {
  it('rolls a 19:00 UTC punch into the next IST work date', () => {
    expect(toIstDateString(new Date('2026-03-10T19:00:00Z'))).toBe('2026-03-11');
  });

  it('keeps a mid-morning IST punch on the same date', () => {
    expect(toIstDateString(new Date('2026-03-10T04:30:00Z'))).toBe('2026-03-10');
  });

  it('converts an instant to minutes past midnight IST', () => {
    // 03:30 UTC is 09:00 IST.
    expect(istMinutesOfDay(new Date('2026-03-10T03:30:00Z'))).toBe(9 * 60);
  });

  it('parses a project start time', () => {
    expect(parseClockTime('09:00')).toBe(540);
    expect(parseClockTime('00:00')).toBe(0);
    expect(parseClockTime('23:59')).toBe(1439);
  });

  it('rejects a malformed start time rather than guessing', () => {
    expect(() => parseClockTime('9:00')).toThrow();
    expect(() => parseClockTime('24:00')).toThrow();
    expect(() => parseClockTime('09:60')).toThrow();
  });
});

describe('late marking', () => {
  const start = '09:00';

  it('treats a punch inside the grace period as on time', () => {
    // 03:44 UTC = 09:14 IST, one minute inside a 15-minute grace period.
    expect(isLatePunchIn(new Date('2026-03-10T03:44:00Z'), start)).toBe(false);
  });

  it('marks a punch past the grace period as late', () => {
    // 03:46 UTC = 09:16 IST.
    expect(isLatePunchIn(new Date('2026-03-10T03:46:00Z'), start)).toBe(true);
  });

  it('treats the last grace minute itself as on time', () => {
    expect(isLatePunchIn(new Date('2026-03-10T03:45:00Z'), start)).toBe(false);
  });

  it('honours a project that configures a stricter grace period', () => {
    expect(isLatePunchIn(new Date('2026-03-10T03:36:00Z'), start, 5)).toBe(true);
    expect(isLatePunchIn(new Date('2026-03-10T03:36:00Z'), start, DEFAULT_GRACE_MINUTES)).toBe(
      false,
    );
  });
});

describe('leave day counting', () => {
  it('counts a plain weekday range', () => {
    // Mon 9 to Wed 11 March 2026.
    expect(
      countLeaveDays({ startDate: '2026-03-09', endDate: '2026-03-11', dayType: 'full' }),
    ).toBe(3);
  });

  it('skips the weekly off day inside a range', () => {
    // Sat 14 to Mon 16 March 2026; Sunday the 15th is off by default.
    expect(
      countLeaveDays({ startDate: '2026-03-14', endDate: '2026-03-16', dayType: 'full' }),
    ).toBe(2);
  });

  it('skips configured holidays', () => {
    expect(
      countLeaveDays({
        startDate: '2026-03-09',
        endDate: '2026-03-11',
        dayType: 'full',
        holidays: ['2026-03-10'],
      }),
    ).toBe(2);
  });

  it('charges a half day at 0.5', () => {
    expect(
      countLeaveDays({ startDate: '2026-03-09', endDate: '2026-03-09', dayType: 'half' }),
    ).toBe(0.5);
  });

  it('refuses a half day spanning more than one date', () => {
    expect(() =>
      countLeaveDays({ startDate: '2026-03-09', endDate: '2026-03-10', dayType: 'half' }),
    ).toThrow(/single date/);
  });

  it('refuses a range that ends before it starts', () => {
    expect(() =>
      countLeaveDays({ startDate: '2026-03-11', endDate: '2026-03-09', dayType: 'full' }),
    ).toThrow(/cannot end before/);
  });

  it('costs nothing when the whole range is holidays and weekends', () => {
    expect(
      countLeaveDays({
        startDate: '2026-03-14',
        endDate: '2026-03-15',
        dayType: 'full',
        weeklyOffDays: [0, 6],
      }),
    ).toBe(0);
  });

  it('enumerates dates inclusively across a month boundary', () => {
    expect([...eachDate('2026-03-30', '2026-04-02')]).toEqual([
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ]);
  });
});

describe('leave balance', () => {
  it('reports what remains of the per-assignment allowance', () => {
    const balance = computeLeaveBalance(DEFAULT_LEAVE_ALLOWANCE_DAYS, 1.5);
    expect(balance).toEqual({ allowance: 3, used: 1.5, remaining: 1.5, unpaid: 0 });
  });

  it('splits a request that exceeds the balance into paid and unpaid days', () => {
    const balance = computeLeaveBalance(3, 2, 2);
    expect(balance.remaining).toBe(1);
    expect(balance.unpaid).toBe(1);
  });

  it('never reports a negative remaining balance', () => {
    expect(computeLeaveBalance(3, 5).remaining).toBe(0);
  });
});

describe('what a day is, given only its punches', () => {
  const workStartTime = '09:00';

  it('is absent with no punch-in at all', () => {
    expect(attendanceStatusFromPunches({ punchInAt: null, punchOutAt: null, workStartTime })).toBe(
      'absent',
    );
  });

  it('is missing a punch-out when only the arrival was recorded', () => {
    expect(
      attendanceStatusFromPunches({
        punchInAt: new Date('2026-03-02T03:25:00Z'),
        punchOutAt: null,
        workStartTime,
      }),
    ).toBe('missing_punch_out');
  });

  it('is present inside the grace period and late outside it', () => {
    // 09:14 IST — inside the fifteen-minute grace.
    expect(
      attendanceStatusFromPunches({
        punchInAt: new Date('2026-03-02T03:44:00Z'),
        punchOutAt: new Date('2026-03-02T12:00:00Z'),
        workStartTime,
      }),
    ).toBe('present');

    // 09:16 IST — one minute past it.
    expect(
      attendanceStatusFromPunches({
        punchInAt: new Date('2026-03-02T03:46:00Z'),
        punchOutAt: new Date('2026-03-02T12:00:00Z'),
        workStartTime,
      }),
    ).toBe('late');
  });
});

describe('the project calendar', () => {
  // 2026-03-01 is a Sunday; 2026-03-02 a Monday.
  it('treats the configured weekly off as non-working', () => {
    expect(isWorkingDay('2026-03-01')).toBe(false);
    expect(nonWorkingReason('2026-03-01')).toBe('weekly_off');
    expect(isWorkingDay('2026-03-02')).toBe(true);
    expect(nonWorkingReason('2026-03-02')).toBeNull();
  });

  it('lets a project choose a different weekly off', () => {
    expect(isWorkingDay('2026-03-01', { weeklyOffDays: [6] })).toBe(true);
    expect(nonWorkingReason('2026-03-07', { weeklyOffDays: [6] })).toBe('weekly_off');
  });

  it('names a holiday as a holiday, not as a weekly off', () => {
    expect(nonWorkingReason('2026-03-04', { holidays: ['2026-03-04'] })).toBe('holiday');
  });

  it('calls a day that is both a holiday and a weekly off a holiday', () => {
    // The more specific reason is the more useful one to show.
    expect(nonWorkingReason('2026-03-01', { holidays: ['2026-03-01'] })).toBe('holiday');
  });
});

describe('the reimbursement approval limit', () => {
  it('lets HR settle anything up to the limit', () => {
    expect(needsHighValueApproval(REIMBURSEMENT_HR_LIMIT)).toBe(false);
    expect(needsHighValueApproval(9_999)).toBe(false);
  });

  it('sends anything above it to a manager', () => {
    expect(needsHighValueApproval(REIMBURSEMENT_HR_LIMIT + 1)).toBe(true);
  });
});

describe('a date in a sentence', () => {
  it('reads the way the rest of the product writes one', () => {
    expect(formatIstDate('2026-10-11T00:00:00Z')).toBe('11 Oct 2026');
    // en-IN abbreviates September to "Sept", which is what every date in the
    // interface already shows — matching it matters more than the extra letter.
    expect(formatIstDate('2026-09-11T00:00:00Z')).toBe('11 Sept 2026');
  });

  it('is rendered in IST, so a UTC instant late in the day is not yesterday', () => {
    // 20:00 UTC on the 11th is 01:30 IST on the 12th.
    expect(formatIstDate('2026-10-11T20:00:00Z')).toBe('12 Oct 2026');
  });
});
