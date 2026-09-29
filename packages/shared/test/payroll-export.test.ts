import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYROLL_EXPORT_LAYOUT,
  PAYROLL_EXPORT_LAYOUTS,
  PAYROLL_EXPORT_LAYOUT_IDS,
  payrollExportLayout,
  payrollFiguresDigestInput,
  type PayrollExportRow,
} from '../src/index.js';

/**
 * What leaves for payroll, and how we know it is still current.
 *
 * The digest carries most of the weight here. The register is worked out live,
 * so the only way to know whether the file payroll is holding still matches is
 * to be able to reduce a month to a comparable value — and to be exactly right
 * about what counts as a change. Too eager and a settled month nags forever
 * over a corrected spelling; too lax and somebody is paid from a stale file.
 */
function row(over: Partial<PayrollExportRow> = {}): PayrollExportRow {
  return {
    employeeCode: 'MO-2026-0001',
    name: 'Sneha Iyer',
    month: '2026-09',
    workingDaysInMonth: 26,
    payableDays: 24,
    leaveDays: 1,
    lopDays: 2,
    unrecordedDays: 0,
    monthlyGross: 80000,
    lopDeduction: 6153.85,
    earnedGross: 73846.15,
    reimbursements: 12500,
    finalSettlement: 0,
    totalPayable: 86346.15,
    ready: true,
    blockers: [],
    ...over,
  };
}

describe('the layouts', () => {
  it('defaults to the one that carries days rather than money', () => {
    // Payroll holds the salary structure. Sending our computed gross as though
    // it were authoritative is how two systems disagree on payday.
    expect(DEFAULT_PAYROLL_EXPORT_LAYOUT).toBe('days');
  });

  it('keeps money out of the days layout entirely', () => {
    const headers = PAYROLL_EXPORT_LAYOUTS.days.columns.map((column) => column.header);
    expect(headers.some((header) => header.endsWith('_inr'))).toBe(false);
    expect(headers).toContain('loss_of_pay_days');
    expect(headers).toContain('paid_days');
  });

  it('carries the days in the money layout too, so one file reconciles both', () => {
    const days = PAYROLL_EXPORT_LAYOUTS.days.columns.map((column) => column.header);
    const full = PAYROLL_EXPORT_LAYOUTS.full.columns.map((column) => column.header);
    expect(full).toEqual(expect.arrayContaining(days));
  });

  it('puts the reason in the file for a row that is not ready, in either layout', () => {
    // A month is only exported unsettled on purpose, and the file is where
    // that decision has to travel: the days layout is the one that is sent.
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      const headers = payrollExportLayout(id).columns.map((column) => column.header);
      expect(headers, id).toContain('ready_to_pay');
      expect(headers, id).toContain('unresolved');
    }
  });

  it('accounts for every working day the month held, in either layout', () => {
    // paid + lop + unrecorded = the month. Without unrecorded_days a month
    // half-recorded reads as a short one with no reason given, while the
    // money columns quietly dock every one of those days.
    const short = row({ workingDaysInMonth: 26, payableDays: 12, lopDays: 0, unrecordedDays: 14 });
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      const columns = payrollExportLayout(id).columns;
      const cell = (header: string) =>
        Number(columns.find((column) => column.header === header)?.value(short));
      expect(cell('paid_days') + cell('loss_of_pay_days') + cell('unrecorded_days'), id).toBe(
        cell('working_days_in_month'),
      );
    }
  });

  it('keeps the money out of the row that says why it is wrong', () => {
    // unresolved is a sentence; anything after it in the row gets read past.
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      const headers = payrollExportLayout(id).columns.map((column) => column.header);
      expect(headers[headers.length - 1], id).toBe('unresolved');
    }
  });

  it('names every column once, in every layout', () => {
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      const headers = payrollExportLayout(id).columns.map((column) => column.header);
      expect(new Set(headers).size, id).toBe(headers.length);
    }
  });

  it('renders every column to something a CSV can hold', () => {
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      for (const column of payrollExportLayout(id).columns) {
        const value = column.value(row({ blockers: ['2 days unrecorded.'], ready: false }));
        expect(['string', 'number'], `${id}.${column.header}`).toContain(typeof value);
      }
    }
  });

  it('describes each layout, so nobody picks one to find out later', () => {
    for (const id of PAYROLL_EXPORT_LAYOUT_IDS) {
      expect(payrollExportLayout(id).description.length).toBeGreaterThan(20);
    }
  });
});

describe('the digest of a month', () => {
  it('is the same for the same figures, whatever order the rows arrive in', () => {
    const a = row({ employeeCode: 'MO-2026-0001' });
    const b = row({ employeeCode: 'MO-2026-0002' });
    expect(payrollFiguresDigestInput([a, b])).toBe(payrollFiguresDigestInput([b, a]));
  });

  it('changes when a paid day changes', () => {
    const before = payrollFiguresDigestInput([row()]);
    expect(payrollFiguresDigestInput([row({ payableDays: 25, lopDays: 1 })])).not.toBe(before);
  });

  it('changes when a claim is approved after the fact', () => {
    const before = payrollFiguresDigestInput([row()]);
    expect(payrollFiguresDigestInput([row({ reimbursements: 14000 })])).not.toBe(before);
  });

  it('changes when somebody joins the month', () => {
    const before = payrollFiguresDigestInput([row()]);
    const after = payrollFiguresDigestInput([row(), row({ employeeCode: 'MO-2026-0002' })]);
    expect(after).not.toBe(before);
  });

  it('does not change when a spelling is corrected', () => {
    // A settled month nagging that it is stale because HR fixed a name is a
    // warning people learn to ignore, which costs more than it saves.
    const before = payrollFiguresDigestInput([row({ name: 'Sneha Iyer' })]);
    expect(payrollFiguresDigestInput([row({ name: 'Sneha S. Iyer' })])).toBe(before);
  });

  it('does not change when a blocker is only reworded', () => {
    const before = payrollFiguresDigestInput([row()]);
    expect(payrollFiguresDigestInput([row({ blockers: ['Something else.'] })])).toBe(before);
  });

  it('cannot be confused by figures that run together', () => {
    // Without a separator, 1 and 23 would digest the same as 12 and 3.
    const a = payrollFiguresDigestInput([row({ payableDays: 1, lopDays: 23 })]);
    const b = payrollFiguresDigestInput([row({ payableDays: 12, lopDays: 3 })]);
    expect(a).not.toBe(b);
  });

  it('has nothing to say about an empty month', () => {
    expect(payrollFiguresDigestInput([])).toBe('');
  });
});
