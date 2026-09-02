import { Injectable } from '@nestjs/common';
import type {
  CreateDeliverableInput,
  DeliverableQuery,
  UpdateDeliverableInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { NotFoundProblem } from '../../common/errors.js';
import { deliverableScope, ownAssignmentFilter, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { AssignmentContext } from './assignment-context.js';
import { FilesService } from '../files/files.service.js';
import { date } from './attendance.service.js';

const SORTABLE = ['dueDate', 'createdAt', 'status', 'title'] as const;

const DELIVERABLE_SELECT = {
  id: true,
  type: true,
  title: true,
  description: true,
  dueDate: true,
  status: true,
  fileId: true,
  completedAt: true,
  createdAt: true,
  assignment: {
    select: {
      id: true,
      project: { select: { id: true, name: true } },
      trainer: {
        select: { id: true, employeeCode: true, user: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

/**
 * Syllabus items and other duties, as a checklist against one assignment.
 *
 * The list is set by whoever runs the project — a trainer marks items done and
 * attaches evidence, but does not decide what they are responsible for. That
 * split is why `deliverables.write` covers both roles while creation is
 * restricted to callers whose scope reaches beyond their own record.
 */
@Injectable()
export class DeliverablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AssignmentContext,
    private readonly files: FilesService,
  ) {}

  async create(input: CreateDeliverableInput, user: AuthenticatedUser) {
    const assignment = await this.context.resolveReadable(input.assignmentId, user);

    return this.prisma.db.deliverable.create({
      data: {
        id: newId(),
        assignmentId: assignment.id,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        dueDate: input.dueDate ? date(input.dueDate) : null,
        status: 'pending',
        createdById: user.userId,
      },
      select: DELIVERABLE_SELECT,
    });
  }

  async list(query: DeliverableQuery, user: AuthenticatedUser) {
    const where = scopedWhere(deliverableScope(user), {
      ...(query.mine === 'true' ? ownAssignmentFilter(user) : {}),
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.trainerId || query.projectId
        ? {
            assignment: {
              ...(query.trainerId ? { trainerId: query.trainerId } : {}),
              ...(query.projectId ? { projectId: query.projectId } : {}),
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { createdAt: 'asc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.deliverable.findMany({ where, ...page, select: DELIVERABLE_SELECT }),
      this.prisma.db.deliverable.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /**
   * Marks progress, and attaches or removes the evidence file.
   *
   * `completedAt` is derived from the status rather than accepted from the
   * client: a completed item without a completion time, or a pending one
   * carrying yesterday's, is a row that cannot be reported on.
   */
  async update(id: string, input: UpdateDeliverableInput, user: AuthenticatedUser) {
    const deliverable = await this.prisma.db.deliverable.findFirst({
      where: scopedWhere(deliverableScope(user, 'deliverables.write'), { id }),
      select: { id: true, status: true, completedAt: true, assignmentId: true },
    });
    if (!deliverable) throw new NotFoundProblem('That deliverable');

    if (input.fileId) {
      // A row pointing at an upload that never finished is a broken link with
      // no error until somebody clicks it.
      await this.files.requireConfirmed(input.fileId);
      await this.files.attach(input.fileId, 'Deliverable', id);
    }

    const status = input.status ?? deliverable.status;

    return this.prisma.db.deliverable.update({
      where: { id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.dueDate ? { dueDate: date(input.dueDate) } : {}),
        ...(input.fileId !== undefined ? { fileId: input.fileId } : {}),
        status,
        // Derived, never taken from the client — and the original completion
        // time survives later edits, so "when was this finished" stays answerable.
        completedAt: status === 'completed' ? (deliverable.completedAt ?? new Date()) : null,
        updatedById: user.userId,
      },
      select: DELIVERABLE_SELECT,
    });
  }
}
