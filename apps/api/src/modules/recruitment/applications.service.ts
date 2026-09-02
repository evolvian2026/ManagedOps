import { Injectable } from '@nestjs/common';
import {
  POOL_ELIGIBLE_APPLICATION_STATUSES,
  assertTransition,
  type ApplicationQuery,
  type ApplicationStatus,
  type CreateApplicationInput,
  type ScreenApplicationInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { applicationScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['createdAt', 'status'] as const;

/** Everything the Open Positions applications table renders in a row. */
const ROW_SELECT = {
  id: true,
  status: true,
  screeningOutcome: true,
  screeningNotes: true,
  screenedAt: true,
  rejectionReason: true,
  createdAt: true,
  candidate: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      linkedinUrl: true,
      resumeFileId: true,
      workedBefore: true,
    },
  },
  position: {
    select: {
      id: true,
      title: true,
      status: true,
      project: { select: { id: true, name: true, code: true } },
    },
  },
  screenedBy: { select: { id: true, name: true } },
} as const;

/** The screening call's three outcomes, and where each one sends the applicant. */
const SCREENING_ROUTES = {
  proceed: 'interviewing',
  not_available: 'not_available',
  reject: 'rejected_screening',
} as const satisfies Record<string, ApplicationStatus>;

@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ApplicationQuery, user: AuthenticatedUser) {
    const where = scopedWhere(applicationScope(user), {
      ...(query.positionId ? { positionId: query.positionId } : {}),
      ...(query.candidateId ? { candidateId: query.candidateId } : {}),
      ...(query.projectId ? { position: { projectId: query.projectId } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            candidate: {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { email: { contains: query.q, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE);
    const [data, total] = await Promise.all([
      this.prisma.db.application.findMany({ where, ...page, select: ROW_SELECT }),
      this.prisma.db.application.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const application = await this.prisma.db.application.findFirst({
      where: scopedWhere(applicationScope(user), { id }),
      select: {
        ...ROW_SELECT,
        interviews: {
          where: { deletedAt: null },
          select: {
            id: true,
            round: true,
            scheduledAt: true,
            status: true,
            outcome: true,
            meetingUrl: true,
            recordingUrl: true,
            feedback: true,
            interviewer: { select: { id: true, name: true } },
          },
          orderBy: { round: 'asc' },
        },
        offers: {
          select: {
            id: true,
            version: true,
            status: true,
            salaryAnnual: true,
            joiningDate: true,
            sentAt: true,
            respondedAt: true,
          },
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!application) throw new NotFoundProblem('That application');
    return application;
  }

  async create(input: CreateApplicationInput, actor: AuthenticatedUser) {
    const [candidate, position] = await Promise.all([
      this.prisma.db.candidate.findUnique({ where: { id: input.candidateId } }),
      this.prisma.db.position.findUnique({
        where: { id: input.positionId },
        include: { project: { select: { name: true } } },
      }),
    ]);

    if (!candidate) throw new NotFoundProblem('That candidate');
    if (!position) throw new NotFoundProblem('That position');

    if (position.status !== 'open') {
      throw new DomainRuleProblem(
        'position-not-open',
        `${position.title} is ${position.status}, so it is not taking applications.`,
      );
    }

    const duplicate = await this.prisma.db.application.findUnique({
      where: {
        candidateId_positionId: {
          candidateId: input.candidateId,
          positionId: input.positionId,
        },
      },
      select: { id: true, status: true },
    });
    if (duplicate) {
      throw new DomainRuleProblem(
        'already-applied',
        `${candidate.name} has already applied to ${position.title} and is currently ${duplicate.status.replace(/_/g, ' ')}.`,
      );
    }

    // One person may only hold one live application at a time — otherwise two
    // teams interview the same candidate for two projects without knowing.
    const liveElsewhere = await this.prisma.db.application.findFirst({
      where: {
        candidateId: input.candidateId,
        status: { in: ['applied', 'screening', 'interviewing', 'offer_stage'] },
      },
      select: { position: { select: { title: true } } },
    });
    if (liveElsewhere) {
      throw new DomainRuleProblem(
        'already-in-a-pipeline',
        `${candidate.name} is already in the pipeline for ${liveElsewhere.position.title}. Close that application first.`,
      );
    }

    return this.prisma.db.application.create({
      data: {
        id: newId(),
        candidateId: input.candidateId,
        positionId: input.positionId,
        status: 'applied',
        createdById: actor.userId,
      },
      select: ROW_SELECT,
    });
  }

  /**
   * The screening call, which is where most of the pipeline is actually decided.
   *
   * Proceed sends them to interviews; the other two close the application and
   * leave the person pool-eligible with a recorded reason, so they surface again
   * when a suitable position opens rather than being lost.
   */
  async screen(id: string, input: ScreenApplicationInput, actor: AuthenticatedUser) {
    const application = await this.prisma.db.application.findUnique({
      where: { id },
      include: { candidate: { select: { name: true } } },
    });
    if (!application) throw new NotFoundProblem('That application');

    const target = SCREENING_ROUTES[input.outcome];

    // `applied -> interviewing` is not a legal single step, so an application
    // that has not been picked up for screening yet moves through it here.
    const from: ApplicationStatus =
      application.status === 'applied' ? 'screening' : application.status;
    if (application.status === 'applied') {
      assertTransition('application', 'applied', 'screening');
    }
    assertTransition('application', from, target);

    const updated = await this.prisma.db.application.update({
      where: { id },
      data: {
        status: target,
        screeningOutcome: input.outcome,
        screeningNotes: input.notes,
        screenedById: actor.userId,
        screenedAt: new Date(),
        rejectionReason: input.reason,
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });

    await this.syncPoolEligibility(application.candidateId, target);
    return updated;
  }

  async withdraw(id: string, reason: string | undefined, actor: AuthenticatedUser) {
    const application = await this.prisma.db.application.findUnique({ where: { id } });
    if (!application) throw new NotFoundProblem('That application');

    assertTransition('application', application.status, 'withdrawn');

    const updated = await this.prisma.db.application.update({
      where: { id },
      data: { status: 'withdrawn', rejectionReason: reason, updatedById: actor.userId },
      select: ROW_SELECT,
    });

    await this.syncPoolEligibility(application.candidateId, 'withdrawn');
    return updated;
  }

  /**
   * Moves an application on, enforcing the transition table. Every other service
   * in recruitment routes through here rather than writing `status` itself, so
   * there is one place where an illegal move can be refused.
   */
  async advance(
    id: string,
    to: ApplicationStatus,
    actor: AuthenticatedUser,
    extra: { rejectionReason?: string } = {},
  ) {
    const application = await this.prisma.db.application.findUnique({ where: { id } });
    if (!application) throw new NotFoundProblem('That application');

    assertTransition('application', application.status, to);

    const updated = await this.prisma.db.application.update({
      where: { id },
      data: {
        status: to,
        ...(extra.rejectionReason ? { rejectionReason: extra.rejectionReason } : {}),
        updatedById: actor.userId,
      },
    });

    await this.syncPoolEligibility(application.candidateId, to);
    return updated;
  }

  /** Loads an application and refuses anything the caller may not act on. */
  async requireVisible(id: string, user: AuthenticatedUser) {
    const application = await this.prisma.db.application.findFirst({
      where: scopedWhere(applicationScope(user), { id }),
      include: {
        candidate: { select: { id: true, name: true, email: true } },
        position: { select: { id: true, title: true, projectId: true } },
      },
    });
    if (!application) throw new NotFoundProblem('That application');
    return application;
  }

  /**
   * Keeps the candidate's own record consistent with where their application
   * ended up. The Talent Pool is a query over these two facts, so nothing has
   * to be copied into a separate pool table that could then go stale.
   */
  private async syncPoolEligibility(candidateId: string, status: ApplicationStatus): Promise<void> {
    if (status === 'hired') {
      await this.prisma.db.candidate.update({
        where: { id: candidateId },
        data: { status: 'hired', poolEligible: false },
      });
      return;
    }

    if (POOL_ELIGIBLE_APPLICATION_STATUSES.includes(status)) {
      const candidate = await this.prisma.db.candidate.findUnique({
        where: { id: candidateId },
        select: { poolEligible: true },
      });
      // Respect an explicit "do not re-engage" that HR has already set.
      if (candidate?.poolEligible === false) return;

      await this.prisma.db.candidate.update({
        where: { id: candidateId },
        data: { poolEligible: true, status: 'active' },
      });
    }
  }

  /** Guards a screening reason that the schema cannot check on its own. */
  assertReasonPresent(outcome: string, reason?: string): void {
    if (outcome === 'reject' && !reason) {
      throw new ValidationProblem('Give a reason when rejecting.', [
        { path: 'reason', message: 'is required when rejecting' },
      ]);
    }
  }
}
