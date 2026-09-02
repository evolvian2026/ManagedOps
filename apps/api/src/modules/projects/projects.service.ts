import { Injectable } from '@nestjs/common';
import {
  type CreateProjectInput,
  type ProjectQuery,
  type UpdateProjectInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { projectScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['createdAt', 'name', 'code', 'startDate', 'status'] as const;

const LIST_SELECT = {
  id: true,
  name: true,
  code: true,
  clientName: true,
  location: true,
  startDate: true,
  endDate: true,
  status: true,
  workStartTime: true,
  graceMinutes: true,
  weeklyOffDays: true,
  manager: { select: { id: true, name: true, email: true } },
  hr: { select: { id: true, name: true, email: true } },
  leadTrainer: { select: { id: true, name: true, email: true } },
  createdAt: true,
} as const;

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProjectQuery, user: AuthenticatedUser) {
    const where = scopedWhere(projectScope(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.managerId ? { managerId: query.managerId } : {}),
      ...(query.hrId ? { hrId: query.hrId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { code: { contains: query.q, mode: 'insensitive' as const } },
              { clientName: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { startDate: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.project.findMany({
        where,
        ...page,
        select: {
          ...LIST_SELECT,
          // Active assignments only. Counting every assignment ever made says
          // "5 trainers" on a card whose roster then lists four, because the
          // roster — correctly — shows only the people currently there.
          _count: {
            select: {
              positions: true,
              assignments: { where: { status: 'active' } },
            },
          },
        },
      }),
      this.prisma.db.project.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const project = await this.prisma.db.project.findFirst({
      where: scopedWhere(projectScope(user), { id }),
      select: {
        ...LIST_SELECT,
        positions: {
          where: { deletedAt: null },
          select: {
            id: true,
            title: true,
            headcount: true,
            filledCount: true,
            status: true,
            _count: { select: { applications: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { assignments: { where: { status: 'active' } } } },
      },
    });
    if (!project) throw new NotFoundProblem('That project');
    return project;
  }

  async create(input: CreateProjectInput, actor: AuthenticatedUser) {
    await this.assertOwnersExist(input.managerId, input.hrId, input.leadTrainerId);

    const existing = await this.prisma.raw.project.findUnique({ where: { code: input.code } });
    if (existing) {
      throw new ValidationProblem(`Project code ${input.code} is already in use.`, [
        { path: 'code', message: 'already in use' },
      ]);
    }

    return this.prisma.db.project.create({
      data: {
        id: newId(),
        name: input.name,
        code: input.code,
        clientName: input.clientName,
        location: input.location,
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
        managerId: input.managerId,
        hrId: input.hrId,
        leadTrainerId: input.leadTrainerId,
        workStartTime: input.workStartTime,
        graceMinutes: input.graceMinutes,
        weeklyOffDays: input.weeklyOffDays,
        createdById: actor.userId,
      },
      select: LIST_SELECT,
    });
  }

  async update(id: string, input: UpdateProjectInput, actor: AuthenticatedUser) {
    const project = await this.prisma.db.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundProblem('That project');

    await this.assertOwnersExist(input.managerId, input.hrId, input.leadTrainerId);

    const startDate = input.startDate ? new Date(input.startDate) : project.startDate;
    const endDate =
      input.endDate === undefined
        ? project.endDate
        : input.endDate
          ? new Date(input.endDate)
          : null;
    if (endDate && endDate < startDate) {
      throw new ValidationProblem('A project cannot end before it starts.', [
        { path: 'endDate', message: 'is before the start date' },
      ]);
    }

    return this.prisma.db.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.startDate !== undefined ? { startDate } : {}),
        ...(input.endDate !== undefined ? { endDate } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.managerId !== undefined ? { managerId: input.managerId } : {}),
        ...(input.hrId !== undefined ? { hrId: input.hrId } : {}),
        ...(input.leadTrainerId !== undefined ? { leadTrainerId: input.leadTrainerId } : {}),
        ...(input.workStartTime !== undefined ? { workStartTime: input.workStartTime } : {}),
        ...(input.graceMinutes !== undefined ? { graceMinutes: input.graceMinutes } : {}),
        ...(input.weeklyOffDays !== undefined ? { weeklyOffDays: input.weeklyOffDays } : {}),
        updatedById: actor.userId,
      },
      select: LIST_SELECT,
    });
  }

  /**
   * Soft delete, and only while the project is genuinely unused. Removing a
   * project that trainers have worked on would orphan their attendance and
   * daily logs, so the answer is to complete or cancel it instead.
   */
  async remove(id: string, actor: AuthenticatedUser) {
    const project = await this.prisma.db.project.findUnique({
      where: { id },
      include: { _count: { select: { assignments: true, positions: true } } },
    });
    if (!project) throw new NotFoundProblem('That project');

    if (project._count.assignments > 0) {
      throw new DomainRuleProblem(
        'project-in-use',
        'Trainers have been assigned to this project, so its history must be kept. Mark it completed or cancelled instead.',
      );
    }

    await this.prisma.db.project.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: actor.userId },
    });
    return { id, deleted: true };
  }

  async listHolidays(projectId: string, user: AuthenticatedUser) {
    await this.get(projectId, user);
    return this.prisma.db.holiday.findMany({
      // Organisation-wide holidays apply to every project, so both are returned.
      where: { OR: [{ projectId }, { projectId: null }] },
      orderBy: { date: 'asc' },
    });
  }

  async addHoliday(
    projectId: string,
    input: { date: string; name: string },
    user: AuthenticatedUser,
  ) {
    await this.get(projectId, user);
    return this.prisma.db.holiday.create({
      data: { id: newId(), projectId, date: new Date(input.date), name: input.name },
    });
  }

  /**
   * A project's manager, HR and lead are the routing table for approvals,
   * reimbursements and flags, so a wrong id here misroutes real work later.
   */
  private async assertOwnersExist(
    managerId?: string,
    hrId?: string,
    leadTrainerId?: string,
  ): Promise<void> {
    const checks: [string | undefined, string, string[]][] = [
      [managerId, 'managerId', ['manager', 'super_admin']],
      [hrId, 'hrId', ['hr', 'super_admin']],
      [leadTrainerId, 'leadTrainerId', ['project_lead', 'trainer']],
    ];

    for (const [id, field, roles] of checks) {
      if (!id) continue;
      const user = await this.prisma.db.user.findFirst({ where: { id, status: 'active' } });
      if (!user) {
        throw new ValidationProblem(`No active account matches the ${field} given.`, [
          { path: field, message: 'is not an active account' },
        ]);
      }
      if (!roles.includes(user.role)) {
        throw new ValidationProblem(
          `${user.name} is a ${user.role.replace(/_/g, ' ')}, which cannot be the ${field.replace('Id', '')} of a project.`,
          [{ path: field, message: `must be one of: ${roles.join(', ')}` }],
        );
      }
    }
  }
}
