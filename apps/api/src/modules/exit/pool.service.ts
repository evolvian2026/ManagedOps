import { Injectable } from '@nestjs/common';
import type {
  ConsiderForPositionInput,
  PoolEntry,
  PoolQuery,
  PoolSource,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { newId } from '../../common/ids.js';
import { paginate } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem } from '../../common/errors.js';
import { positionScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { ApplicationsService } from '../recruitment/applications.service.js';

/** Application states that mean the conversation ended without a hire. */
const CLOSED_WITHOUT_HIRE = [
  'rejected_screening',
  'rejected_interview',
  'not_available',
  'offer_declined',
  'withdrawn',
] as const;

/**
 * The Talent Pool: everyone worth calling again.
 *
 * It is a query, not a table (spec 15.2). Two sources feed it — candidates whose
 * application ended without a hire and who are pool-eligible, and trainers who
 * have been deboarded and are marked re-hire eligible. Storing membership as a
 * status was the thing that made the reference documents contradict themselves:
 * a person cannot be both "rejected at interview" and "in the pool" when those
 * are the same field, and a stored pool goes stale the moment somebody's
 * eligibility changes anywhere else.
 *
 * Because it spans two tables it is assembled and paged in the service rather
 * than by the database. That is honest at this scale — a few thousand people —
 * and the alternative, a materialised view, would reintroduce exactly the
 * staleness the derived pool exists to avoid.
 */
@Injectable()
export class PoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly reviews: ReviewsService,
  ) {}

  // The caller is accepted or refused wholesale by `pool.read`: every role
  // holding it reads across projects, so there is no per-caller scope to
  // apply here. The parameter stays to keep the service signatures uniform.
  async list(query: PoolQuery, _user: AuthenticatedUser) {
    const wantsCandidates = query.source !== 'past_trainer';
    const wantsTrainers = query.source !== 'candidate';

    const [candidates, trainers] = await Promise.all([
      wantsCandidates ? this.candidateEntries(query) : Promise.resolve([]),
      wantsTrainers ? this.trainerEntries(query) : Promise.resolve([]),
    ]);

    let entries = [...candidates, ...trainers];

    if (query.workedBefore) {
      const wanted = query.workedBefore === 'true';
      entries = entries.filter((entry) => entry.workedBefore === wanted);
    }
    if (query.q) {
      const needle = query.q.toLowerCase();
      entries = entries.filter((entry) =>
        [entry.name, entry.email, entry.phone, entry.employeeCode ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }

    // Most recently seen first: the people we spoke to last month are the ones
    // worth calling before those from two years ago.
    entries.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));

    const total = entries.length;
    const start = (query.page - 1) * query.pageSize;
    return paginate(entries.slice(start, start + query.pageSize), total, query);
  }

  /**
   * Puts a pool entry back into the pipeline as a fresh application.
   *
   * A past trainer has a candidate record only if they were hired through the
   * pipeline; one who was added directly gets one created here, so the pool can
   * re-engage anybody it lists rather than only the people who happened to
   * arrive by the usual route.
   */
  async considerForPosition(
    entryId: string,
    input: ConsiderForPositionInput,
    actor: AuthenticatedUser,
  ) {
    const position = await this.prisma.db.position.findFirst({
      where: scopedWhere(positionScope(actor, 'pool.manage'), { id: input.positionId }),
      select: { id: true, title: true, status: true },
    });
    if (!position) throw new NotFoundProblem('That position');
    if (position.status !== 'open') {
      throw new DomainRuleProblem(
        'position-not-open',
        `${position.title} is ${position.status}, so nobody can be put forward for it.`,
      );
    }

    const candidateId = await this.resolveCandidate(entryId, actor);

    // Reuses the ordinary application path, so a pool re-engagement is subject
    // to the same rules as any other — one live application per person, no
    // duplicate against the same position — rather than a second way in.
    return this.applications.create({ candidateId, positionId: input.positionId }, actor);
  }

  /* ------------------------------------------------------------- internals */

  private async candidateEntries(query: PoolQuery): Promise<PoolEntry[]> {
    const rows = await this.prisma.db.candidate.findMany({
      where: {
        deletedAt: null,
        poolEligible: true,
        status: { not: 'archived' },
        ...(query.candidateSource ? { source: query.candidateSource } : {}),
        applications: {
          // Somebody still in flight is not in the pool; they are in the pipeline.
          some: {
            status: query.lastStatus ? query.lastStatus : { in: [...CLOSED_WITHOUT_HIRE] },
            ...(query.positionId ? { positionId: query.positionId } : {}),
            ...(query.projectId ? { position: { projectId: query.projectId } } : {}),
          },
          none: { status: { in: ['applied', 'screening', 'interviewing', 'offer_stage'] } },
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        resumeFileId: true,
        workedBefore: true,
        applications: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: {
            status: true,
            rejectionReason: true,
            screeningNotes: true,
            updatedAt: true,
            position: {
              select: { id: true, title: true, project: { select: { id: true, name: true } } },
            },
          },
        },
      },
      take: 500,
    });

    return rows.flatMap<PoolEntry>((candidate) => {
      const last = candidate.applications[0];
      if (!last) return [];
      return [
        {
          id: candidate.id,
          source: 'candidate' as PoolSource,
          name: candidate.name,
          email: candidate.email,
          phone: candidate.phone,
          resumeFileId: candidate.resumeFileId,
          workedBefore: candidate.workedBefore,
          lastStatus: last.status,
          // The rejection reason is the field Phase 1 made mandatory precisely
          // so a pool entry explains itself; screening notes are the internal
          // record of the call and only stand in when there is nothing better.
          lastReason: last.rejectionReason ?? last.screeningNotes,
          lastPosition: { id: last.position.id, title: last.position.title },
          lastProject: last.position.project
            ? { id: last.position.project.id, name: last.position.project.name }
            : null,
          lastSeenAt: last.updatedAt.toISOString(),
          employeeCode: null,
          // Never delivered anything for us, so there is nothing to have rated.
          quality: null,
        },
      ];
    });
  }

  private async trainerEntries(query: PoolQuery): Promise<PoolEntry[]> {
    // A status filter naming an application state cannot match a past trainer,
    // whose "last status" is how they left us.
    if (query.lastStatus) return [];

    const rows = await this.prisma.db.trainer.findMany({
      where: {
        deletedAt: null,
        status: 'deboarded',
        rehireEligible: true,
        ...(query.projectId ? { assignments: { some: { projectId: query.projectId } } } : {}),
      },
      select: {
        id: true,
        employeeCode: true,
        personalEmail: true,
        phone: true,
        candidateId: true,
        candidate: { select: { resumeFileId: true } },
        user: { select: { name: true, email: true } },
        assignments: {
          orderBy: { endDate: 'desc' },
          take: 1,
          select: {
            endDate: true,
            startDate: true,
            project: { select: { id: true, name: true } },
            deboarding: { select: { reason: true, completedAt: true } },
          },
        },
      },
      take: 500,
    });

    const quality = await this.reviews.summaryFor(rows.map((trainer) => trainer.id));

    return rows.map<PoolEntry>((trainer) => {
      const last = trainer.assignments[0];
      return {
        id: trainer.id,
        source: 'past_trainer' as PoolSource,
        name: trainer.user.name,
        email: trainer.personalEmail,
        phone: trainer.phone,
        resumeFileId: trainer.candidate?.resumeFileId ?? null,
        // They worked here by definition — that is what makes them a past trainer.
        workedBefore: true,
        lastStatus: 'deboarded',
        lastReason: last?.deboarding?.reason ?? null,
        lastPosition: null,
        lastProject: last ? { id: last.project.id, name: last.project.name } : null,
        quality: quality.get(trainer.id) ?? null,
        lastSeenAt: (
          last?.deboarding?.completedAt ??
          last?.endDate ??
          last?.startDate ??
          new Date(0)
        ).toISOString(),
        employeeCode: trainer.employeeCode,
      };
    });
  }

  /** A pool entry id is a candidate id or a trainer id; both resolve to a candidate. */
  private async resolveCandidate(entryId: string, actor: AuthenticatedUser): Promise<string> {
    const candidate = await this.prisma.db.candidate.findFirst({
      where: { id: entryId, deletedAt: null },
      select: { id: true, poolEligible: true, name: true },
    });
    if (candidate) {
      if (!candidate.poolEligible) {
        throw new DomainRuleProblem(
          'not-pool-eligible',
          `${candidate.name} has asked not to be contacted about future roles.`,
        );
      }
      return candidate.id;
    }

    const trainer = await this.prisma.db.trainer.findFirst({
      where: { id: entryId, deletedAt: null },
      select: {
        id: true,
        candidateId: true,
        rehireEligible: true,
        personalEmail: true,
        phone: true,
        user: { select: { name: true } },
      },
    });
    if (!trainer) throw new NotFoundProblem('That pool entry');

    if (!trainer.rehireEligible) {
      throw new DomainRuleProblem(
        'not-rehire-eligible',
        `${trainer.user.name} is marked as not eligible for re-hire.`,
      );
    }
    if (trainer.candidateId) return trainer.candidateId;

    // Hired outside the pipeline, so there is no candidate record to reuse. One
    // is created and linked, which keeps every application rooted in a person
    // rather than in a trainer row that may later be archived.
    const created = await this.prisma.db.$transaction(async (tx) => {
      const existing = await tx.candidate.findUnique({
        where: { email: trainer.personalEmail },
        select: { id: true },
      });
      const candidateRow =
        existing ??
        (await tx.candidate.create({
          data: {
            id: newId(),
            name: trainer.user.name,
            email: trainer.personalEmail,
            phone: trainer.phone,
            source: 'pool',
            status: 'active',
            poolEligible: true,
            workedBefore: true,
            createdById: actor.userId,
          },
          select: { id: true },
        }));

      await tx.trainer.update({
        where: { id: trainer.id },
        data: { candidateId: candidateRow.id },
      });
      return candidateRow;
    });

    return created.id;
  }
}
