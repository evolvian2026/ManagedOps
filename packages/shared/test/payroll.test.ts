import { describe, expect, it } from 'vitest';
import {
  computeMonthlyPay,
  payrollReadiness,
  summarisePayrollDays,
  type PayrollDayRecord,
} from '../src/rules.js';

/**
 * The arithmetic somebody gets paid from.
 *
 * The case that matters most is the one attendance makes easy to get wrong:
 * records belong to an assignment, a person can hold two, and they are paid
 * for a Tuesday once however many projects claim it.
 */
function day(workDate: string, status: string): PayrollDayRecord {
  return { workDate, status };
}

describe('resolving a month of attendance into days of pay', () => {
  it('counts a straightforward month', () => {
    const result = summarisePayrollDays([
      day('2026-06-01', 'present'),
      day('2026-06-02', 'present'),
      day('2026-06-03', 'late'),
    ]);
    expect(result).toEqual({ workingDays: 3, payableDays: 3, lopDays: 0, leaveDays: 0 });
  });

  it('pays for one Tuesday, however many assignments claim it', () => {
    // Somebody split 60/40 across two projects has two records per day. Paying
    // them twice is the mistake this whole function exists to prevent.
    const result = summarisePayrollDays([
      day('2026-06-01', 'present'),
      day('2026-06-01', 'present'),
      day('2026-06-02', 'present'),
      day('2026-06-02', 'present'),
    ]);
    expect(result.workingDays).toBe(2);
    expect(result.payableDays).toBe(2);
  });

  it('pays a day that any assignment says was worked', () => {
    // Absent from one engagement and delivering on the other is a day worked.
    const result = summarisePayrollDays([
      day('2026-06-01', 'absent'),
      day('2026-06-01', 'present'),
    ]);
    expect(result.payableDays).toBe(1);
    expect(result.lopDays).toBe(0);
  });

  it('counts a day as unpaid only when nothing on it earned anything', () => {
    const result = summarisePayrollDays([
      day('2026-06-01', 'absent'),
      day('2026-06-01', 'leave_without_pay'),
    ]);
    expect(result.workingDays).toBe(1);
    expect(result.payableDays).toBe(0);
    expect(result.lopDays).toBe(1);
  });

  it('keeps weekly offs and holidays out of the month entirely', () => {
    // Not unpaid days — nobody is docked for a Sunday — and not days of pay
    // earned either, so they belong on neither side of the ratio.
    const result = summarisePayrollDays([
      day('2026-06-01', 'present'),
      day('2026-06-07', 'weekly_off'),
      day('2026-06-15', 'holiday'),
    ]);
    expect(result).toEqual({ workingDays: 1, payableDays: 1, lopDays: 0, leaveDays: 0 });
  });

  it('reports approved leave as paid, and separately as leave', () => {
    const result = summarisePayrollDays([
      day('2026-06-01', 'present'),
      day('2026-06-02', 'on_leave'),
      day('2026-06-03', 'half_day'),
    ]);
    expect(result.payableDays).toBe(3);
    expect(result.lopDays).toBe(0);
    // A half day was partly delivered, so it is not counted as leave taken.
    expect(result.leaveDays).toBe(1);
  });

  it('ignores a status it does not recognise rather than guessing', () => {
    const result = summarisePayrollDays([day('2026-06-01', 'something_new')]);
    expect(result).toEqual({ workingDays: 0, payableDays: 0, lopDays: 0, leaveDays: 0 });
  });

  it('has nothing to say about a month with no records', () => {
    expect(summarisePayrollDays([])).toEqual({
      workingDays: 0,
      payableDays: 0,
      lopDays: 0,
      leaveDays: 0,
    });
  });
});

describe('working out a month’s earnings', () => {
  const base = { salaryAnnual: 720_000, payableDays: 26, workingDaysInMonth: 26 };

  it('pays a full month for a month worked in full', () => {
    const pay = computeMonthlyPay(base);
    expect(pay.monthlyGross).toBe(60_000);
    expect(pay.earnedGross).toBe(60_000);
    expect(pay.lopDeduction).toBe(0);
  });

  it('docks unpaid days against the month’s working days', () => {
    const pay = computeMonthlyPay({ ...base, payableDays: 24 });
    expect(pay.earnedGross).toBe(55_384.62);
    expect(pay.lopDeduction).toBe(4_615.38);
  });

  it('prorates somebody who only joined halfway through', () => {
    const pay = computeMonthlyPay({ ...base, payableDays: 13 });
    expect(pay.earnedGross).toBe(30_000);
  });

  it('never pays more than the month, whatever the records say', () => {
    const pay = computeMonthlyPay({ ...base, payableDays: 40 });
    expect(pay.earnedGross).toBe(60_000);
    expect(pay.lopDeduction).toBe(0);
  });

  it('pays nothing for a month with no working days rather than dividing by zero', () => {
    const pay = computeMonthlyPay({ ...base, workingDaysInMonth: 0, payableDays: 0 });
    expect(Number.isFinite(pay.earnedGross)).toBe(true);
    expect(pay.earnedGross).toBe(0);
  });

  it('pays nothing for somebody with no salary recorded', () => {
    const pay = computeMonthlyPay({ ...base, salaryAnnual: null });
    expect(pay.monthlyGross).toBe(0);
    expect(pay.earnedGross).toBe(0);
  });
});

describe('deciding whether a row is safe to pay from', () => {
  const settled = {
    unrecordedDays: 0,
    pendingCorrections: 0,
    undecidedLeave: 0,
    salaryMissing: false,
  };

  it('is ready when everything is accounted for', () => {
    expect(payrollReadiness(settled)).toEqual({ ready: true, blockers: [] });
  });

  it('refuses a month with days nobody has recorded', () => {
    const result = payrollReadiness({ ...settled, unrecordedDays: 3 });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('3 working days with no attendance recorded.');
  });

  it('refuses while a correction is still pending', () => {
    // Paying from a register that looks final while somebody is still disputing
    // a punch is how a person quietly gets underpaid.
    const result = payrollReadiness({ ...settled, pendingCorrections: 1 });
    expect(result.blockers).toContain('1 attendance correction awaiting a decision.');
  });

  it('refuses while leave is undecided', () => {
    const result = payrollReadiness({ ...settled, undecidedLeave: 2 });
    expect(result.blockers).toContain('2 leave requests still undecided.');
  });

  it('refuses when there is no salary to work from', () => {
    const result = payrollReadiness({ ...settled, salaryMissing: true });
    expect(result.blockers[0]).toMatch(/No annual salary on record/);
  });

  it('lists every blocker rather than only the first', () => {
    const result = payrollReadiness({
      unrecordedDays: 1,
      pendingCorrections: 1,
      undecidedLeave: 1,
      salaryMissing: true,
    });
    expect(result.blockers).toHaveLength(4);
  });
});
