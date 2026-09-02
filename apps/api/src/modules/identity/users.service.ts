import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ROLES, emailSchema, paginationSchema, phoneSchema, type Role } from '@managedops/shared';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { MailService } from '../notifications/mail.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

export const userQuerySchema = paginationSchema
  .extend({
    role: z.enum(ROLES).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();
export type UserQuery = z.infer<typeof userQuerySchema>;

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter their full name').max(120),
    email: emailSchema,
    phone: phoneSchema.optional(),
    // Trainer accounts are created by converting an accepted offer, not here,
    // so that a trainer always has a profile behind their login.
    role: z.enum(ROLES).refine((role) => role !== 'trainer', {
      message: 'Create a trainer by converting an accepted offer',
    }),
  })
  .strict();
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: phoneSchema.optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict();
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

const SORTABLE = ['createdAt', 'name', 'email', 'role', 'lastLoginAt'] as const;

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async list(query: UserQuery) {
    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' as const } },
              { email: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const page = toPrismaPage(query, SORTABLE);
    const [data, total] = await Promise.all([
      this.prisma.db.user.findMany({ where, ...page, select: PUBLIC_FIELDS }),
      this.prisma.db.user.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  async get(id: string) {
    const user = await this.prisma.db.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!user) throw new NotFoundProblem('That account');
    return user;
  }

  /**
   * Creates an administrative account and emails a temporary password to it.
   * The password is returned to nobody — not the caller, not the logs — so the
   * mailbox is the only place it exists.
   */
  async create(input: CreateUserInput, actorId: string) {
    const existing = await this.prisma.raw.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ValidationProblem(`${input.email} already has an account.`, [
        { path: 'email', message: 'already in use' },
      ]);
    }

    const temporaryPassword = this.passwords.generateTemporary();
    const user = await this.prisma.db.user.create({
      data: {
        id: newId(),
        name: input.name,
        email: input.email,
        phone: input.phone,
        role: input.role,
        passwordHash: await this.passwords.hash(temporaryPassword),
        mustChangePassword: true,
        createdById: actorId,
      },
      select: PUBLIC_FIELDS,
    });

    await this.sendCredentials(user.email, user.name, temporaryPassword);
    return user;
  }

  async update(id: string, input: UpdateUserInput, actorId: string) {
    const user = await this.get(id);

    // Demoting the last super admin would lock everyone out of user management.
    if (input.role && input.role !== user.role && user.role === 'super_admin') {
      await this.assertNotLastSuperAdmin(id);
    }
    if (input.role === 'trainer') {
      throw new ValidationProblem('A trainer account is created by converting an accepted offer.', [
        { path: 'role', message: 'cannot be set to trainer here' },
      ]);
    }

    const updated = await this.prisma.db.user.update({
      where: { id },
      data: { ...input, updatedById: actorId },
      select: PUBLIC_FIELDS,
    });

    // A role change alters every capability, so existing sessions must not survive it.
    if (input.role && input.role !== user.role) await this.tokens.revokeAllForUser(id);
    return updated;
  }

  async disable(id: string, actorId: string) {
    const user = await this.get(id);
    if (user.status === 'disabled') return user;
    if (user.role === 'super_admin') await this.assertNotLastSuperAdmin(id);

    const updated = await this.prisma.db.user.update({
      where: { id },
      data: { status: 'disabled', updatedById: actorId },
      select: PUBLIC_FIELDS,
    });
    await this.tokens.revokeAllForUser(id);
    return updated;
  }

  async enable(id: string, actorId: string) {
    await this.get(id);
    return this.prisma.db.user.update({
      where: { id },
      data: { status: 'active', failedLoginCount: 0, lockedUntil: null, updatedById: actorId },
      select: PUBLIC_FIELDS,
    });
  }

  /** Issues a fresh temporary password and forces a change at next sign-in. */
  async resetPassword(id: string, actorId: string) {
    const user = await this.get(id);
    const temporaryPassword = this.passwords.generateTemporary();

    await this.prisma.db.user.update({
      where: { id },
      data: {
        passwordHash: await this.passwords.hash(temporaryPassword),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedById: actorId,
      },
    });
    await this.tokens.revokeAllForUser(id);
    await this.sendCredentials(user.email, user.name, temporaryPassword);

    return { id, message: 'A temporary password has been emailed to them.' };
  }

  private async assertNotLastSuperAdmin(id: string): Promise<void> {
    const others = await this.prisma.db.user.count({
      where: { role: 'super_admin', status: 'active', id: { not: id } },
    });
    if (others === 0) {
      throw new DomainRuleProblem(
        'last-super-admin',
        'This is the only active super admin. Promote another account first.',
      );
    }
  }

  private async sendCredentials(email: string, name: string, temporaryPassword: string) {
    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');
    await this.mail.send({
      to: email,
      subject: 'Your ManagedOps account',
      text:
        `Hello ${name},\n\n` +
        `An account has been created for you on ManagedOps.\n\n` +
        `Sign in at: ${webBaseUrl}\n` +
        `Email: ${email}\n` +
        `Temporary password: ${temporaryPassword}\n\n` +
        `You will be asked to choose your own password the first time you sign in.\n`,
    });
  }
}
