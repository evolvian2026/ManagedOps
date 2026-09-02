import { Injectable } from '@nestjs/common';
import {
  assertTransition,
  can,
  type CreateFlagInput,
  type FlagQuery,
  type FlagStatus,
  type ResolveFlagInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { flagScope, scopedWhere } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AssignmentContext } from './assignment-context.js';

const SORTABLE = ['createdAt', 'severity', 'status'] as const;

/** Anything not yet closed — the queue an approver works from. */
const OPEN_STATUSES: FlagStatus[] = ['raised', 'acknowledged', 'action_taken'];

const FLAG_SELECT = {
  id: true,
  severity: true,
  description: true,
  status: true,
  actionTaken: true,
  resolutionNote: true,
  resolvedAt: true,
  createdAt: true,
  raisedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
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
 * A concern raised against a trainer on a project.
 *
 * The reference documents had the raiser pick who to send it to; that is gone
 * (spec 15.5). A flag is a fact about a project, and the two people accountable
 * for that project — its Manager and its HR — are told automatically. Choosing
 * recipients invited a flag being raised to nobody in particular, and a flag
 * nobody reads is worse than no flag.
 *
 * Resolution requires both an action and a note. "Closed" with neither is the
 * outcome that makes the whole record untrustworthy six months later.
 */
@Injectable()
export class FlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly context: AssignmentContext,
  ) {}

  async create(input: CreateFlagInput, user: AuthenticatedUser) {
    const assignment = await this.context.resolveReadable(input.assignmentId, user);

    if (assignment.trainerId === user.trainerId) {
      throw new ForbiddenProblem('You cannot raise a flag against yourself.');
    }

    const flag = await this.prisma.db.flag.create({
      data: {
        id: newId(),
        assignmentId: assignment.id,
        raisedById: user.userId,
        severity: input.severity,
        description: input.description,
        status: 'raised',
      },
      select: FLAG_SELECT,
    });

    const { escalation } = await this.context.approvers(assignment.projectId);
    await this.notifications.notify({
      userIds: escalation,
      type: 'flag_raised',
      title: `${input.severity} concern raised about ${assignment.trainer.user.name}`,
      body: `${input.description.slice(0, 200)} — on ${assignment.project.name}.`,
      entityType: 'Flag',
      entityId: flag.id,
    });

    return flag;
  }

  async list(query: FlagQuery, user: AuthenticatedUser) {
    // `status` and `open` describe the same column, so only one is written —
    // an explicit status wins over the shorthand rather than one silently
    // overwriting the other in the object literal.
    const statusFilter = query.status
      ? { status: query.status }
      : query.open === 'true'
        ? { status: { in: OPEN_STATUSES } }
        : {};

    const where = scopedWhere(flagScope(user, capabilityFor(user)), {
      ...statusFilter,
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.trainerId || query.projectId
        ? {
            assignment: {
              ...(query.trainerId ? { trainerId: query.trainerId } : {}),
              ...(query.projectId ? { projectId: query.projectId } : {}),
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE, { createdAt: 'desc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.flag.findMany({ where, ...page, select: FLAG_SELECT }),
      this.prisma.db.flag.count({ where }),
    ]);
    return paginate(rows, total, query);
  }

  /** Acknowledging says somebody has picked it up, before they know the outcome. */
  async acknowledge(id: string, user: AuthenticatedUser) {
    const flag = await this.requireResolvable(id, user);
    assertTransition('flag', flag.status, 'acknowledged');

    return this.prisma.db.flag.update({
      where: { id },
      data: { status: 'acknowledged' },
      select: FLAG_SELECT,
    });
  }

  /**
   * Records what was done and closes the flag.
   *
   * Resolving skips the intermediate steps — recording an outcome is a stronger
   * statement than picking the item up, and refusing it on a technicality would
   * only teach people to click Acknowledge without reading. The hops are still
   * walked through the transition table rather than around it, so the table
   * stays the authority on what is reachable from where.
   */
  async resolve(id: string, input: ResolveFlagInput, user: AuthenticatedUser) {
    const flag = await this.requireResolvable(id, user);

    for (const [from, to] of hopsToClose(flag.status)) assertTransition('flag', from, to);

    const resolved = await this.prisma.db.flag.update({
      where: { id },
      data: {
        status: 'closed',
        actionTaken: input.actionTaken,
        resolutionNote: input.resolutionNote,
        resolvedById: user.userId,
        resolvedAt: new Date(),
      },
      select: FLAG_SELECT,
    });

    // The raiser asked a question and deserves the answer, not silence.
    await this.notifications.notify({
      userIds: [flag.raisedById],
      type: 'flag_raised',
      title: 'A flag you raised has been closed',
      body: `Action taken: ${input.actionTaken.replace(/_/g, ' ')}. ${input.resolutionNote}`,
      entityType: 'Flag',
      entityId: id,
    });

    return resolved;
  }

  private async requireResolvable(id: string, user: AuthenticatedUser) {
    const flag = await this.prisma.db.flag.findFirst({
      where: scopedWhere(flagScope(user, 'flags.resolve'), { id }),
      select: { id: true, status: true, raisedById: true },
    });
    if (!flag) throw new NotFoundProblem('That flag');
    return flag;
  }
}

/**
 * A resolver reads the queue they act on; a Project Lead, who can raise but not
 * resolve, reads the flags on their own project. A trainer holds neither
 * capability and gets a 403 — they are the subject of a flag, not an audience
 * for it, and a concern the person can read before it is acted on is a concern
 * nobody will raise.
 */
function capabilityFor(user: AuthenticatedUser) {
  return can(user.role, 'flags.resolve') ? ('flags.resolve' as const) : ('flags.raise' as const);
}

/**
 * The hops from a flag's current state to closed, as pairs to assert.
 *
 * A flag that is already closed yields the identity move, which the table
 * rejects — that is how "this is already closed" becomes a 409 rather than a
 * silent second closure overwriting the first resolution.
 */
function hopsToClose(status: string): [string, string][] {
  const path = ['raised', 'acknowledged', 'action_taken', 'closed'];
  const start = path.indexOf(status);
  if (start < 0 || status === 'closed') return [[status, 'closed']];
  return path.slice(start, -1).map((from, index) => [from, path[start + index + 1]]);
}
