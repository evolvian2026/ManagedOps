import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toIstDateString } from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { DomainRuleProblem, NotFoundProblem } from '../../common/errors.js';
import { assignmentScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const ASSIGNMENT_CONTEXT_SELECT = {
  id: true,
  trainerId: true,
  projectId: true,
  role: true,
  status: true,
  startDate: true,
  endDate: true,
  leaveAllowanceDays: true,
  project: {
    select: {
      id: true,
      name: true,
      workStartTime: true,
      graceMinutes: true,
      weeklyOffDays: true,
      managerId: true,
      hrId: true,
      leadTrainerId: true,
    },
  },
  trainer: {
    select: {
      id: true,
      employeeCode: true,
      personalEmail: true,
      locationConsentAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  },
} as const;

/** The shape every operations service reads an assignment through. */
export type AssignmentContextRow = Prisma.AssignmentGetPayload<{
  select: typeof ASSIGNMENT_CONTEXT_SELECT;
}>;

/**
 * "Which assignment is this about?" — asked by every self-service action.
 *
 * A trainer punches in, logs a session, requests leave and submits a claim
 * without naming an assignment: they have one, and the client should not have to
 * know its identifier to use the product. When they hold two (a rare overlap
 * mid-transfer) the ambiguity is refused with the list of candidates rather than
 * resolved by picking the newest and hoping.
 *
 * Shared by every operations service so the answer cannot differ between them.
 */
@Injectable()
export class AssignmentContext {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own active assignment, for a self-service write. */
  async resolveOwn(
    assignmentId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<AssignmentContextRow> {
    if (!user.trainerId) {
      throw new DomainRuleProblem(
        'no-trainer-profile',
        'This action belongs to a trainer, and your account does not have a trainer profile.',
      );
    }

    if (assignmentId) {
      const named = await this.prisma.db.assignment.findFirst({
        where: { id: assignmentId, trainerId: user.trainerId },
        select: ASSIGNMENT_CONTEXT_SELECT,
      });
      if (!named) throw new NotFoundProblem('That assignment');
      if (named.status !== 'active') {
        throw new DomainRuleProblem(
          'assignment-ended',
          `Your assignment to ${named.project.name} ended on ${toIstDateString(named.endDate ?? named.startDate)}.`,
        );
      }
      return named;
    }

    const active = await this.prisma.db.assignment.findMany({
      where: { trainerId: user.trainerId, status: 'active' },
      select: ASSIGNMENT_CONTEXT_SELECT,
      orderBy: { startDate: 'desc' },
    });

    if (active.length === 0) {
      throw new DomainRuleProblem(
        'no-active-assignment',
        'You are not currently assigned to a project, so there is nothing to record against.',
      );
    }
    if (active.length > 1) {
      const names = active.map((row) => row.project.name).join(' and ');
      throw new DomainRuleProblem(
        'ambiguous-assignment',
        `You are on ${names}. Say which project this is for.`,
      );
    }
    return active[0];
  }

  /** Any assignment the caller is allowed to read, for an admin or lead view. */
  async resolveReadable(
    assignmentId: string,
    user: AuthenticatedUser,
  ): Promise<AssignmentContextRow> {
    const assignment = await this.prisma.db.assignment.findFirst({
      where: scopedWhere(assignmentScope(user), { id: assignmentId }),
      select: ASSIGNMENT_CONTEXT_SELECT,
    });
    if (!assignment) throw new NotFoundProblem('That assignment');
    return assignment;
  }

  /** Project holidays inside a date range, as `YYYY-MM-DD` strings. */
  async holidays(projectId: string, from: string, to: string): Promise<string[]> {
    const rows = await this.prisma.db.holiday.findMany({
      where: {
        // A null projectId is an organisation-wide holiday and applies here too.
        OR: [{ projectId }, { projectId: null }],
        date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      },
      select: { date: true },
    });
    return rows.map((row) => toIstDateString(row.date));
  }

  /** Who decides on this project: the lead first, then the manager and HR. */
  async approvers(projectId: string): Promise<{ leadUserId: string | null; escalation: string[] }> {
    const project = await this.prisma.db.project.findUnique({
      where: { id: projectId },
      select: { managerId: true, hrId: true, leadTrainerId: true },
    });
    if (!project) return { leadUserId: null, escalation: [] };
    return {
      leadUserId: project.leadTrainerId,
      escalation: [project.managerId, project.hrId],
    };
  }
}
