import { Injectable } from '@nestjs/common';
import {
  availabilityIn,
  scoreMatch,
  toIstDateString,
  type Availability,
  type HeldSkill,
  type MatchQuery,
  type MatchResult,
  type RequiredSkill,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { positionScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

export interface Candidate {
  trainerId: string;
  name: string;
  employeeCode: string;
  status: string;
  score: number;
  eligible: boolean;
  reasons: string[];
  matches: MatchResult['matches'];
  availability: Availability;
  /** What they are on now, so a staffer can see who they would be taken from. */
  commitments: {
    projectId: string;
    projectName: string;
    allocationPercent: number;
    endDate: string | null;
  }[];
}

export interface MatchReport {
  from: string;
  to: string;
  required: RequiredSkill[];
  position: { id: string; title: string; projectName: string } | null;
  candidates: Candidate[];
  /** Everyone considered, before `eligibleOnly` and `availableOnly` narrowed it. */
  consideredCount: number;
}

/** Trainers who could conceivably be staffed. Nobody deboarded or archived. */
const STAFFABLE = ['active', 'pending_onboarding', 'deboarding'] as const;

/**
 * Who could do this work, and when.
 *
 * Fit and availability are computed separately and reported separately, on
 * purpose. Folding them into one number would hide the trade a staffer
 * actually makes — the best-matched person is often the busiest, and whether
 * to pull them off something else is a decision for a human with context this
 * service does not have.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async find(query: MatchQuery, user: AuthenticatedUser): Promise<MatchReport> {
    const { from, to } = resolveWindow(query);
    const { required, position } = await this.requirementsFor(query, user);

    const trainers = await this.prisma.db.trainer.findMany({
      where: {
        status: { in: [...STAFFABLE] },
        deletedAt: null,
        ...(query.q
          ? {
              OR: [
                { user: { name: { contains: query.q, mode: 'insensitive' as const } } },
                { employeeCode: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        // Narrowing to one project asks "who on this team fits", which is the
        // question when backfilling somebody rather than hiring.
        ...(query.projectId
          ? { assignments: { some: { projectId: query.projectId, status: 'active' } } }
          : {}),
      },
      select: {
        id: true,
        employeeCode: true,
        status: true,
        user: { select: { name: true } },
        skills: {
          select: { skillId: true, proficiency: true, years: true, lastUsedOn: true },
        },
        assignments: {
          where: { status: 'active' },
          select: {
            projectId: true,
            startDate: true,
            endDate: true,
            allocationPercent: true,
            project: { select: { name: true } },
          },
        },
      },
    });

    const today = toIstDateString(new Date());

    const scored: Candidate[] = trainers.map((trainer) => {
      const held: HeldSkill[] = trainer.skills.map((skill) => ({
        skillId: skill.skillId,
        proficiency: skill.proficiency,
        years: skill.years == null ? null : Number(skill.years),
        lastUsedOn: skill.lastUsedOn ? toIstDateString(skill.lastUsedOn) : null,
      }));

      const commitments = trainer.assignments.map((assignment) => ({
        startDate: toIstDateString(assignment.startDate),
        endDate: assignment.endDate ? toIstDateString(assignment.endDate) : null,
        allocationPercent: assignment.allocationPercent,
      }));

      const result = scoreMatch(required, held, { today });

      return {
        trainerId: trainer.id,
        name: trainer.user.name,
        employeeCode: trainer.employeeCode,
        status: trainer.status,
        score: result.score,
        eligible: result.eligible,
        reasons: result.reasons,
        matches: result.matches,
        availability: availabilityIn(commitments, { from, to }),
        commitments: trainer.assignments.map((assignment) => ({
          projectId: assignment.projectId,
          projectName: assignment.project.name,
          allocationPercent: assignment.allocationPercent,
          endDate: assignment.endDate ? toIstDateString(assignment.endDate) : null,
        })),
      };
    });

    const candidates = scored
      .filter((candidate) => !query.eligibleOnly || candidate.eligible)
      .filter((candidate) => !query.availableOnly || candidate.availability.availablePercent > 0)
      // Fit first, then whoever is freest — so a tie is broken towards the
      // person who does not have to be taken off something else.
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.availability.availablePercent - a.availability.availablePercent ||
          a.name.localeCompare(b.name),
      );

    return {
      from,
      to,
      required,
      position,
      candidates,
      consideredCount: scored.length,
    };
  }

  /**
   * Where the requirements come from: a position, or a list typed by hand.
   *
   * The ad-hoc case matters because the question "who could teach Kubernetes in
   * November" is usually asked before anybody has opened a requisition, and
   * forcing one to exist first would mean the tool goes unused exactly when it
   * is most useful.
   */
  private async requirementsFor(query: MatchQuery, user: AuthenticatedUser) {
    if (query.positionId) {
      const position = await this.prisma.db.position.findFirst({
        where: scopedWhere(positionScope(user, 'matching.read'), {
          id: query.positionId,
          deletedAt: null,
        }),
        select: {
          id: true,
          title: true,
          project: { select: { name: true } },
          skills: {
            select: {
              skillId: true,
              requirement: true,
              minProficiency: true,
              skill: { select: { name: true } },
            },
          },
        },
      });
      if (!position) throw new NotFoundProblem('That position');

      return {
        required: position.skills.map((entry) => ({
          skillId: entry.skillId,
          name: entry.skill.name,
          requirement: entry.requirement,
          minProficiency: entry.minProficiency,
        })),
        position: { id: position.id, title: position.title, projectName: position.project.name },
      };
    }

    if (query.skillIds.length === 0) {
      throw new ValidationProblem('Say what you are looking for.', [
        { path: 'skillIds', message: 'name a position or at least one skill' },
      ]);
    }

    const skills = await this.prisma.db.skill.findMany({
      where: { id: { in: query.skillIds }, deletedAt: null },
      select: { id: true, name: true },
    });

    const missing = query.skillIds.filter((id) => !skills.some((skill) => skill.id === id));
    if (missing.length > 0) {
      throw new ValidationProblem('One of those skills is not in the catalogue.', [
        { path: 'skillIds', message: `unknown: ${missing.join(', ')}` },
      ]);
    }

    return {
      // Typed by hand, so every one is essential: somebody asking for React and
      // Node means both, and quietly demoting one to "nice to have" would put
      // people on the list who cannot do the job.
      required: skills.map((skill) => ({
        skillId: skill.id,
        name: skill.name,
        requirement: 'essential' as const,
        minProficiency: null,
      })),
      position: null,
    };
  }
}

/** Defaults to the next three months, which is the horizon staffing is planned on. */
function resolveWindow(query: MatchQuery): { from: string; to: string } {
  const today = toIstDateString(new Date());
  if (query.from && query.to) return { from: query.from, to: query.to };

  const end = new Date(`${today}T00:00:00.000Z`);
  end.setUTCMonth(end.getUTCMonth() + 3);

  return {
    from: query.from ?? today,
    to: query.to ?? end.toISOString().slice(0, 10),
  };
}
