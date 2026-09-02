import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  scopeFor,
  type AssetQuery,
  type CreateAssetInput,
  type IssueAssetInput,
  type ReturnAssetInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem } from '../../common/errors.js';
import { assetIssueScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { AssignmentContext } from './assignment-context.js';

const SORTABLE = ['name', 'createdAt', 'status', 'category'] as const;

const ISSUE_SELECT = {
  id: true,
  issuedAt: true,
  issueSerial: true,
  issueNotes: true,
  returnedAt: true,
  returnSerial: true,
  returnNotes: true,
  status: true,
  asset: { select: { id: true, name: true, category: true, serialNumber: true } },
  issuedBy: { select: { id: true, name: true } },
  assignment: {
    select: {
      id: true,
      project: { select: { id: true, name: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

/**
 * The asset register, and what is currently in whose hands.
 *
 * The reconciliation rule is the point of the module: the serial recorded at
 * issue is compared against the serial typed at return (spec 4.8), so returning
 * *a* laptop is not the same as returning *the* laptop. Digital resources — a
 * work email account — carry no serial and are exempt, because inventing one
 * would make the comparison meaningless rather than strict.
 *
 * Nothing here silently absolves a loss: a lost or damaged issue stays on the
 * assignment and is what blocks deboarding from completing.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AssignmentContext,
  ) {}

  async create(input: CreateAssetInput, user: AuthenticatedUser) {
    if (input.serialNumber) {
      const clash = await this.prisma.db.asset.findUnique({
        where: { serialNumber: input.serialNumber },
        select: { id: true, name: true },
      });
      if (clash) {
        throw new DomainRuleProblem(
          'serial-already-registered',
          `Serial ${input.serialNumber} is already registered to ${clash.name}.`,
        );
      }
    }

    return this.prisma.db.asset.create({
      data: {
        id: newId(),
        name: input.name,
        category: input.category,
        serialNumber: input.serialNumber ?? null,
        status: 'available',
        notes: input.notes ?? null,
        createdById: user.userId,
      },
    });
  }

  async list(query: AssetQuery, user: AuthenticatedUser) {
    // An asset the caller may see is one they could be issued or could issue.
    // A trainer sees what is in their own hands, not the whole store cupboard.
    const issueFilter = scopedWhere(assetIssueScope(user), {
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.trainerId ? { assignment: { trainerId: query.trainerId } } : {}),
      status: 'issued' as const,
    });

    // Someone whose `assets.read` reaches only their own records sees the
    // register through what they hold, never the whole store cupboard. Deciding
    // that from the scope rather than from the role name keeps the rule in one
    // place — the permission matrix — where the tests already walk it.
    const holderOnly = scopeFor(user.role, 'assets.read') === 'own';
    const scopedToHolder =
      holderOnly || query.assignmentId || query.trainerId ? { issues: { some: issueFilter } } : {};

    const where = {
      deletedAt: null,
      ...scopedToHolder,
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const page = toPrismaPage(query, SORTABLE, { name: 'asc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.asset.findMany({
        where,
        ...page,
        include: {
          issues: {
            where: { status: 'issued' },
            select: ISSUE_SELECT,
            orderBy: { issuedAt: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.db.asset.count({ where }),
    ]);

    return paginate(
      rows.map(({ issues, ...asset }) => ({ ...asset, currentIssue: issues[0] ?? null })),
      total,
      query,
    );
  }

  /** Everything currently in one trainer's hands — their Resources screen. */
  async issuedTo(user: AuthenticatedUser, assignmentId?: string) {
    const assignment = assignmentId
      ? await this.context.resolveReadable(assignmentId, user)
      : await this.context.resolveOwn(undefined, user);

    return this.prisma.db.assetIssue.findMany({
      where: { assignmentId: assignment.id },
      select: ISSUE_SELECT,
      orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
    });
  }

  async issue(assetId: string, input: IssueAssetInput, user: AuthenticatedUser) {
    const asset = await this.prisma.db.asset.findFirst({
      where: { id: assetId, deletedAt: null },
      select: { id: true, name: true, status: true, category: true, serialNumber: true },
    });
    if (!asset) throw new NotFoundProblem('That asset');

    if (asset.status !== 'available') {
      throw new DomainRuleProblem(
        'asset-not-available',
        `${asset.name} is ${asset.status}, so it cannot be issued.`,
      );
    }

    const assignment = await this.context.resolveReadable(input.assignmentId, user);
    if (assignment.status !== 'active') {
      throw new DomainRuleProblem(
        'assignment-ended',
        'That assignment has ended, so nothing more can be issued against it.',
      );
    }

    if (asset.serialNumber && input.issueSerial && input.issueSerial !== asset.serialNumber) {
      throw new DomainRuleProblem(
        'serial-mismatch',
        `The register has ${asset.serialNumber} for ${asset.name}; you typed ${input.issueSerial}.`,
      );
    }

    return this.prisma.db.$transaction(async (tx) => {
      const issued = await tx.assetIssue.create({
        data: {
          id: newId(),
          assetId,
          assignmentId: assignment.id,
          issuedById: user.userId,
          issueSerial: input.issueSerial ?? asset.serialNumber,
          issueNotes: input.issueNotes ?? null,
          status: 'issued',
        },
        select: ISSUE_SELECT,
      });
      await tx.asset.update({ where: { id: assetId }, data: { status: 'issued' } });
      return issued;
    });
  }

  /**
   * Closes an issue. A returned serial that does not match the issued one is
   * refused rather than accepted with a note, because "it came back, just not
   * this one" is precisely the discrepancy the register exists to catch.
   */
  async returnIssue(issueId: string, input: ReturnAssetInput, user: AuthenticatedUser) {
    // Scoped even though `assets.manage` is currently held only at 'all'. If the
    // matrix ever narrows it, the query narrows with it rather than quietly
    // continuing to reach every issue in the organisation.
    const issue = await this.prisma.db.assetIssue.findFirst({
      where: scopedWhere(assetIssueScope(user, 'assets.manage'), { id: issueId }),
      select: {
        id: true,
        status: true,
        issueSerial: true,
        assetId: true,
        asset: { select: { name: true, category: true } },
      },
    });
    if (!issue) throw new NotFoundProblem('That asset issue');

    assertTransition('assetIssue', issue.status, input.condition);

    if (
      input.condition === 'returned' &&
      issue.asset.category !== 'digital' &&
      issue.issueSerial &&
      input.returnSerial !== issue.issueSerial
    ) {
      throw new DomainRuleProblem(
        'serial-mismatch',
        input.returnSerial
          ? `${issue.asset.name} was issued as ${issue.issueSerial}; ${input.returnSerial} came back. Record it as damaged or lost if the unit was swapped.`
          : `Type the serial on the returned ${issue.asset.name} so it can be checked against ${issue.issueSerial}.`,
      );
    }

    return this.prisma.db.$transaction(async (tx) => {
      const closed = await tx.assetIssue.update({
        where: { id: issueId },
        data: {
          status: input.condition,
          returnedAt: new Date(),
          returnSerial: input.returnSerial ?? null,
          returnNotes: input.returnNotes ?? null,
        },
        select: ISSUE_SELECT,
      });
      // A returned unit goes back on the shelf; a lost or damaged one does not.
      await tx.asset.update({
        where: { id: issue.assetId },
        data: { status: input.condition === 'returned' ? 'available' : input.condition },
      });
      return closed;
    });
  }

  /** Issues still open against an assignment — what blocks a deboarding. */
  async outstandingFor(assignmentId: string): Promise<number> {
    return this.prisma.db.assetIssue.count({
      where: { assignmentId, status: 'issued' },
    });
  }
}

export type AssetIssueRow = Prisma.AssetIssueGetPayload<{ select: typeof ISSUE_SELECT }>;
