/**
 * Handing the month to whoever runs payroll.
 *
 * The distinction this file is built around: **payroll owns the salary
 * structure, and ManagedOps owns the attendance.** A payroll provider already
 * knows what each person is on, what their PF and ESI come to and how their
 * components split. What it cannot know is how many days somebody actually
 * worked, which of those were paid leave, and how many were loss of pay.
 *
 * So the export that matters carries *days*, not money. The money is still
 * offered — a month end is reconciled, not just imported — but as a second
 * layout somebody chooses deliberately, because exporting our computed gross
 * as though it were authoritative is how two systems come to disagree on
 * payday and nobody can say which is right.
 */

/** The flat shape both layouts render from. One row, one person, one month. */
export interface PayrollExportRow {
  employeeCode: string;
  name: string;
  month: string;
  workingDaysInMonth: number;
  payableDays: number;
  leaveDays: number;
  lopDays: number;
  /**
   * Working days the month expected and nothing was recorded against.
   *
   * Neither paid nor docked, because nobody has said which they were — and so
   * a column of its own. Without it a short month reads as a full one: the
   * days add up to less than the month and the file gives no reason why.
   */
  unrecordedDays: number;
  monthlyGross: number;
  lopDeduction: number;
  earnedGross: number;
  reimbursements: number;
  finalSettlement: number;
  totalPayable: number;
  ready: boolean;
  blockers: string[];
}

export interface PayrollExportColumn {
  /** Flat and explicit: a header a payroll clerk has to interpret is one they map wrong. */
  readonly header: string;
  readonly value: (row: PayrollExportRow) => string | number;
}

export interface PayrollExportLayout {
  readonly id: string;
  readonly label: string;
  /** Shown beside the choice, so nobody picks the wrong one to find out later. */
  readonly description: string;
  readonly columns: readonly PayrollExportColumn[];
}

/**
 * The days, in both layouts.
 *
 * These four counts are written so they reconcile: working_days_in_month =
 * paid_days + loss_of_pay_days + unrecorded_days, every row, every month.
 * paid_leave_days is a breakdown of paid_days, not an addition to it — leave
 * that was approved is paid, and saying so separately is what stops payroll
 * docking it a second time.
 */
const DAY_COUNT_COLUMNS: readonly PayrollExportColumn[] = [
  { header: 'employee_code', value: (row) => row.employeeCode },
  { header: 'name', value: (row) => row.name },
  { header: 'month', value: (row) => row.month },
  { header: 'working_days_in_month', value: (row) => row.workingDaysInMonth },
  { header: 'paid_days', value: (row) => row.payableDays },
  { header: 'paid_leave_days', value: (row) => row.leaveDays },
  { header: 'loss_of_pay_days', value: (row) => row.lopDays },
  { header: 'unrecorded_days', value: (row) => row.unrecordedDays },
];

/**
 * Why a row is not to be paid from, in both layouts.
 *
 * A month can only be exported unsettled deliberately, and the file it
 * produces has to say so — otherwise the decision stays behind with the
 * person who made it and payroll pays from figures nobody flagged. Last in
 * the row in both layouts, because `unresolved` is a sentence and everything
 * after it would be read past.
 */
const READINESS_COLUMNS: readonly PayrollExportColumn[] = [
  { header: 'ready_to_pay', value: (row) => (row.ready ? 'yes' : 'no') },
  { header: 'unresolved', value: (row) => row.blockers.join(' ') },
];

export const PAYROLL_EXPORT_LAYOUTS = {
  /**
   * The one to send. Every Indian payroll product takes an attendance or LOP
   * import in roughly this shape, and leaving the money out means their
   * payslip is worked out once, by them, from the structure they hold.
   */
  days: {
    id: 'days',
    label: 'Attendance and loss of pay',
    description: 'Days only. Payroll works out the money from the salary structure it holds.',
    columns: [...DAY_COUNT_COLUMNS, ...READINESS_COLUMNS],
  },
  /**
   * The one to keep. Same days, plus what ManagedOps makes of them, so a month
   * end can be reconciled against what payroll produced — and so the claims and
   * settlements that are paid alongside salary, but are not salary, travel with
   * it rather than being remembered separately.
   */
  full: {
    id: 'full',
    label: 'Days and money',
    description: 'Adds our own figures, claims and settlements, for reconciling against payroll.',
    columns: [
      ...DAY_COUNT_COLUMNS,
      { header: 'monthly_gross_inr', value: (row) => row.monthlyGross },
      // Charged against every day the month expected and did not get, which is
      // why unrecorded_days above has to be in the file: without it this
      // figure docks days the day columns never account for.
      { header: 'loss_of_pay_inr', value: (row) => row.lopDeduction },
      { header: 'earned_gross_inr', value: (row) => row.earnedGross },
      { header: 'reimbursements_inr', value: (row) => row.reimbursements },
      { header: 'final_settlement_inr', value: (row) => row.finalSettlement },
      { header: 'total_payable_inr', value: (row) => row.totalPayable },
      ...READINESS_COLUMNS,
    ],
  },
} as const satisfies Record<string, PayrollExportLayout>;

export type PayrollExportLayoutId = keyof typeof PAYROLL_EXPORT_LAYOUTS;
export const PAYROLL_EXPORT_LAYOUT_IDS = Object.keys(
  PAYROLL_EXPORT_LAYOUTS,
) as PayrollExportLayoutId[];

export const DEFAULT_PAYROLL_EXPORT_LAYOUT: PayrollExportLayoutId = 'days';

export function payrollExportLayout(id: PayrollExportLayoutId): PayrollExportLayout {
  return PAYROLL_EXPORT_LAYOUTS[id];
}

/**
 * The figures of a month, reduced to one string to compare.
 *
 * The register is worked out live and says so: run it twice with a correction
 * approved in between and it differs. That is honest, and it is exactly why an
 * export has to be able to answer "is the file payroll is holding still what we
 * would produce today?".
 *
 * Only what would change a payment goes in. A corrected spelling of somebody's
 * name must not make a settled month look stale, and a changed day count must
 * never fail to.
 */
export function payrollFiguresDigestInput(rows: readonly PayrollExportRow[]): string {
  return [...rows]
    .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
    .map((row) =>
      [
        row.employeeCode,
        row.payableDays,
        row.lopDays,
        row.leaveDays,
        row.earnedGross,
        row.reimbursements,
        row.finalSettlement,
        row.totalPayable,
      ].join(':'),
    )
    .join('\n');
}
