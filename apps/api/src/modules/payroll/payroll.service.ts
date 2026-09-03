import { Injectable } from '@nestjs/common';
import {
  computeMonthlyPay,
  payrollReadiness,
  summarisePayrollDays,
  toIstDateString,
  type MonthlyPay,
  type PayrollDays,
  type PayrollQuery,
  type PayrollReadiness,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { WorkingDaysService } from '../../common/working-days.js';
import { projectScope, scopedWhere } from '../../common/scope.js';
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
  /** Approved claims from the month. Paid alongside salary, not part of it. */
  reimbursements: number;
  /** A final settlement falling in this month, for somebody who has left. */
  finalSettlement: number;
  /** Salary plus what is owed on top. Before statutory deductions. */
  totalPayable: number;
}

export interface PayrollRegister {
  month: string;
  from: string;
  to: string;
  /** When these figures were worked out; they are live, not a snapshot. */
  generatedAt: string;
  rows: PayrollRow[];
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

    const readiness = payrollReadiness({
      // A day expected but never recorded is the gap that matters: it is
      // indistinguishable from an absence until somebody says which it was.
      unrecordedDays: Math.max(0, workingDaysInMonth - days.workingDays),
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
