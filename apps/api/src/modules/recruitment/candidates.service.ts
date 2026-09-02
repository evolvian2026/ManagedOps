import { Injectable } from '@nestjs/common';
import type {
  CandidateQuery,
  CreateCandidateInput,
  UpdateCandidateInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { candidateScope, scopedWhere } from '../../common/scope.js';
import { FilesService } from '../files/files.service.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { ApplicationsService } from './applications.service.js';

const SORTABLE = ['createdAt', 'name', 'email'] as const;

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  linkedinUrl: true,
  source: true,
  status: true,
  poolEligible: true,
  workedBefore: true,
  notes: true,
  resumeFileId: true,
  createdAt: true,
} as const;

@Injectable()
export class CandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly applications: ApplicationsService,
  ) {}

  async list(query: CandidateQuery, user: AuthenticatedUser) {
    const where = scopedWhere(candidateScope(user), {
      ...(query.source ? { source: query.source } : {}),
      ...(query.poolEligible ? { poolEligible: query.poolEligible === 'true' } : {}),
      ...(query.workedBefore ? { workedBefore: query.workedBefore === 'true' } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { email: { contains: query.q, mode: 'insensitive' as const } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE);
    const [rows, total] = await Promise.all([
      this.prisma.db.candidate.findMany({
        where,
        ...page,
        select: { ...CANDIDATE_SELECT, _count: { select: { applications: true } } },
      }),
      this.prisma.db.candidate.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  /**
   * One person, with every application they have ever made. That history is the
   * point of separating candidate from application: someone rejected for one
   * position in March is a known quantity when a similar one opens in August.
   */
  async get(id: string, user: AuthenticatedUser) {
    const candidate = await this.prisma.db.candidate.findFirst({
      where: scopedWhere(candidateScope(user), { id }),
      select: {
        ...CANDIDATE_SELECT,
        applications: {
          select: {
            id: true,
            status: true,
            screeningOutcome: true,
            rejectionReason: true,
            createdAt: true,
            position: {
              select: {
                id: true,
                title: true,
                project: { select: { id: true, name: true, code: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!candidate) throw new NotFoundProblem('That candidate');
    return candidate;
  }

  /**
   * Intake is manual in v1 (spec assumption A12): details arrive by email or
   * WhatsApp and HR enters them. A resume is mandatory, so the record is never
   * a name and a phone number with nothing behind it.
   */
  async create(input: CreateCandidateInput, actor: AuthenticatedUser) {
    await this.files.requireConfirmed(input.resumeFileId);

    const existing = await this.prisma.db.candidate.findUnique({
      where: { email: input.email },
      select: { id: true, name: true },
    });
    if (existing) {
      // Naming the existing record turns a dead end into the next action: the
      // person is already known, so apply them rather than duplicating them.
      throw new ValidationProblem(
        `${input.email} is already on file as ${existing.name} (${existing.id}). Apply that person to the position instead of creating a duplicate.`,
        [{ path: 'email', message: 'already on file' }],
      );
    }

    const candidate = await this.prisma.db.candidate.create({
      data: {
        id: newId(),
        name: input.name,
        email: input.email,
        phone: input.phone,
        linkedinUrl: input.linkedinUrl,
        source: input.source,
        resumeFileId: input.resumeFileId,
        notes: input.notes,
        createdById: actor.userId,
      },
      select: CANDIDATE_SELECT,
    });

    await this.files.attach(input.resumeFileId, 'Candidate', candidate.id);

    // Entering a candidate and applying them to a position is one action for
    // the person doing it, so it is one request here too.
    const application = input.positionId
      ? await this.applications.create(
          { candidateId: candidate.id, positionId: input.positionId },
          actor,
        )
      : null;

    return { ...candidate, application };
  }

  async update(id: string, input: UpdateCandidateInput, actor: AuthenticatedUser) {
    const candidate = await this.prisma.db.candidate.findUnique({ where: { id } });
    if (!candidate) throw new NotFoundProblem('That candidate');

    if (input.resumeFileId) {
      await this.files.requireConfirmed(input.resumeFileId);
      await this.files.attach(input.resumeFileId, 'Candidate', id);
    }

    return this.prisma.db.candidate.update({
      where: { id },
      data: { ...input, updatedById: actor.userId },
      select: CANDIDATE_SELECT,
    });
  }
}
