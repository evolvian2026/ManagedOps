import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  can,
  toIstDateString,
  type AssignmentQuery,
  type CreateAssignmentInput,
  type SetBillRateInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { assignmentScope, projectScope, scopedWhere, trainerScope } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { TrainersService } from './trainers.service.js';

const SORTABLE = ['startDate', 'createdAt', 'status', 'role'] as const;

const ASSIGNMENT_SELECT = {
  id: true,
  role: true,
  status: true,
  startDate: true,
  endDate: true,
  leaveAllowanceDays: true,
  createdAt: true,
  project: {
    select: {
      id: true,
      name: true,
      code: true,
      client: { select: { id: true, name: true } },
    },
  },
  trainer: {
    select: {
      id: true,
      employeeCode: true,
      phone: true,
      workEmail: true,
      status: true,
      user: { select: { id: true, name: true, email: true } },
    },
  },
} as const;

/**
 * What a client pays is not part of an assignment for every reader of one.
 *
 * A trainer and a project lead both legitimately list assignments; neither has
 * any business seeing the day rate on them. Adding the field per-caller rather
 * than stripping it later means a new endpoint cannot leak it by forgetting to.
 */
function assignmentSelect(user: AuthenticatedUser) {
  return can(user.role, 'billing.read')
    ? { ...ASSIGNMENT_SELECT, billRatePerDay: true }
    : ASSIGNMENT_SELECT;
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trainers: TrainersService,
  ) {}

  async list(query: AssignmentQuery, user: AuthenticatedUser) {
    const where = scopedWhere(assignmentScope(user), {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.trainerId ? { trainerId: query.trainerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { startDate: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.assignment.findMany({ where, ...page, select: assignmentSelect(user) }),
      this.prisma.db.assignment.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  /**
   * Puts a trainer on a project.
   *
   * The partial unique index on (trainer, project) where status is active makes
   * a duplicate live assignment impossible at the storage layer; this check
   * exists to explain the refusal rather than to enforce it.
   */
  async create(trainerId: string, input: CreateAssignmentInput, actor: AuthenticatedUser) {
    const trainer = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(actor), { id: trainerId }),
      select: { id: true, status: true, user: { select: { name: true } } },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');

    if (trainer.status === 'deboarded' || trainer.status === 'archived') {
      throw new DomainRuleProblem(
        'trainer-not-available',
        `${trainer.user.name} is ${trainer.status}. Re-engage them from the Talent Pool first.`,
      );
    }

    const project = await this.prisma.db.project.findFirst({
      where: scopedWhere(projectScope(actor), { id: input.projectId }),
      select: {
        id: true,
        name: true,
        status: true,
        client: { select: { defaultDayRate: true } },
      },
    });
    if (!project) throw new NotFoundProblem('That project');

    if (project.status === 'completed' || project.status === 'cancelled') {
      throw new DomainRuleProblem(
        'project-closed',
        `${project.name} is ${project.status}, so nobody can be assigned to it.`,
      );
    }

    const duplicate = await this.prisma.db.assignment.findFirst({
      where: { trainerId, projectId: input.projectId, status: 'active' },
      select: { id: true, startDate: true },
    });
    if (duplicate) {
      throw new DomainRuleProblem(
        'already-assigned',
        `${trainer.user.name} is already on ${project.name} since ${toIstDateString(duplicate.startDate)}.`,
      );
    }

    const assignment = await this.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId,
        projectId: input.projectId,
        role: input.role,
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        leaveAllowanceDays: new Prisma.Decimal(input.leaveAllowanceDays),
        // Inherited from the contract, not asked for here. HR staffs projects
        // and does not hold `billing.manage`, so making them type a rate would
        // either block the assignment or invite a guess; the client's agreed
        // rate is the right default and a Manager can override it after.
        billRatePerDay: project.client.defaultDayRate,
        status: 'active',
        createdById: actor.userId,
      },
      select: assignmentSelect(actor),
    });

    // Having somewhere to work is half of what makes a trainer active.
    await this.trainers.refreshOnboardingState(trainerId);
    return assignment;
  }

  async end(assignmentId: string, endDate: string, actor: AuthenticatedUser) {
    const assignment = await this.prisma.db.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, status: true, startDate: true },
    });
    if (!assignment) throw new NotFoundProblem('That assignment');

    if (assignment.status === 'ended') {
      throw new DomainRuleProblem('already-ended', 'This assignment has already ended.');
    }
    if (new Date(endDate) < assignment.startDate) {
      throw new ValidationProblem('An assignment cannot end before it starts.', [
        { path: 'endDate', message: 'is before the start date' },
      ]);
    }

    return this.prisma.db.assignment.update({
      where: { id: assignmentId },
      data: { status: 'ended', endDate: new Date(endDate), updatedById: actor.userId },
      select: assignmentSelect(actor),
    });
  }

  /**
   * A project's roster with today's attendance beside each name — the Running
   * Projects table. A day nobody has punched yet simply has no record, and the
   * column says so rather than inventing a status nobody set.
   */
  async roster(projectId: string, user: AuthenticatedUser) {
    const project = await this.prisma.db.project.findFirst({
      where: scopedWhere(projectScope(user), { id: projectId }),
      select: {
        id: true,
        name: true,
        code: true,
        client: { select: { id: true, name: true } },
        status: true,
        startDate: true,
        endDate: true,
        workStartTime: true,
        graceMinutes: true,
        manager: { select: { id: true, name: true } },
        hr: { select: { id: true, name: true } },
      },
    });
    if (!project) throw new NotFoundProblem('That project');

    const workDate = new Date(`${toIstDateString(new Date())}T00:00:00.000Z`);
    const assignments = await this.prisma.db.assignment.findMany({
      where: scopedWhere(assignmentScope(user), { projectId, status: 'active' as const }),
      select: {
        ...assignmentSelect(user),
        attendance: {
          where: { workDate },
          select: { status: true, punchInAt: true, punchOutAt: true },
        },
      },
      orderBy: [{ role: 'asc' }, { startDate: 'asc' }],
    });

    return {
      project,
      workDate: toIstDateString(new Date()),
      data: assignments.map(({ attendance, ...assignment }) => ({
        ...assignment,
        today: attendance[0] ?? null,
      })),
    };
  }

  /**
   * Sets what the client pays for this trainer's days.
   *
   * Separate from `end` and from creation because it is a different decision by
   * a different person: staffing is HR's, pricing is the Manager's. Null is a
   * real answer — "this work is not billed" — and the audit trail is what
   * distinguishes it from a rate nobody has got round to agreeing.
   */
  async setBillRate(assignmentId: string, input: SetBillRateInput, actor: AuthenticatedUser) {
    const assignment = await this.prisma.db.assignment.findFirst({
      where: scopedWhere(assignmentScope(actor, 'billing.manage'), { id: assignmentId }),
      select: { id: true },
    });
    if (!assignment) throw new NotFoundProblem('That assignment');

    return this.prisma.db.assignment.update({
      where: { id: assignmentId },
      data: { billRatePerDay: input.billRatePerDay, updatedById: actor.userId },
      select: assignmentSelect(actor),
    });
  }
}
