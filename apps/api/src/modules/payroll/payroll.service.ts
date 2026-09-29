import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DEFAULT_PAYROLL_EXPORT_LAYOUT,
  computeMonthlyPay,
  payrollExportLayout,
  payrollFiguresDigestInput,
  payrollReadiness,
  summarisePayrollDays,
  toIstDateString,
  type MonthlyPay,
  type PayrollDays,
  type PayrollExportLayoutId,
  type PayrollExportQuery,
  type PayrollExportRow,
  type PayrollQuery,
  type PayrollReadiness,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { WorkingDaysService } from '../../common/working-days.js';
import { projectScope, scopedWhere } from '../../common/scope.js';
import { newId } from '../../common/ids.js';
import { DomainRuleProblem } from '../../common/errors.js';
import { toCsv } from '../../common/csv.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

export interface PayrollRow extends PayrollDays, MonthlyPay, PayrollReadiness {
  trainerId: string;
  employeeCode: string;
  name: string;
  joiningDate: string | null;
  status: string;
  projects: string[];
  /** Working days the month held, which is what the proration divides by. */
  workingDaysInMonth: number;
  /**
   * Working days the month expected with no attendance recorded against them.
   *
   * Not the same as loss of pay: nobody has yet said whether they were absent
   * or simply not punched. The proration charges for them all the same, which
   * is why the number is stated rather than left to be inferred.
   */
  unrecordedDays: number;
  /** Approved claims from the month. Paid alongside salary, not part of it. */
  reimbursements: number;
  /** A final settlement falling in this month, for somebody who has left. */
  finalSettlement: number;
  /** Salary plus what is owed on top. Before statutory deductions. */
  totalPayable: number;
}

/** What a month's last handoff to payroll looked like, if there was one. */
export interface PayrollHandoff {
  at: string;
  by: string;
  layout: string;
  rowCount: number;
  forced: boolean;
  /**
   * Whether the figures still match what was sent. The whole reason the digest
   * is kept: a file exported on the 3rd can stop being true by the 5th, and
   * nobody finds out unless something says so.
   */
  stillCurrent: boolean;
}

export interface PayrollRegister {
  month: string;
  from: string;
  to: string;
  /** When these figures were worked out; they are live, not a snapshot. */
  generatedAt: string;
  rows: PayrollRow[];
  /** Null until the month has been sent once. */
  lastExport: PayrollHandoff | null;
  totals: {
    people: number;
    ready: number;
    unresolved: number;
    earnedGross: number;
    lopDeduction: number;
    reimbursements: number;
    finalSettlement: number;
    totalPayable: number;
  };
}

/**
 * The month's pay inputs, in the shape a payroll system wants them.
 *
 * This is an input register, not a payroll engine. It states the days and the
 * money ManagedOps actually knows about; PF, ESI, professional tax and TDS are
 * statutory, they change, and a wrong number that looks official is worse than
 * no number at all. Deductions belong to whoever files the returns.
 *
 * Every figure is computed live rather than snapshotted, so a register run
 * twice can differ if somebody approved a correction in between. That is the
 * honest behaviour — but it is why each row carries a readiness verdict, and
 * why the response says when it was generated.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  async register(query: PayrollQuery, user: AuthenticatedUser): Promise<PayrollRegister> {
    const { month, from, to } = resolveMonth(query.month);
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);

    const trainers = await this.prisma.db.trainer.findMany({
      where: {
        deletedAt: null,
        // Anybody who held a live assignment at any point in the month, which
        // is what makes a leaver still appear in the month they left.
        assignments: {
          some: {
            startDate: { lte: end },
            OR: [{ endDate: null }, { endDate: { gte: start } }],
            ...(query.projectId ? { projectId: query.projectId } : {}),
            project: scopedWhere(projectScope(user, 'payroll.read'), {}),
          },
        },
      },
      select: {
        id: true,
        employeeCode: true,
        joiningDate: true,
        salaryAnnual: true,
        status: true,
        user: { select: { name: true } },
        assignments: {
          where: {
            startDate: { lte: end },
            OR: [{ endDate: null }, { endDate: { gte: start } }],
          },
          select: {
            id: true,
            project: { select: { id: true, name: true } },
            attendance: {
              where: { workDate: { gte: start, lte: end } },
              select: {
                workDate: true,
                status: true,
                // A correction belongs to the day it disputes, not to the
                // assignment, so it is counted through the record.
                corrections: { where: { status: 'pending' }, select: { id: true } },
              },
            },
            leave: {
              where: {
                status: { in: ['submitted', 'escalated'] },
                startDate: { lte: end },
                endDate: { gte: start },
              },
              select: { id: true },
            },
          },
        },
        reimbursements: {
          where: {
            status: { in: ['approved', 'reimbursed'] },
            reviewedAt: {
              gte: start,
              lte: new Date(`${to}T23:59:59.999Z`),
            },
          },
          select: { amount: true },
        },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const projectIds = trainers.flatMap((trainer) =>
      trainer.assignments.map((assignment) => assignment.project.id),
    );
    const workingDaysByProject = await this.workingDays.forProjects(projectIds, from, to);
    const settlements = await this.settlementsIn(
      trainers.map((trainer) => trainer.id),
      start,
      end,
    );

    const rows = trainers.map((trainer) =>
      this.rowFor(trainer, { from, to, workingDaysByProject, settlements }),
    );

    const shown = query.unresolvedOnly ? rows.filter((row) => !row.ready) : rows;

    return {
      month,
      from,
      to,
      generatedAt: new Date().toISOString(),
      // Taken over the whole month, never the filtered view: whether what
      // payroll holds is current cannot depend on a checkbox on the screen.
      lastExport: await this.lastHandoff(month, rows),
      rows: shown,
      totals: {
        // Counted over the rows shown, so a filtered view totals what it lists.
        people: shown.length,
        ready: shown.filter((row) => row.ready).length,
        unresolved: shown.filter((row) => !row.ready).length,
        earnedGross: sum(shown.map((row) => row.earnedGross)),
        lopDeduction: sum(shown.map((row) => row.lopDeduction)),
        reimbursements: sum(shown.map((row) => row.reimbursements)),
        finalSettlement: sum(shown.map((row) => row.finalSettlement)),
        totalPayable: sum(shown.map((row) => row.totalPayable)),
      },
    };
  }

  /**
   * The month as a file, and a record that it left.
   *
   * Refuses a month that is not ready unless somebody says otherwise. The
   * screen already advised settling first; advice is not a control, and the
   * cost of a clerk importing a half-settled month is somebody underpaid.
   */
  async export(
    query: PayrollExportQuery,
    user: AuthenticatedUser,
  ): Promise<{ filename: string; body: string }> {
    const layout = (query.layout ?? DEFAULT_PAYROLL_EXPORT_LAYOUT) as PayrollExportLayoutId;

    // Deliberately the whole month, whatever the screen was filtering to. A
    // file that silently holds a subset is the worst thing to hand payroll.
    const register = await this.register({ ...query, unresolvedOnly: false }, user);
    const unresolved = register.rows.filter((row) => !row.ready);

    if (unresolved.length > 0 && !query.force) {
      throw new DomainRuleProblem(
        'payroll-month-not-ready',
        `${unresolved.length} of ${register.rows.length} ${
          unresolved.length === 1 ? 'row is' : 'rows are'
        } not ready to pay from: ${unresolved[0]!.blockers[0] ?? 'unresolved.'} ` +
          'Settle those first, or export anyway to send the month with its blockers.',
      );
    }

    const rows = register.rows.map((row) => toExportRow(row, register.month));
    const body = toCsv(rows, [...payrollExportLayout(layout).columns]);

    await this.prisma.db.payrollExport.create({
      data: {
        id: newId(),
        month: register.month,
        layout,
        rowCount: rows.length,
        totalPayable: register.totals.totalPayable,
        figuresDigest: digestOf(rows),
        forced: unresolved.length > 0,
        unresolvedRows: unresolved.length,
        exportedById: user.userId,
      },
    });

    return { filename: `managedops-payroll-${register.month}-${layout}.csv`, body };
  }

  /**
   * Every handoff of a month, newest first — the record of what payroll holds.
   *
   * Resolves an absent month through the same rule the register does, so the
   * history and the figures on screen can never be talking about different
   * months.
   */
  async handoffs(month?: string) {
    const exports = await this.prisma.db.payrollExport.findMany({
      where: { month: resolveMonth(month).month },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        layout: true,
        rowCount: true,
        totalPayable: true,
        forced: true,
        unresolvedRows: true,
        createdAt: true,
        exportedBy: { select: { name: true } },
      },
    });

    return exports.map((row) => ({
      id: row.id,
      layout: row.layout,
      rowCount: row.rowCount,
      totalPayable: Number(row.totalPayable),
      forced: row.forced,
      unresolvedRows: row.unresolvedRows,
      at: row.createdAt.toISOString(),
      by: row.exportedBy.name,
    }));
  }

  private async lastHandoff(
    month: string,
    rows: readonly PayrollRow[],
  ): Promise<PayrollHandoff | null> {
    const last = await this.prisma.db.payrollExport.findFirst({
      where: { month },
      orderBy: { createdAt: 'desc' },
      select: {
        layout: true,
        rowCount: true,
        forced: true,
        figuresDigest: true,
        createdAt: true,
        exportedBy: { select: { name: true } },
      },
    });
    if (!last) return null;

    return {
      at: last.createdAt.toISOString(),
      by: last.exportedBy.name,
      layout: last.layout,
      rowCount: last.rowCount,
      forced: last.forced,
      stillCurrent: last.figuresDigest === digestOf(rows.map((row) => toExportRow(row, month))),
    };
  }

  private rowFor(
    trainer: TrainerWithMonth,
    context: {
      from: string;
      to: string;
      workingDaysByProject: Map<string, number>;
      settlements: Map<string, number>;
    },
  ): PayrollRow {
    const records = trainer.assignments.flatMap((assignment) =>
      assignment.attendance.map((record) => ({
        workDate: toIstDateString(record.workDate),
        status: record.status,
      })),
    );

    const days = summarisePayrollDays(records);

    // Somebody on two projects with different calendars gets the longer month:
    // a day that is working for either engagement is a day they were expected.
    const workingDaysInMonth = Math.max(
      0,
      ...trainer.assignments.map(
        (assignment) => context.workingDaysByProject.get(assignment.project.id) ?? 0,
      ),
    );

    const salaryAnnual = trainer.salaryAnnual == null ? null : Number(trainer.salaryAnnual);
    const pay = computeMonthlyPay({
      salaryAnnual,
      payableDays: days.payableDays,
      workingDaysInMonth,
    });

    const reimbursements = sum(trainer.reimbursements.map((claim) => Number(claim.amount)));
    const finalSettlement = context.settlements.get(trainer.id) ?? 0;

    // A day expected but never recorded is the gap that matters: it is
    // indistinguishable from an absence until somebody says which it was.
    const unrecordedDays = Math.max(0, workingDaysInMonth - days.workingDays);

    const readiness = payrollReadiness({
      unrecordedDays,
      pendingCorrections: sum(
        trainer.assignments.flatMap((assignment) =>
          assignment.attendance.map((record) => record.corrections.length),
        ),
      ),
      undecidedLeave: sum(trainer.assignments.map((assignment) => assignment.leave.length)),
      salaryMissing: salaryAnnual == null,
    });

    return {
      trainerId: trainer.id,
      employeeCode: trainer.employeeCode,
      name: trainer.user.name,
      joiningDate: trainer.joiningDate ? toIstDateString(trainer.joiningDate) : null,
      status: trainer.status,
      projects: [...new Set(trainer.assignments.map((a) => a.project.name))],
      workingDaysInMonth,
      unrecordedDays,
      ...days,
      ...pay,
      reimbursements,
      finalSettlement,
      totalPayable: round2(pay.earnedGross + reimbursements + finalSettlement),
      ...readiness,
    };
  }

  /** Final settlements that fell in the month, keyed by trainer. */
  private async settlementsIn(trainerIds: string[], start: Date, end: Date) {
    if (trainerIds.length === 0) return new Map<string, number>();

    const deboardings = await this.prisma.db.deboarding.findMany({
      where: {
        fnfStatus: 'settled',
        fnfSettledAt: { gte: start, lte: new Date(`${toIstDateString(end)}T23:59:59.999Z`) },
        assignment: { trainerId: { in: trainerIds } },
      },
      select: { fnfAmount: true, assignment: { select: { trainerId: true } } },
    });

    const byTrainer = new Map<string, number>();
    for (const deboarding of deboardings) {
      const trainerId = deboarding.assignment.trainerId;
      byTrainer.set(
        trainerId,
        round2((byTrainer.get(trainerId) ?? 0) + Number(deboarding.fnfAmount ?? 0)),
      );
    }
    return byTrainer;
  }
}

interface TrainerWithMonth {
  id: string;
  employeeCode: string;
  joiningDate: Date | null;
  salaryAnnual: unknown;
  status: string;
  user: { name: string };
  assignments: {
    id: string;
    project: { id: string; name: string };
    attendance: { workDate: Date; status: string; corrections: { id: string }[] }[];
    leave: { id: string }[];
  }[];
  reimbursements: { amount: unknown }[];
}

/** The month asked for, or the one just finished — the one payroll is run for. */
function resolveMonth(month?: string): { month: string; from: string; to: string } {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const chosen = month ?? previousMonth(now);
  const [year, monthNumber] = chosen.split('-').map(Number);

  const first = new Date(Date.UTC(year!, monthNumber! - 1, 1));
  const last = new Date(Date.UTC(year!, monthNumber!, 0));

  return {
    month: chosen,
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

/**
 * Payroll is run for the month that has finished, not the one in progress.
 *
 * Defaulting to the current month would open the register on a period whose
 * attendance is by definition incomplete, and every row would read as not ready
 * for reasons nobody can fix yet.
 */
function previousMonth(now: Date): string {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return previous.toISOString().slice(0, 7);
}

function sum(values: readonly number[]): number {
  return round2(values.reduce((total, value) => total + value, 0));
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The register's row, flattened to what a file and a digest both read from. */
function toExportRow(row: PayrollRow, month: string): PayrollExportRow {
  return {
    employeeCode: row.employeeCode,
    name: row.name,
    month,
    workingDaysInMonth: row.workingDaysInMonth,
    payableDays: row.payableDays,
    leaveDays: row.leaveDays,
    lopDays: row.lopDays,
    unrecordedDays: row.unrecordedDays,
    monthlyGross: row.monthlyGross,
    lopDeduction: row.lopDeduction,
    earnedGross: row.earnedGross,
    reimbursements: row.reimbursements,
    finalSettlement: row.finalSettlement,
    totalPayable: row.totalPayable,
    ready: row.ready,
    blockers: row.blockers,
  };
}

function digestOf(rows: readonly PayrollExportRow[]): string {
  return createHash('sha256').update(payrollFiguresDigestInput(rows)).digest('hex');
}
