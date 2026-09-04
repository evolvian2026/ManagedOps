import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  can,
  needsHighValueApproval,
  REIMBURSEMENT_HR_LIMIT,
  type CreateReimbursementInput,
  type DecideReimbursementInput,
  type MarkPaidInput,
  type ReimbursementQuery,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { reimbursementScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { FilesService } from '../files/files.service.js';
import { AssignmentContext } from './assignment-context.js';

const SORTABLE = ['createdAt', 'amount', 'status'] as const;

const CLAIM_SELECT = {
  id: true,
  category: true,
  amount: true,
  description: true,
  proofFileId: true,
  status: true,
  reviewedAt: true,
  reviewNote: true,
  paidAt: true,
  paymentReference: true,
  createdAt: true,
  reviewedBy: { select: { id: true, name: true } },
  trainer: {
    select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
  },
  assignment: { select: { id: true, project: { select: { id: true, name: true } } } },
} as const;

/**
 * Expense claims, from submission to the money moving.
 *
 * Two rules do the work. Proof is mandatory — a claim nobody can assess is a
 * claim nobody should approve — and it is checked as a confirmed upload, not
 * merely as an identifier that parses. And approval is tiered by amount: HR
 * settles anything up to ₹10,000, above which a Manager must sign off (spec
 * 4.7). The tier is enforced against the capability the caller actually holds,
 * so the limit cannot be stepped around by calling a different endpoint.
 */
@Injectable()
export class ReimbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly context: AssignmentContext,
  ) {}

  async create(input: CreateReimbursementInput, user: AuthenticatedUser) {
    const assignment = await this.context.resolveOwn(input.assignmentId, user);

    await this.files.requireConfirmed(input.proofFileId);

    const claim = await this.prisma.db.reimbursement.create({
      data: {
        id: newId(),
        trainerId: assignment.trainerId,
        assignmentId: assignment.id,
        category: input.category,
        amount: new Prisma.Decimal(input.amount),
        description: input.description,
        proofFileId: input.proofFileId,
        status: 'submitted',
      },
      select: CLAIM_SELECT,
    });
    await this.files.attach(input.proofFileId, 'Reimbursement', claim.id);

    // Routed to the project's HR, with the Manager copied when it is above their
    // limit — so the person who has to sign it off learns about it now.
    const { escalation } = await this.context.approvers(assignment.projectId);
    const [managerId, hrId] = escalation;
    await this.notifications.notify({
      userIds: needsHighValueApproval(input.amount) ? [hrId, managerId] : [hrId],
      type: 'reimbursement_submitted',
      title: `${assignment.trainer.user.name} submitted a claim`,
      body:
        `₹${input.amount.toLocaleString('en-IN')} — ${input.category}` +
        (needsHighValueApproval(input.amount)
          ? `. Above ₹${REIMBURSEMENT_HR_LIMIT.toLocaleString('en-IN')}, so it needs a Manager.`
          : '.'),
      entityType: 'Reimbursement',
      entityId: claim.id,
    });

    return claim;
  }

  async list(query: ReimbursementQuery, user: AuthenticatedUser) {
    const where = scopedWhere(reimbursementScope(user, capabilityFor(user)), {
      ...(query.trainerId ? { trainerId: query.trainerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.projectId ? { assignment: { projectId: query.projectId } } : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { createdAt: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.reimbursement.findMany({ where, ...page, select: CLAIM_SELECT }),
      this.prisma.db.reimbursement.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const claim = await this.prisma.db.reimbursement.findFirst({
      where: scopedWhere(reimbursementScope(user, capabilityFor(user)), { id }),
      select: CLAIM_SELECT,
    });
    if (!claim) throw new NotFoundProblem('That claim');
    return claim;
  }

  async decide(id: string, input: DecideReimbursementInput, user: AuthenticatedUser) {
    const claim = await this.prisma.db.reimbursement.findFirst({
      where: scopedWhere(reimbursementScope(user, 'reimbursements.approve'), { id }),
      select: {
        id: true,
        status: true,
        amount: true,
        trainerId: true,
        trainer: { select: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!claim) throw new NotFoundProblem('That claim');

    if (claim.trainerId === user.trainerId) {
      throw new ForbiddenProblem('You cannot decide on your own claim.');
    }

    assertTransition('reimbursement', claim.status, input.decision);

    const amount = Number(claim.amount);
    if (
      input.decision === 'approved' &&
      needsHighValueApproval(amount) &&
      !can(user.role, 'reimbursements.approve_high_value')
    ) {
      throw new ForbiddenProblem(
        `₹${amount.toLocaleString('en-IN')} is above the ₹${REIMBURSEMENT_HR_LIMIT.toLocaleString('en-IN')} limit, so a Manager has to approve it.`,
      );
    }

    const decided = await this.prisma.db.reimbursement.update({
      where: { id },
      data: {
        status: input.decision,
        reviewedById: user.userId,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote ?? null,
      },
      select: CLAIM_SELECT,
    });

    await this.notifications.notify({
      userIds: [claim.trainer.user.id],
      type: 'reimbursement_decided',
      title: input.decision === 'approved' ? 'Your claim was approved' : 'Your claim was rejected',
      body:
        `₹${amount.toLocaleString('en-IN')}` + (input.reviewNote ? ` — ${input.reviewNote}` : '.'),
      entityType: 'Reimbursement',
      entityId: id,
      // Somebody who paid for a client site out of their own pocket is waiting
      // on this one.
      mobile: {
        template: 'claim_decided',
        values: {
          name: claim.trainer.user.name,
          amount: `₹${amount.toLocaleString('en-IN')}`,
          outcome: input.decision === 'approved' ? 'approved' : 'rejected',
        },
      },
    });

    return decided;
  }

  /** Records that the money actually moved. Only an approved claim can be paid. */
  async markPaid(id: string, input: MarkPaidInput, user: AuthenticatedUser) {
    const claim = await this.prisma.db.reimbursement.findFirst({
      where: scopedWhere(reimbursementScope(user, 'reimbursements.mark_paid'), { id }),
      select: { id: true, status: true, amount: true, trainer: { select: { userId: true } } },
    });
    if (!claim) throw new NotFoundProblem('That claim');

    if (claim.status !== 'approved') {
      throw new DomainRuleProblem(
        'claim-not-approved',
        `This claim is ${claim.status}. Only an approved claim can be marked paid.`,
      );
    }
    assertTransition('reimbursement', claim.status, 'reimbursed');

    const paid = await this.prisma.db.reimbursement.update({
      where: { id },
      data: {
        status: 'reimbursed',
        paidAt: new Date(),
        paymentReference: input.reference ?? null,
      },
      select: CLAIM_SELECT,
    });

    await this.notifications.notify({
      userIds: [claim.trainer.userId],
      type: 'reimbursement_decided',
      title: 'Your claim has been paid',
      body:
        `₹${Number(claim.amount).toLocaleString('en-IN')} has been reimbursed` +
        (input.reference ? ` (reference ${input.reference}).` : '.'),
      entityType: 'Reimbursement',
      entityId: id,
      mobile: {
        template: 'claim_decided',
        values: {
          name: paid.trainer.user.name,
          amount: `₹${Number(claim.amount).toLocaleString('en-IN')}`,
          outcome: 'reimbursed',
        },
      },
    });

    return paid;
  }
}

/** An approver reads the queue; a claimant reads their own submissions. */
function capabilityFor(user: AuthenticatedUser) {
  return can(user.role, 'reimbursements.approve')
    ? ('reimbursements.approve' as const)
    : ('reimbursements.submit' as const);
}
