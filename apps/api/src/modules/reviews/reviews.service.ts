import { Injectable } from '@nestjs/common';
import {
  can,
  scopeFor,
  summariseReviews,
  toIstDateString,
  type CreateReviewInput,
  type RetractReviewInput,
  type ReviewQuery,
  type ReviewSummary,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { assignmentScope, reviewScope, scopedWhere, trainerScope } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['observedOn', 'createdAt', 'rating'] as const;

const REVIEW_SELECT = {
  id: true,
  source: true,
  rating: true,
  knowledge: true,
  delivery: true,
  professionalism: true,
  respondents: true,
  comment: true,
  observedOn: true,
  createdAt: true,
  retractedAt: true,
  retractedReason: true,
  submittedBy: { select: { id: true, name: true, role: true } },
  retractedBy: { select: { id: true, name: true } },
  assignment: {
    select: {
      id: true,
      project: { select: { id: true, name: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { name: true } } },
      },
    },
  },
} as const;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether this caller may read the words as well as the numbers.
   *
   * A trainer sees their own scores and their trend — feedback nobody can see
   * cannot improve anybody — but not the raw comments or who wrote them. A
   * learner cohort's remarks are written under an expectation of anonymity, and
   * handing them over verbatim would break it and change what people write.
   */
  private readsComments(user: AuthenticatedUser): boolean {
    return scopeFor(user.role, 'reviews.read') !== 'own';
  }

  private redact<T extends { comment: string | null; submittedBy: unknown }>(
    rows: T[],
    user: AuthenticatedUser,
  ) {
    if (this.readsComments(user)) return rows;
    return rows.map(({ comment: _comment, submittedBy: _submittedBy, ...rest }) => rest);
  }

  async list(query: ReviewQuery, user: AuthenticatedUser) {
    const where = scopedWhere(reviewScope(user), {
      ...(query.includeRetracted ? {} : { retractedAt: null }),
      ...(query.source ? { source: query.source } : {}),
      ...(query.trainerId || query.projectId
        ? {
            assignment: {
              ...(query.trainerId ? { trainerId: query.trainerId } : {}),
              ...(query.projectId ? { projectId: query.projectId } : {}),
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { observedOn: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.trainerReview.findMany({ where, ...page, select: REVIEW_SELECT }),
      this.prisma.db.trainerReview.count({ where }),
    ]);

    return paginate(this.redact(rows, user), total, query);
  }

  /** Everything said about one trainer, summarised and listed. */
  async forTrainer(trainerId: string, user: AuthenticatedUser) {
    const trainer = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(user, 'reviews.read'), { id: trainerId }),
      select: { id: true },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');

    const rows = await this.prisma.db.trainerReview.findMany({
      where: { assignment: { trainerId } },
      select: REVIEW_SELECT,
      orderBy: { observedOn: 'desc' },
    });

    return {
      summary: summarise(rows),
      // Retracted ones are listed too — with the reason — because hiding them
      // would make a withdrawal indistinguishable from a review nobody wrote.
      data: this.redact(rows, user),
    };
  }

  /**
   * The summary alone, for the screens that need the verdict and not the words.
   *
   * Public to this module so the deboarding queue and the Talent Pool can put
   * the evidence next to the re-hire decision, which is the only reason any of
   * this exists.
   */
  async summaryFor(trainerIds: readonly string[]): Promise<Map<string, ReviewSummary>> {
    const ids = [...new Set(trainerIds)];
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.db.trainerReview.findMany({
      where: { assignment: { trainerId: { in: ids } } },
      select: {
        source: true,
        rating: true,
        knowledge: true,
        delivery: true,
        professionalism: true,
        respondents: true,
        observedOn: true,
        retractedAt: true,
        assignment: { select: { trainerId: true } },
      },
    });

    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const trainerId = row.assignment.trainerId;
      grouped.set(trainerId, [...(grouped.get(trainerId) ?? []), row]);
    }

    const result = new Map<string, ReviewSummary>();
    for (const id of ids) {
      result.set(id, summarise(grouped.get(id) ?? []));
    }
    return result;
  }

  async create(input: CreateReviewInput, actor: AuthenticatedUser) {
    const assignment = await this.prisma.db.assignment.findFirst({
      where: scopedWhere(assignmentScope(actor, 'reviews.write'), { id: input.assignmentId }),
      select: {
        id: true,
        startDate: true,
        trainer: { select: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!assignment) throw new NotFoundProblem('That assignment');

    // A project lead writes reviews and has a trainer profile of their own, so
    // this is reachable and necessary. 403 rather than 409, matching how leave
    // refuses somebody deciding on their own request: it is not a conflict with
    // the state, it is a thing this person may not do.
    if (assignment.trainer.user.id === actor.userId) {
      throw new ForbiddenProblem('You cannot record feedback about your own delivery.');
    }

    if (input.observedOn < toIstDateString(assignment.startDate)) {
      throw new DomainRuleProblem(
        'before-the-work',
        `${assignment.trainer.user.name} only started on this project on ${toIstDateString(assignment.startDate)}, so there is nothing from before then to judge.`,
      );
    }

    return this.prisma.db.trainerReview.create({
      data: {
        id: newId(),
        assignmentId: input.assignmentId,
        source: input.source,
        rating: input.rating,
        knowledge: input.knowledge,
        delivery: input.delivery,
        professionalism: input.professionalism,
        respondents: input.respondents,
        comment: input.comment,
        observedOn: new Date(`${input.observedOn}T00:00:00.000Z`),
        submittedById: actor.userId,
      },
      select: REVIEW_SELECT,
    });
  }

  /**
   * Withdraws a review. There is deliberately no way to edit one.
   *
   * Rewriting a score after the fact would make the record worth less than the
   * decision resting on it; a retraction says what was said, that it was
   * withdrawn, and why.
   */
  async retract(id: string, input: RetractReviewInput, actor: AuthenticatedUser) {
    const review = await this.prisma.db.trainerReview.findFirst({
      where: scopedWhere(reviewScope(actor, 'reviews.retract'), { id }),
      select: { id: true, retractedAt: true },
    });
    if (!review) throw new NotFoundProblem('That review');

    if (review.retractedAt) {
      throw new DomainRuleProblem('already-retracted', 'This review has already been withdrawn.');
    }

    return this.prisma.db.trainerReview.update({
      where: { id },
      data: {
        retractedAt: new Date(),
        retractedById: actor.userId,
        retractedReason: input.reason,
      },
      select: REVIEW_SELECT,
    });
  }

  /** Whether a caller sees comments, for a client that has to render accordingly. */
  capabilities(user: AuthenticatedUser) {
    return {
      mayWrite: can(user.role, 'reviews.write'),
      mayRetract: can(user.role, 'reviews.retract'),
      readsComments: this.readsComments(user),
    };
  }
}

/** Shared shape-shifting between a database row and what the rules expect. */
function summarise(
  rows: readonly {
    source: string;
    rating: number;
    knowledge: number | null;
    delivery: number | null;
    professionalism: number | null;
    respondents: number | null;
    observedOn: Date;
    retractedAt: Date | null;
  }[],
): ReviewSummary {
  return summariseReviews(
    rows.map((row) => ({
      source: row.source as never,
      rating: row.rating,
      knowledge: row.knowledge,
      delivery: row.delivery,
      professionalism: row.professionalism,
      respondents: row.respondents,
      observedOn: toIstDateString(row.observedOn),
      retracted: row.retractedAt != null,
    })),
  );
}
