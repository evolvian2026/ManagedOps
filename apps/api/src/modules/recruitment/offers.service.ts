import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertTransition,
  type CreateOfferInput,
  type OfferQuery,
  type RespondToOfferInput,
  type ReviseOfferInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem } from '../../common/errors.js';
import { offerScope, scopedWhere } from '../../common/scope.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PositionsService } from '../projects/positions.service.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { ApplicationsService } from './applications.service.js';

const SORTABLE = ['createdAt', 'version', 'status', 'joiningDate'] as const;

const ROW_SELECT = {
  id: true,
  version: true,
  salaryAnnual: true,
  joiningDate: true,
  status: true,
  sentAt: true,
  respondedAt: true,
  notes: true,
  attachmentFileId: true,
  createdAt: true,
  application: {
    select: {
      id: true,
      status: true,
      candidate: { select: { id: true, name: true, email: true, phone: true } },
      position: {
        select: {
          id: true,
          title: true,
          project: { select: { id: true, name: true, code: true } },
        },
      },
    },
  },
} as const;

/** How a candidate's answer maps onto the offer and the application behind it. */
const RESPONSES = {
  accepted: { offer: 'accepted', application: 'hired' },
  declined: { offer: 'declined', application: 'offer_declined' },
  revision_requested: { offer: 'revision_requested', application: null },
} as const;

@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly positions: PositionsService,
  ) {}

  async list(query: OfferQuery, user: AuthenticatedUser) {
    const where = scopedWhere(offerScope(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.positionId ? { application: { positionId: query.positionId } } : {}),
      ...(query.q
        ? {
            application: {
              candidate: { name: { contains: query.q, mode: 'insensitive' as const } },
            },
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE);
    const [rows, total] = await Promise.all([
      this.prisma.db.offer.findMany({ where, ...page, select: ROW_SELECT }),
      this.prisma.db.offer.count({ where }),
    ]);

    // The board normally wants one row per candidate — the current offer — with
    // superseded versions reachable from it rather than cluttering the list.
    if (query.latestOnly === 'true') {
      const newest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const seen = newest.get(row.application.id);
        if (!seen || row.version > seen.version) newest.set(row.application.id, row);
      }
      const deduped = [...newest.values()];
      return paginate(deduped, deduped.length, query);
    }

    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const offer = await this.prisma.db.offer.findFirst({
      where: scopedWhere(offerScope(user), { id }),
      select: ROW_SELECT,
    });
    if (!offer) throw new NotFoundProblem('That offer');

    // Every earlier version, because "previous records" is just the row set.
    const history = await this.prisma.db.offer.findMany({
      where: { applicationId: offer.application.id },
      select: {
        id: true,
        version: true,
        salaryAnnual: true,
        joiningDate: true,
        status: true,
        sentAt: true,
        respondedAt: true,
        notes: true,
      },
      orderBy: { version: 'desc' },
    });

    return { ...offer, history };
  }

  async create(input: CreateOfferInput, actor: AuthenticatedUser) {
    const application = await this.applications.requireVisible(input.applicationId, actor);

    if (application.status !== 'offer_stage') {
      throw new DomainRuleProblem(
        'not-at-offer-stage',
        `${application.candidate.name} is ${application.status.replace(/_/g, ' ')}. An offer follows a successful interview.`,
      );
    }

    const live = await this.prisma.db.offer.findFirst({
      where: {
        applicationId: input.applicationId,
        status: { in: ['draft', 'sent', 'revision_requested'] },
      },
      select: { id: true, version: true, status: true },
    });
    if (live) {
      throw new DomainRuleProblem(
        'offer-already-open',
        `Version ${live.version} of this offer is ${live.status.replace(/_/g, ' ')}. Revise it rather than starting a second one.`,
      );
    }

    return this.prisma.db.offer.create({
      data: {
        id: newId(),
        applicationId: input.applicationId,
        version: await this.nextVersion(input.applicationId),
        salaryAnnual: new Prisma.Decimal(input.salaryAnnual),
        joiningDate: new Date(input.joiningDate),
        notes: input.notes,
        createdById: actor.userId,
      },
      select: ROW_SELECT,
    });
  }

  /**
   * Marks the offer as sent. The letter itself goes out of band (spec 15.15);
   * ManagedOps records that it went, and optionally stores what was sent.
   */
  async send(id: string, attachmentFileId: string | undefined, actor: AuthenticatedUser) {
    const offer = await this.requireOffer(id);
    assertTransition('offer', offer.status, 'sent');

    if (attachmentFileId) {
      await this.files.requireConfirmed(attachmentFileId);
      await this.files.attach(attachmentFileId, 'Offer', id);
    }

    const updated = await this.prisma.db.offer.update({
      where: { id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        attachmentFileId,
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });

    await this.notifications.notify({
      userIds: [],
      type: 'offer_sent',
      title: 'Offer sent',
      body: `${updated.application.candidate.name} — ${updated.application.position.title}`,
      entityType: 'Offer',
      entityId: id,
      email: {
        to: updated.application.candidate.email,
        subject: `Your offer for ${updated.application.position.title}`,
        text:
          `Hello ${updated.application.candidate.name},\n\n` +
          `We are delighted to offer you the ${updated.application.position.title} role on ${updated.application.position.project.name}.\n\n` +
          `Proposed joining date: ${updated.joiningDate.toISOString().slice(0, 10)}\n\n` +
          `Please reply to confirm whether you accept.\n`,
      },
    });

    return updated;
  }

  /**
   * Records the candidate's answer. Accepting hires them, which also counts
   * against the position's headcount; declining returns them to the pool.
   */
  async respond(id: string, input: RespondToOfferInput, actor: AuthenticatedUser) {
    const offer = await this.requireOffer(id);
    const route = RESPONSES[input.response];

    assertTransition('offer', offer.status, route.offer);

    const updated = await this.prisma.db.offer.update({
      where: { id },
      data: {
        status: route.offer,
        respondedAt: input.respondedAt ?? new Date(),
        notes: input.notes ?? offer.notes,
        updatedById: actor.userId,
      },
      select: ROW_SELECT,
    });

    if (route.application) {
      await this.applications.advance(offer.applicationId, route.application, actor, {
        ...(input.response === 'declined'
          ? { rejectionReason: input.notes ?? 'Declined the offer' }
          : {}),
      });
    }

    // An acceptance consumes one of the position's seats, and fills the
    // requisition once the last one goes.
    if (input.response === 'accepted') {
      await this.positions.recordHire(updated.application.position.id);
    }

    return updated;
  }

  /**
   * A revision is a new row at version + 1, never an edit of the old one. The
   * superseded version keeps its own status and dates, which is what makes the
   * negotiation legible afterwards.
   */
  async revise(id: string, input: ReviseOfferInput, actor: AuthenticatedUser) {
    const offer = await this.requireOffer(id);

    if (offer.status === 'accepted' || offer.status === 'withdrawn') {
      throw new DomainRuleProblem(
        'offer-closed',
        `This offer is ${offer.status} and cannot be revised.`,
      );
    }

    const version = await this.nextVersion(offer.applicationId);
    const [, revision] = await this.prisma.db.$transaction([
      // Supersede the old version if it is still open.
      this.prisma.db.offer.update({
        where: { id },
        data:
          offer.status === 'sent'
            ? { status: 'revision_requested', updatedById: actor.userId }
            : { status: 'withdrawn', updatedById: actor.userId },
      }),
      this.prisma.db.offer.create({
        data: {
          id: newId(),
          applicationId: offer.applicationId,
          version,
          salaryAnnual: new Prisma.Decimal(input.salaryAnnual),
          joiningDate: new Date(input.joiningDate),
          notes: input.notes,
          createdById: actor.userId,
        },
        select: ROW_SELECT,
      }),
    ]);

    return revision;
  }

  async withdraw(id: string, actor: AuthenticatedUser) {
    const offer = await this.requireOffer(id);
    assertTransition('offer', offer.status, 'withdrawn');

    return this.prisma.db.offer.update({
      where: { id },
      data: { status: 'withdrawn', updatedById: actor.userId },
      select: ROW_SELECT,
    });
  }

  private async requireOffer(id: string) {
    const offer = await this.prisma.db.offer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundProblem('That offer');
    return offer;
  }

  private async nextVersion(applicationId: string): Promise<number> {
    const latest = await this.prisma.db.offer.findFirst({
      where: { applicationId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }
}
