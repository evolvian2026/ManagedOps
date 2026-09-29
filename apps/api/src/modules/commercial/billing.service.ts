import { Injectable } from '@nestjs/common';
import {
  billingStateOf,
  computeMargin,
  tallyDays,
  type BillingState,
  type Margin,
  type MarginAssignmentsQuery,
  type MarginQuery,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { WorkingDaysService } from '../../common/working-days.js';
import { NotFoundProblem } from '../../common/errors.js';
import { projectScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

export interface MarginRow extends Margin {
  key: string;
  label: string;
  sublabel: string | null;
  billableDays: number;
  payableDays: number;
  /**
   * Assignments here with no rate and no decision — the actionable gap.
   *
   * Only these understate the margin in a way anybody can do something about,
   * which is why the deliberate ones are counted separately rather than
   * lumped in. A screen that cannot tell them apart has to warn about both.
   */
  unbilledAssignments: number;
  /** Assignments somebody has deliberately marked as not billed. */
  notBilledAssignments: number;
}

export interface MarginReport {
  from: string;
  to: string;
  groupBy: MarginQuery['groupBy'];
  rows: MarginRow[];
  totals: Margin & {
    billableDays: number;
    unbilledAssignments: number;
    notBilledAssignments: number;
  };
}

/**
 * What delivery earned against what it cost.
 *
 * The unit of computation is the assignment, because that is where a rate and a
 * person meet; every grouping above it — project, client, trainer — is a sum of
 * assignment margins. Computing at the assignment and rolling up means the
 * project total and the trainer total are guaranteed to agree, which they would
 * not if each grouping ran its own query.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  async report(query: MarginQuery, user: AuthenticatedUser): Promise<MarginReport> {
    const { from, to } = resolvePeriod(query);
    const priced = await this.priceAssignments(query, user, from, to);

    const grouped = new Map<string, MarginRow>();
    for (const { assignment, margin, tally, billing } of priced) {
      const bucket = this.bucketFor(query.groupBy, assignment);
      const existing = grouped.get(bucket.key);
      grouped.set(
        bucket.key,
        existing ? add(existing, margin, tally, billing) : make(bucket, margin, tally, billing),
      );
    }

    const rows = [...grouped.values()].sort((a, b) => b.margin - a.margin);
    return { from, to, groupBy: query.groupBy, rows, totals: totalsOf(rows) };
  }

  /**
   * The assignments behind one row of the report.
   *
   * Priced by the same pass the roll-up uses, so what this lists always sums to
   * what the row above it showed. Running a second, simpler query here would be
   * quicker to write and would eventually disagree with the number it claims to
   * explain, which is worse than not offering the drill-down at all.
   */
  async assignments(query: MarginAssignmentsQuery, user: AuthenticatedUser) {
    const { from, to } = resolvePeriod(query);
    const priced = await this.priceAssignments(
      { ...query, clientId: undefined, projectId: undefined },
      user,
      from,
      to,
    );

    const rows = priced
      .filter(({ assignment }) => {
        if (query.key && this.bucketFor(query.groupBy, assignment).key !== query.key) return false;
        return !query.undecidedOnly || billingStateOf(rateOf(assignment)) === 'undecided';
      })
      .map(({ assignment, margin, tally, billing }) => ({
        assignmentId: assignment.id,
        trainerId: assignment.trainer.id,
        trainerName: assignment.trainer.user.name,
        employeeCode: assignment.trainer.employeeCode,
        projectId: assignment.project.id,
        projectName: assignment.project.name,
        projectCode: assignment.project.code,
        clientName: assignment.project.client.name,
        billRatePerDay:
          assignment.billRatePerDay == null ? null : Number(assignment.billRatePerDay),
        notBilledReason: assignment.notBilledReason,
        billing,
        billableDays: tally.billableDays,
        revenue: margin.revenue,
        salaryCost: margin.salaryCost,
        reimbursements: margin.reimbursements,
        cost: margin.cost,
        margin: margin.margin,
        marginPercent: margin.marginPercent,
      }))
      // Undecided first: they are the only ones there is anything to do about,
      // and the thinnest margins after them.
      .sort((a, b) => {
        if (a.billing !== b.billing) {
          if (a.billing === 'undecided') return -1;
          if (b.billing === 'undecided') return 1;
        }
        return a.margin - b.margin;
      });

    return { from, to, groupBy: query.groupBy, key: query.key ?? null, rows };
  }

  /**
   * Every assignment overlapping the period, with its margin worked out.
   *
   * One query and one arithmetic pass, shared by the roll-up and the
   * drill-down. The unit is the assignment because that is where a rate and a
   * person meet, and computing here rather than per grouping is what makes the
   * project total and the trainer total agree.
   */
  private async priceAssignments(
    query: { groupBy: MarginQuery['groupBy']; clientId?: string; projectId?: string },
    user: AuthenticatedUser,
    from: string,
    to: string,
  ) {
    // Scoped through the project, so a role that only sees some projects only
    // ever sees their commercials. Today only Manager and Super Admin hold
    // `billing.read` and both are unscoped, but the predicate is applied rather
    // than assumed so a narrower role could be granted it safely.
    const assignments = await this.prisma.db.assignment.findMany({
      where: scopedWhere(
        { project: projectScope(user, 'billing.read') },
        {
          startDate: { lte: new Date(`${to}T00:00:00.000Z`) },
          OR: [{ endDate: null }, { endDate: { gte: new Date(`${from}T00:00:00.000Z`) } }],
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.clientId ? { project: { clientId: query.clientId } } : {}),
        },
      ),
      select: {
        id: true,
        billRatePerDay: true,
        notBilledReason: true,
        project: {
          select: {
            id: true,
            name: true,
            code: true,
            weeklyOffDays: true,
            client: { select: { id: true, name: true, code: true } },
          },
        },
        trainer: {
          select: {
            id: true,
            employeeCode: true,
            salaryAnnual: true,
            user: { select: { name: true } },
          },
        },
        attendance: {
          where: {
            workDate: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T00:00:00.000Z`),
            },
          },
          select: { status: true },
        },
        reimbursements: {
          where: {
            status: { in: ['approved', 'reimbursed'] },
            reviewedAt: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T23:59:59.999Z`),
            },
          },
          select: { amount: true },
        },
      },
    });

    const workingDays = await this.workingDays.forProjects(
      assignments.map((row) => row.project.id),
      from,
      to,
    );
    const months = monthsBetween(from, to);

    return assignments.map((assignment) => {
      const tally = tallyDays(assignment.attendance.map((day) => day.status));
      const reimbursements = assignment.reimbursements.reduce(
        (total, claim) => total + Number(claim.amount),
        0,
      );

      const margin = computeMargin({
        billableDays: tally.billableDays,
        dayRate: rateOf(assignment).dayRate,
        salaryAnnual:
          assignment.trainer.salaryAnnual == null ? null : Number(assignment.trainer.salaryAnnual),
        payableDays: tally.payableDays,
        workingDaysInPeriod: workingDays.get(assignment.project.id) ?? 0,
        months,
        reimbursements,
      });

      return {
        assignment,
        margin,
        tally,
        // Derived from the two columns, never read off a stored third: an
        // assignment is rated, deliberately not billed, or nobody has said.
        billing: billingStateOf(rateOf(assignment)),
      };
    });
  }

  /** One project's margin broken down by the trainers who delivered it. */
  async forProject(projectId: string, query: MarginQuery, user: AuthenticatedUser) {
    const project = await this.prisma.db.project.findFirst({
      where: scopedWhere(projectScope(user, 'billing.read'), { id: projectId }),
      select: { id: true, name: true, code: true, client: { select: { id: true, name: true } } },
    });
    if (!project) throw new NotFoundProblem('That project');

    const report = await this.report({ ...query, projectId, groupBy: 'trainer' }, user);
    return { project, ...report };
  }

  private bucketFor(
    groupBy: MarginQuery['groupBy'],
    assignment: {
      project: { id: string; name: string; code: string; client: { id: string; name: string } };
      trainer: { id: string; employeeCode: string; user: { name: string } };
    },
  ): { key: string; label: string; sublabel: string | null } {
    if (groupBy === 'trainer') {
      return {
        key: assignment.trainer.id,
        label: assignment.trainer.user.name,
        sublabel: assignment.trainer.employeeCode,
      };
    }
    if (groupBy === 'client') {
      return {
        key: assignment.project.client.id,
        label: assignment.project.client.name,
        sublabel: null,
      };
    }
    return {
      key: assignment.project.id,
      label: assignment.project.name,
      sublabel: assignment.project.code,
    };
  }
}

/* ----------------------------------------------------------------- helpers */

/**
 * The two columns that together say how an assignment is billed.
 *
 * In one place because the margin arithmetic and the state derivation must read
 * the same values: a Prisma Decimal that reaches `computeMargin` un-narrowed
 * would be truthy and price the work at NaN per day.
 */
function rateOf(assignment: { billRatePerDay: unknown; notBilledReason: string | null }): {
  dayRate: number | null;
  notBilledReason: string | null;
} {
  return {
    dayRate: assignment.billRatePerDay == null ? null : Number(assignment.billRatePerDay),
    notBilledReason: assignment.notBilledReason,
  };
}

function resolvePeriod(query: MarginQuery): { from: string; to: string } {
  if (query.from && query.to) return { from: query.from, to: query.to };

  // Default to the current calendar month, in IST — the same zone every other
  // date in the product is expressed in.
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));

  return {
    from: query.from ?? first.toISOString().slice(0, 10),
    to: query.to ?? last.toISOString().slice(0, 10),
  };
}

/** Calendar months the period touches, counted inclusively. */
function monthsBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1
  );
}

function make(
  bucket: { key: string; label: string; sublabel: string | null },
  margin: Margin,
  tally: { billableDays: number; payableDays: number },
  billing: BillingState,
): MarginRow {
  return {
    ...bucket,
    ...margin,
    billableDays: tally.billableDays,
    payableDays: tally.payableDays,
    unbilledAssignments: billing === 'undecided' ? 1 : 0,
    notBilledAssignments: billing === 'not_billed' ? 1 : 0,
  };
}

/**
 * Sums one assignment into a group.
 *
 * `marginPercent` is recomputed from the summed totals rather than averaged:
 * the mean of two percentages is not the percentage of the whole, and a small
 * loss-making assignment would otherwise drag a large profitable one down out
 * of all proportion.
 */
function add(
  row: MarginRow,
  margin: Margin,
  tally: { billableDays: number; payableDays: number },
  billing: BillingState,
): MarginRow {
  const revenue = round2(row.revenue + margin.revenue);
  const salaryCost = round2(row.salaryCost + margin.salaryCost);
  const reimbursements = round2(row.reimbursements + margin.reimbursements);
  const cost = round2(salaryCost + reimbursements);

  return {
    ...row,
    revenue,
    salaryCost,
    reimbursements,
    cost,
    margin: round2(revenue - cost),
    marginPercent: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
    // A group is "unbilled" only when nothing in it was billed at all.
    unbilled: row.unbilled && margin.unbilled,
    billableDays: round2(row.billableDays + tally.billableDays),
    payableDays: round2(row.payableDays + tally.payableDays),
    unbilledAssignments: row.unbilledAssignments + (billing === 'undecided' ? 1 : 0),
    notBilledAssignments: row.notBilledAssignments + (billing === 'not_billed' ? 1 : 0),
  };
}

function totalsOf(rows: MarginRow[]): MarginReport['totals'] {
  const revenue = round2(rows.reduce((sum, row) => sum + row.revenue, 0));
  const salaryCost = round2(rows.reduce((sum, row) => sum + row.salaryCost, 0));
  const reimbursements = round2(rows.reduce((sum, row) => sum + row.reimbursements, 0));
  const cost = round2(salaryCost + reimbursements);

  return {
    revenue,
    salaryCost,
    reimbursements,
    cost,
    margin: round2(revenue - cost),
    marginPercent: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
    unbilled: rows.length > 0 && rows.every((row) => row.unbilled),
    billableDays: round2(rows.reduce((sum, row) => sum + row.billableDays, 0)),
    unbilledAssignments: rows.reduce((sum, row) => sum + row.unbilledAssignments, 0),
    notBilledAssignments: rows.reduce((sum, row) => sum + row.notBilledAssignments, 0),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
