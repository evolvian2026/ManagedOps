import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  IllegalTransitionError,
  toIstDateString,
  type CreateDeboardingInput,
  type DeboardingBlockers,
  type DeboardingQuery,
  type DeboardingStatus,
  type UpdateDeboardingInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem } from '../../common/errors.js';
import { deboardingScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AssignmentContext } from '../operations/assignment-context.js';
import { ReviewsService } from '../reviews/reviews.service.js';

const SORTABLE = ['lastWorkingDay', 'createdAt', 'status'] as const;

/** Everything not yet finished — the queue HR works from. */
const IN_PROGRESS: DeboardingStatus[] = ['initiated', 'assets_pending', 'fnf_pending'];

const DEBOARDING_SELECT = {
  id: true,
  lastWorkingDay: true,
  reason: true,
  status: true,
  assetsReconciled: true,
  travelNotes: true,
  fnfStatus: true,
  fnfAmount: true,
  fnfSettledAt: true,
  feedback: true,
  completedAt: true,
  createdAt: true,
  initiatedBy: { select: { id: true, name: true } },
  assignment: {
    select: {
      id: true,
      role: true,
      startDate: true,
      endDate: true,
      status: true,
      project: { select: { id: true, name: true, client: { select: { id: true, name: true } } } },
      trainer: {
        select: {
          id: true,
          employeeCode: true,
          status: true,
          rehireEligible: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  },
} as const;

/**
 * Winding one assignment down.
 *
 * The rule that matters is the one on completion: every issued asset reconciled
 * and the settlement either settled or explicitly waived (spec 4.10). Both are
 * checked against the records themselves rather than a checkbox — a tick saying
 * the laptop came back is worth nothing next to a row saying it did not — and
 * the refusal names the specific items, because "cannot complete" without
 * saying why is a dead end for whoever has to unblock it.
 *
 * The four states are walked in order rather than jumped: an HR who has settled
 * the money has, by definition, already dealt with the assets, and recording
 * that sequence is what makes the audit trail read as a process.
 */
@Injectable()
export class DeboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly context: AssignmentContext,
    private readonly reviews: ReviewsService,
  ) {}

  async create(input: CreateDeboardingInput, actor: AuthenticatedUser) {
    const assignment = await this.context.resolveReadable(input.assignmentId, actor);

    if (assignment.status === 'ended') {
      throw new DomainRuleProblem(
        'assignment-already-ended',
        'That assignment has already ended, so there is nothing left to wind down.',
      );
    }
    if (input.lastWorkingDay < toIstDateString(assignment.startDate)) {
      throw new DomainRuleProblem(
        'last-day-before-start',
        `Their last day cannot precede the start of the assignment on ${toIstDateString(assignment.startDate)}.`,
      );
    }

    const existing = await this.prisma.db.deboarding.findUnique({
      where: { assignmentId: input.assignmentId },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new DomainRuleProblem(
        'deboarding-already-open',
        `This assignment is already ${existing.status.replace(/_/g, ' ')}.`,
      );
    }

    const deboarding = await this.prisma.db.$transaction(async (tx) => {
      const created = await tx.deboarding.create({
        data: {
          id: newId(),
          assignmentId: input.assignmentId,
          initiatedById: actor.userId,
          lastWorkingDay: new Date(`${input.lastWorkingDay}T00:00:00.000Z`),
          reason: input.reason,
          status: 'initiated',
        },
        select: DEBOARDING_SELECT,
      });

      // The trainer is leaving, not gone: `deboarding` keeps them on the roster
      // and able to punch until their last day actually passes. A trainer
      // already winding down from another assignment stays as they are.
      const trainer = await tx.trainer.findUniqueOrThrow({
        where: { id: assignment.trainerId },
        select: { status: true },
      });
      if (trainer.status === 'active') {
        assertTransition('trainer', trainer.status, 'deboarding');
        await tx.trainer.update({
          where: { id: assignment.trainerId },
          data: { status: 'deboarding', updatedById: actor.userId },
        });
      }
      return created;
    });

    const { escalation } = await this.context.approvers(assignment.projectId);
    await this.notifications.notify({
      userIds: escalation,
      type: 'deboarding_initiated',
      title: `${assignment.trainer.user.name} is leaving ${assignment.project.name}`,
      body: `Last working day ${input.lastWorkingDay}. ${input.reason}`,
      entityType: 'Deboarding',
      entityId: deboarding.id,
    });

    return { ...deboarding, blockers: await this.blockers(input.assignmentId, deboarding) };
  }

  async list(query: DeboardingQuery, user: AuthenticatedUser) {
    // `status` and `open` constrain the same column, so exactly one is written.
    const statusFilter = query.status
      ? { status: query.status }
      : query.open === 'true'
        ? { status: { in: IN_PROGRESS } }
        : {};

    const where = scopedWhere(deboardingScope(user), {
      ...statusFilter,
      ...(query.projectId || query.trainerId
        ? {
            assignment: {
              ...(query.projectId ? { projectId: query.projectId } : {}),
              ...(query.trainerId ? { trainerId: query.trainerId } : {}),
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { lastWorkingDay: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.deboarding.findMany({ where, ...page, select: DEBOARDING_SELECT }),
      this.prisma.db.deboarding.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const deboarding = await this.prisma.db.deboarding.findFirst({
      where: scopedWhere(deboardingScope(user), { id }),
      select: DEBOARDING_SELECT,
    });
    if (!deboarding) throw new NotFoundProblem('That deboarding');

    // The evidence, beside the decision. Marking somebody re-hire eligible is
    // what puts them in the Talent Pool, and until now it was a box ticked with
    // nothing behind it.
    const [blockers, quality] = await Promise.all([
      this.blockers(deboarding.assignment.id, deboarding),
      this.reviews.summaryFor([deboarding.assignment.trainer.id]),
    ]);

    return {
      ...deboarding,
      blockers,
      quality: quality.get(deboarding.assignment.trainer.id) ?? null,
    };
  }

  /**
   * Records progress on the checklist and advances the state as the facts
   * change. Settling the money moves it to `fnf_pending`, not past it: the last
   * step is a deliberate act of completion, not a side effect of typing an
   * amount.
   */
  async update(id: string, input: UpdateDeboardingInput, actor: AuthenticatedUser) {
    const deboarding = await this.prisma.db.deboarding.findFirst({
      where: scopedWhere(deboardingScope(actor, 'deboarding.manage'), { id }),
      select: {
        id: true,
        status: true,
        fnfStatus: true,
        assignment: { select: { id: true, trainerId: true, startDate: true } },
      },
    });
    if (!deboarding) throw new NotFoundProblem('That deboarding');

    if (deboarding.status === 'completed') {
      throw new DomainRuleProblem(
        'deboarding-completed',
        'This deboarding is complete. Re-open it only by re-engaging the trainer.',
      );
    }
    if (
      input.lastWorkingDay &&
      input.lastWorkingDay < toIstDateString(deboarding.assignment.startDate)
    ) {
      throw new DomainRuleProblem(
        'last-day-before-start',
        'Their last day cannot precede the start of the assignment.',
      );
    }

    const outstanding = await this.outstandingAssets(deboarding.assignment.id);
    // The furthest stage today's facts justify. Completion is never one of
    // them — it is a deliberate act, not a side effect of typing an amount.
    const target = outstanding.length === 0 ? 'fnf_pending' : 'assets_pending';
    const nextStatus = advanceTo(deboarding.status, target);

    const updated = await this.prisma.db.$transaction(async (tx) => {
      if (input.rehireEligible !== undefined) {
        // Re-hire eligibility lives on the trainer, because it outlives the
        // assignment being wound down — it is what the Talent Pool reads.
        await tx.trainer.update({
          where: { id: deboarding.assignment.trainerId },
          data: { rehireEligible: input.rehireEligible, updatedById: actor.userId },
        });
      }

      return tx.deboarding.update({
        where: { id },
        data: {
          ...(input.lastWorkingDay
            ? { lastWorkingDay: new Date(`${input.lastWorkingDay}T00:00:00.000Z`) }
            : {}),
          ...(input.travelNotes !== undefined ? { travelNotes: input.travelNotes } : {}),
          ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
          ...(input.fnfStatus ? { fnfStatus: input.fnfStatus } : {}),
          ...(input.fnfAmount !== undefined
            ? { fnfAmount: new Prisma.Decimal(input.fnfAmount) }
            : {}),
          ...(input.fnfStatus === 'settled' || input.fnfStatus === 'waived'
            ? { fnfSettledAt: new Date() }
            : {}),
          // Derived from the register, never accepted from the client.
          assetsReconciled: outstanding.length === 0,
          ...(nextStatus === deboarding.status ? {} : { status: nextStatus }),
        },
        select: DEBOARDING_SELECT,
      });
    });

    return { ...updated, blockers: await this.blockers(deboarding.assignment.id, updated) };
  }

  /**
   * Ends it. The trainer becomes `deboarded`, the assignment `ended`, and — if
   * they are re-hire eligible — they appear in the Talent Pool, which is a
   * query over this state rather than a flag anybody has to remember to set.
   */
  async complete(id: string, actor: AuthenticatedUser) {
    const deboarding = await this.prisma.db.deboarding.findFirst({
      where: scopedWhere(deboardingScope(actor, 'deboarding.manage'), { id }),
      select: {
        id: true,
        status: true,
        fnfStatus: true,
        lastWorkingDay: true,
        assignment: {
          select: {
            id: true,
            trainerId: true,
            status: true,
            project: { select: { name: true } },
            trainer: {
              select: {
                id: true,
                status: true,
                rehireEligible: true,
                user: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!deboarding) throw new NotFoundProblem('That deboarding');

    const blockers = await this.blockers(deboarding.assignment.id, deboarding);
    if (!blockers.canComplete) {
      throw new DomainRuleProblem('deboarding-blocked', blockers.reasons.join(' '));
    }

    // Walk the remaining stages rather than jumping: the table is the authority
    // on what order this happens in, and the audit trail reads as a process.
    advanceTo(deboarding.status, 'completed');

    await this.prisma.db.$transaction(async (tx) => {
      await tx.deboarding.update({
        where: { id },
        data: { status: 'completed', assetsReconciled: true, completedAt: new Date() },
      });
      await tx.assignment.update({
        where: { id: deboarding.assignment.id },
        data: {
          status: 'ended',
          endDate: deboarding.lastWorkingDay,
          updatedById: actor.userId,
        },
      });

      const trainer = deboarding.assignment.trainer;
      assertTransition('trainer', trainer.status, 'deboarded');
      await tx.trainer.update({
        where: { id: trainer.id },
        data: { status: 'deboarded', updatedById: actor.userId },
      });

      // Their login stops working; the record stays for the Talent Pool.
      await tx.user.update({
        where: { id: trainer.user.id },
        data: { status: 'disabled', updatedById: actor.userId },
      });
    });

    return this.get(id, actor);
  }

  /* ------------------------------------------------------------- internals */

  /** Assets still out against this assignment, plus anything lost or damaged. */
  private async outstandingAssets(assignmentId: string) {
    const issues = await this.prisma.db.assetIssue.findMany({
      where: { assignmentId, status: { in: ['issued', 'lost', 'damaged'] } },
      select: {
        id: true,
        status: true,
        asset: { select: { name: true, serialNumber: true } },
      },
    });
    return issues.map((issue) => ({
      id: issue.id,
      name: issue.asset.name,
      serialNumber: issue.asset.serialNumber,
      status: issue.status,
    }));
  }

  /**
   * What is standing in the way, named. "Cannot complete" with no explanation is
   * a dead end for the person who has to unblock it.
   */
  async blockers(
    assignmentId: string,
    deboarding: { status: string; fnfStatus: string },
  ): Promise<DeboardingBlockers> {
    const outstandingAssets = await this.outstandingAssets(assignmentId);
    const fnfSettled = deboarding.fnfStatus === 'settled' || deboarding.fnfStatus === 'waived';
    const reasons: string[] = [];

    if (outstandingAssets.length > 0) {
      const names = outstandingAssets
        .map((asset) => `${asset.name}${asset.serialNumber ? ` (${asset.serialNumber})` : ''}`)
        .join(', ');
      reasons.push(`Still to reconcile: ${names}.`);
    }
    if (!fnfSettled) {
      reasons.push('The full and final settlement is still pending — settle or waive it.');
    }
    if (deboarding.status === 'completed') {
      reasons.push('This deboarding is already complete.');
    }

    return {
      outstandingAssets,
      fnfSettled,
      canComplete: reasons.length === 0,
      reasons,
    };
  }
}

/** The four stages, in the only order they may be walked. */
const STAGES: DeboardingStatus[] = ['initiated', 'assets_pending', 'fnf_pending', 'completed'];

/**
 * Walks forward to `target`, asserting every hop against the transition table
 * and returning where it lands.
 *
 * Deboarding never moves backwards — assets that came back and then went out
 * again are a new issue, not a reversal — so a target already behind the
 * current stage simply leaves it where it is. Asserting each hop rather than
 * assigning the end state keeps the table the authority on what is reachable.
 */
function advanceTo(current: string, target: DeboardingStatus): DeboardingStatus {
  const from = STAGES.indexOf(current as DeboardingStatus);
  const to = STAGES.indexOf(target);
  if (from < 0) throw new IllegalTransitionError('deboarding', current, target);
  if (to <= from) return current as DeboardingStatus;

  for (let step = from; step < to; step += 1) {
    assertTransition('deboarding', STAGES[step]!, STAGES[step + 1]!);
  }
  return target;
}
