import { Injectable } from '@nestjs/common';
import {
  can,
  type ClientQuery,
  type CreateClientInput,
  type UpdateClientInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['createdAt', 'name', 'code', 'status'] as const;

/**
 * The rate is deliberately absent from this projection.
 *
 * The client directory is readable by HR, who staff against it; what a client
 * pays is not theirs to see. Withholding the field here rather than filtering
 * it in a controller means a new endpoint cannot leak it by accident.
 */
const LIST_SELECT = {
  id: true,
  name: true,
  code: true,
  status: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  billingAddress: true,
  gstin: true,
  notes: true,
  createdAt: true,
} as const;

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether to include the commercial terms, decided by capability, not by role. */
  private rateSelect(user: AuthenticatedUser) {
    return can(user.role, 'billing.read') ? { defaultDayRate: true } : {};
  }

  async list(query: ClientQuery, user: AuthenticatedUser) {
    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { code: { contains: query.q, mode: 'insensitive' as const } },
              { contactName: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const page = toPrismaPage(query, SORTABLE, { name: 'asc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.client.findMany({
        where,
        ...page,
        select: {
          ...LIST_SELECT,
          ...this.rateSelect(user),
          // Live engagements only: a client whose projects all ended reads as
          // "0 projects", which is the honest answer to "are we working for
          // them", and the history is still on their detail page.
          _count: { select: { projects: { where: { status: 'active', deletedAt: null } } } },
        },
      }),
      this.prisma.db.client.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  async get(id: string, user: AuthenticatedUser) {
    const client = await this.prisma.db.client.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...LIST_SELECT,
        ...this.rateSelect(user),
        projects: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            code: true,
            status: true,
            startDate: true,
            endDate: true,
            _count: { select: { assignments: { where: { status: 'active' } } } },
          },
          orderBy: { startDate: 'desc' },
        },
      },
    });
    if (!client) throw new NotFoundProblem('That client');
    return client;
  }

  async create(input: CreateClientInput, actor: AuthenticatedUser) {
    await this.assertCodeIsFree(input.code);

    return this.prisma.db.client.create({
      data: {
        id: newId(),
        name: input.name,
        code: input.code,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        billingAddress: input.billingAddress,
        gstin: input.gstin,
        defaultDayRate: input.defaultDayRate,
        notes: input.notes,
        createdById: actor.userId,
      },
      select: { ...LIST_SELECT, defaultDayRate: true },
    });
  }

  async update(id: string, input: UpdateClientInput, actor: AuthenticatedUser) {
    const client = await this.prisma.db.client.findFirst({ where: { id, deletedAt: null } });
    if (!client) throw new NotFoundProblem('That client');

    if (input.code !== undefined && input.code !== client.code) {
      await this.assertCodeIsFree(input.code);
    }

    // Deactivating a client we are still delivering for would leave running
    // projects pointing at somebody the directory says we no longer work with.
    if (input.status === 'inactive' && client.status === 'active') {
      const active = await this.prisma.db.project.count({
        where: { clientId: id, status: 'active', deletedAt: null },
      });
      if (active > 0) {
        throw new DomainRuleProblem(
          'client-still-engaged',
          `${client.name} still has ${active} active project${active === 1 ? '' : 's'}. Complete or cancel them before marking the client inactive.`,
        );
      }
    }

    return this.prisma.db.client.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.billingAddress !== undefined ? { billingAddress: input.billingAddress } : {}),
        ...(input.gstin !== undefined ? { gstin: input.gstin } : {}),
        ...(input.defaultDayRate !== undefined ? { defaultDayRate: input.defaultDayRate } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedById: actor.userId,
      },
      select: { ...LIST_SELECT, defaultDayRate: true },
    });
  }

  /**
   * Soft delete, and only for a client nothing points at.
   *
   * The foreign key from `projects` is RESTRICT, so a hard delete would fail at
   * the database anyway. Refusing here means the caller gets a sentence about
   * what to do instead of a constraint violation.
   */
  async remove(id: string, actor: AuthenticatedUser) {
    const client = await this.prisma.db.client.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { projects: true } } },
    });
    if (!client) throw new NotFoundProblem('That client');

    if (client._count.projects > 0) {
      throw new DomainRuleProblem(
        'client-in-use',
        'Projects have been delivered for this client, so its history must be kept. Mark it inactive instead.',
      );
    }

    await this.prisma.db.client.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: actor.userId },
    });
    return { id, deleted: true };
  }

  private async assertCodeIsFree(code: string) {
    // `raw` deliberately: a soft-deleted client still holds the unique index,
    // so checking only live rows would promise a code the database then refuses.
    const existing = await this.prisma.raw.client.findUnique({ where: { code } });
    if (existing) {
      throw new ValidationProblem(`Client code ${code} is already in use.`, [
        { path: 'code', message: 'already in use' },
      ]);
    }
  }
}
