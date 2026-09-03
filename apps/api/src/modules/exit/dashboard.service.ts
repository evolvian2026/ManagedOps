import { Injectable } from '@nestjs/common';
import {
  can,
  toIstDateString,
  type ActionItem,
  type DashboardSummary,
  type DashboardTile,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  correctionScope,
  deboardingScope,
  flagScope,
  interviewScope,
  leaveScope,
  positionScope,
  reimbursementScope,
  scopedWhere,
  trainerScope,
} from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

/**
 * What one person sees when they sign in.
 *
 * Every number is counted through the same scope predicate the corresponding
 * list endpoint uses, so a tile can never promise rows the screen behind it
 * will refuse to show — the failure mode where a manager sees "7 pending" and
 * lands on a list of four.
 *
 * The tiles a role gets are derived from the capabilities they hold rather than
 * from their role name, which keeps this in step with the permission matrix
 * without a second copy of it. A trainer's dashboard is deliberately about
 * their own day; an approver's is about what is waiting on them.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: AuthenticatedUser): Promise<DashboardSummary> {
    const [tiles, actions, recent] = await Promise.all([
      this.tiles(user),
      this.actions(user),
      this.recent(user),
    ]);
    return { role: user.role, tiles, actions, recent };
  }

  /* ------------------------------------------------------------------ tiles */

  private async tiles(user: AuthenticatedUser): Promise<DashboardTile[]> {
    const tiles: DashboardTile[] = [];
    const today = new Date(`${toIstDateString(new Date())}T00:00:00.000Z`);
    const tomorrow = new Date(today.getTime() + 86_400_000);

    if (can(user.role, 'positions.read')) {
      tiles.push({
        key: 'open-positions',
        label: 'Open positions',
        value: await this.prisma.db.position.count({
          where: scopedWhere(positionScope(user), { status: 'open', deletedAt: null }),
        }),
        href: '/onboarding',
        tone: 'neutral',
      });
    }

    if (can(user.role, 'interviews.read')) {
      tiles.push({
        key: 'interviews-today',
        label: 'Interviews today',
        value: await this.prisma.db.interview.count({
          where: scopedWhere(interviewScope(user), {
            status: 'scheduled',
            deletedAt: null,
            scheduledAt: { gte: today, lt: tomorrow },
          }),
        }),
        href: '/onboarding',
        tone: 'pending',
      });
    }

    if (can(user.role, 'trainers.read')) {
      tiles.push({
        key: 'active-trainers',
        label: 'Active trainers',
        value: await this.prisma.db.trainer.count({
          where: scopedWhere(trainerScope(user), { status: 'active', deletedAt: null }),
        }),
        href: '/projects',
        tone: 'positive',
      });
    }

    const pending = await this.pendingApprovals(user);
    if (pending !== null) {
      tiles.push({
        key: 'pending-approvals',
        // Not "Waiting on you" — that is the heading of the action queue below,
        // and two different things reading the same is how a tile gets clicked
        // expecting the list underneath it.
        label: 'Approvals waiting',
        value: pending,
        href: '/approvals',
        tone: pending > 0 ? 'pending' : 'neutral',
      });
    }

    if (can(user.role, 'flags.raise')) {
      tiles.push({
        key: 'open-flags',
        label: 'Open flags',
        value: await this.prisma.db.flag.count({
          where: scopedWhere(flagScope(user, capabilityForFlags(user)), {
            status: { in: ['raised', 'acknowledged', 'action_taken'] },
          }),
        }),
        href: '/flags',
        tone: 'critical',
      });
    }

    if (can(user.role, 'deboarding.read')) {
      tiles.push({
        key: 'deboardings',
        label: 'Deboardings in progress',
        value: await this.prisma.db.deboarding.count({
          where: scopedWhere(deboardingScope(user), {
            status: { in: ['initiated', 'assets_pending', 'fnf_pending'] },
          }),
        }),
        href: '/deboarding',
        tone: 'neutral',
      });
    }

    // A trainer's dashboard is about their own working life, not a queue.
    if (user.trainerId && can(user.role, 'attendance.punch')) {
      const [assignments, openDays] = await Promise.all([
        this.prisma.db.assignment.count({
          where: { trainerId: user.trainerId, status: 'active' },
        }),
        this.prisma.db.attendanceRecord.count({
          where: {
            assignment: { trainerId: user.trainerId },
            status: { in: ['missing_punch_out', 'correction_pending'] },
          },
        }),
      ]);
      tiles.push(
        {
          key: 'my-assignments',
          label: 'My assignments',
          value: assignments,
          href: '/my/work',
          tone: 'neutral',
        },
        {
          key: 'my-open-days',
          label: 'Days needing attention',
          value: openDays,
          href: '/my/work',
          tone: openDays > 0 ? 'critical' : 'positive',
        },
      );
    }

    return tiles;
  }

  /**
   * How many decisions are sitting with this person, counted only across the
   * queues they can actually act on. Null when they approve nothing at all, so
   * the tile is absent rather than reading a permanent zero.
   */
  private async pendingApprovals(user: AuthenticatedUser): Promise<number | null> {
    const counts: Promise<number>[] = [];

    if (can(user.role, 'attendance.corrections.approve')) {
      counts.push(
        this.prisma.db.attendanceCorrection.count({
          where: scopedWhere(correctionScope(user), { status: 'pending' }),
        }),
      );
    }
    if (can(user.role, 'leave.approve')) {
      counts.push(
        this.prisma.db.leaveRequest.count({
          where: scopedWhere(leaveScope(user, 'leave.approve'), {
            status: { in: ['submitted', 'escalated'] },
          }),
        }),
      );
    }
    if (can(user.role, 'reimbursements.approve')) {
      counts.push(
        this.prisma.db.reimbursement.count({
          where: scopedWhere(reimbursementScope(user, 'reimbursements.approve'), {
            status: { in: ['submitted', 'under_review'] },
          }),
        }),
      );
    }

    if (counts.length === 0) return null;
    return (await Promise.all(counts)).reduce((total, count) => total + count, 0);
  }

  /* ---------------------------------------------------------------- actions */

  /**
   * The specific items waiting on this user, not just how many. A count tells
   * somebody there is work; a list tells them what it is, which is the
   * difference between a dashboard and a scoreboard.
   */
  private async actions(user: AuthenticatedUser): Promise<ActionItem[]> {
    const actions: ActionItem[] = [];

    if (can(user.role, 'leave.approve')) {
      const leave = await this.prisma.db.leaveRequest.findMany({
        where: scopedWhere(leaveScope(user, 'leave.approve'), {
          status: { in: ['submitted', 'escalated'] },
        }),
        orderBy: { createdAt: 'asc' },
        take: 5,
        select: {
          id: true,
          startDate: true,
          endDate: true,
          status: true,
          createdAt: true,
          assignment: { select: { trainer: { select: { user: { select: { name: true } } } } } },
        },
      });
      for (const request of leave) {
        actions.push({
          id: request.id,
          kind: 'leave',
          title: `${request.assignment.trainer.user.name} has requested leave`,
          detail:
            `${toIstDateString(request.startDate)} to ${toIstDateString(request.endDate)}` +
            (request.status === 'escalated' ? ' — escalated to you' : ''),
          href: '/approvals',
          since: request.createdAt.toISOString(),
        });
      }
    }

    if (can(user.role, 'attendance.corrections.approve')) {
      const corrections = await this.prisma.db.attendanceCorrection.findMany({
        where: scopedWhere(correctionScope(user), { status: 'pending' }),
        orderBy: { createdAt: 'asc' },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          requestedBy: { select: { name: true } },
          attendanceRecord: { select: { workDate: true } },
        },
      });
      for (const correction of corrections) {
        actions.push({
          id: correction.id,
          kind: 'correction',
          title: `${correction.requestedBy.name} asked for a day to be corrected`,
          detail: toIstDateString(correction.attendanceRecord.workDate),
          href: '/approvals',
          since: correction.createdAt.toISOString(),
        });
      }
    }

    if (can(user.role, 'reimbursements.approve')) {
      const claims = await this.prisma.db.reimbursement.findMany({
        where: scopedWhere(reimbursementScope(user, 'reimbursements.approve'), {
          status: { in: ['submitted', 'under_review'] },
        }),
        orderBy: { createdAt: 'asc' },
        take: 5,
        select: {
          id: true,
          amount: true,
          createdAt: true,
          trainer: { select: { user: { select: { name: true } } } },
        },
      });
      for (const claim of claims) {
        actions.push({
          id: claim.id,
          kind: 'claim',
          title: `${claim.trainer.user.name} submitted a claim`,
          detail: `₹${Number(claim.amount).toLocaleString('en-IN')}`,
          href: '/approvals',
          since: claim.createdAt.toISOString(),
        });
      }
    }

    // A trainer's action queue is their own outstanding work.
    if (user.trainerId) {
      const openDays = await this.prisma.db.attendanceRecord.findMany({
        where: {
          assignment: { trainerId: user.trainerId },
          status: 'missing_punch_out',
        },
        orderBy: { workDate: 'desc' },
        take: 5,
        select: { id: true, workDate: true, updatedAt: true },
      });
      for (const day of openDays) {
        actions.push({
          id: day.id,
          kind: 'attendance',
          title: 'A day was left without a punch-out',
          detail: `${toIstDateString(day.workDate)} — ask for it to be corrected`,
          href: '/my/work',
          since: day.updatedAt.toISOString(),
        });
      }

      const rejected = await this.prisma.db.trainerDocument.findMany({
        where: { trainerId: user.trainerId, status: 'rejected' },
        take: 5,
        select: { id: true, docType: true, rejectReason: true, updatedAt: true },
      });
      for (const document of rejected) {
        actions.push({
          id: document.id,
          kind: 'document',
          title: `Your ${document.docType.replace(/_/g, ' ')} was rejected`,
          detail: document.rejectReason ?? 'Upload a replacement.',
          href: '/my/profile',
          since: document.updatedAt.toISOString(),
        });
      }
    }

    // Oldest first: the thing that has been waiting longest is the thing to do.
    return actions.sort((left, right) => left.since.localeCompare(right.since)).slice(0, 10);
  }

  /* ----------------------------------------------------------------- recent */

  private async recent(user: AuthenticatedUser) {
    // Only somebody who may read the audit log sees the activity feed; for
    // everybody else an empty list is the honest answer, not a filtered one.
    if (!can(user.role, 'audit.read')) return [];

    const rows = await this.prisma.db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        action: true,
        entityType: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      actor: row.actor?.name ?? null,
      at: row.createdAt.toISOString(),
    }));
  }
}

/** A lead reads the flags they can raise; a resolver reads the queue. */
function capabilityForFlags(user: AuthenticatedUser) {
  return can(user.role, 'flags.resolve') ? ('flags.resolve' as const) : ('flags.raise' as const);
}
