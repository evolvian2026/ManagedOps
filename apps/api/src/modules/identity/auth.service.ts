import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LOGIN_LOCKOUT_MINUTES,
  LOGIN_MAX_ATTEMPTS,
  capabilitiesFor,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import {
  NotFoundProblem,
  RateLimitProblem,
  UnauthorizedProblem,
  ValidationProblem,
} from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../notifications/mail.service.js';
import { PasswordService } from './password.service.js';
import { TokenService, type IssuedTokens } from './token.service.js';

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser & { capabilities: string[] };
}

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async login(
    input: LoginInput,
    meta: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    const user = await this.prisma.db.user.findUnique({
      where: { email: input.email },
      include: { trainer: { select: { id: true } }, ledProjects: { select: { id: true } } },
    });

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new RateLimitProblem(
        `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    // Verify against a dummy hash when the account does not exist, so a missing
    // account and a wrong password cost the same time and return the same error.
    const passwordMatches = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.consumeTimingBudget(input.password);

    if (!user || !passwordMatches) {
      if (user) await this.recordFailedAttempt(user.id, user.failedLoginCount);
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: user?.id ?? null,
        after: { email: input.email },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedProblem('That email and password do not match an account.');
    }

    if (user.status === 'disabled') {
      throw new UnauthorizedProblem('This account has been disabled. Contact an administrator.');
    }

    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const subject = {
      id: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      trainerId: user.trainer?.id ?? null,
      ledProjectIds: user.ledProjects.map((project) => project.id),
    };
    const issued = await this.tokens.issue(subject, meta);

    await this.audit.record({
      actorUserId: user.id,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSession(issued, user, subject.ledProjectIds, subject.trainerId);
  }

  async refresh(
    presented: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    const { tokens, subject } = await this.tokens.rotate(presented, meta);
    const user = await this.requireUser(subject.id);
    return this.toSession(tokens, user, subject.ledProjectIds, subject.trainerId);
  }

  async logout(presented: string | undefined): Promise<void> {
    if (presented) await this.tokens.revoke(presented);
  }

  async me(userId: string): Promise<AuthUser & { capabilities: string[] }> {
    const subject = await this.tokens.loadSubject(userId);
    const user = await this.requireUser(userId);
    return this.toAuthUser(user, subject.ledProjectIds, subject.trainerId);
  }

  /**
   * Changing a password revokes every other session, then issues a fresh pair
   * for this one — so retiring a temporary password signs out anywhere it may
   * already have been used, without logging the legitimate user out mid-flow.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    meta: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    const user = await this.requireUser(userId);

    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new ValidationProblem('Your current password is not correct.', [
        { path: 'currentPassword', message: 'does not match your current password' },
      ]);
    }

    await this.prisma.db.user.update({
      where: { id: userId },
      data: {
        passwordHash: await this.passwords.hash(input.newPassword),
        mustChangePassword: false,
      },
    });
    await this.tokens.revokeAllForUser(userId);

    const subject = await this.tokens.loadSubject(userId);
    const issued = await this.tokens.issue(subject, meta);
    const refreshed = await this.requireUser(userId);

    await this.audit.record({
      actorUserId: userId,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.toSession(issued, refreshed, subject.ledProjectIds, subject.trainerId);
  }

  /**
   * Always reports success. Confirming whether an address has an account would
   * turn this endpoint into an account-enumeration oracle.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.db.user.findUnique({ where: { email } });
    if (!user || user.status === 'disabled') return;

    const token = randomBytes(32).toString('hex');
    await this.prisma.db.passwordReset.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');
    await this.mail.send({
      to: user.email,
      subject: 'Reset your ManagedOps password',
      text:
        `Hello ${user.name},\n\n` +
        `Open this link to choose a new password. It expires in one hour.\n\n` +
        `${webBaseUrl}/reset-password?token=${token}\n\n` +
        `If you did not ask for this, you can ignore this email.\n`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const reset = await this.prisma.db.passwordReset.findUnique({ where: { tokenHash } });

    if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) {
      throw new ValidationProblem('This reset link has expired or has already been used.', [
        { path: 'token', message: 'no longer valid' },
      ]);
    }

    await this.prisma.db.$transaction([
      this.prisma.db.user.update({
        where: { id: reset.userId },
        data: {
          passwordHash: await this.passwords.hash(newPassword),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.db.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
    ]);
    await this.tokens.revokeAllForUser(reset.userId);

    await this.audit.record({
      actorUserId: reset.userId,
      action: 'PASSWORD_RESET',
      entityType: 'User',
      entityId: reset.userId,
    });
  }

  private async recordFailedAttempt(userId: string, currentCount: number): Promise<void> {
    const attempts = currentCount + 1;
    const locked = attempts >= LOGIN_MAX_ATTEMPTS;
    await this.prisma.db.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: locked ? 0 : attempts,
        lockedUntil: locked ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    if (locked) this.logger.warn({ userId }, 'Account locked after repeated failed sign-ins');
  }

  /** Burns roughly the same time a real verification would, to flatten timing. */
  private async consumeTimingBudget(candidate: string): Promise<false> {
    const decoy = await this.passwords.hash(candidate);
    const a = Buffer.from(decoy);
    timingSafeEqual(a, a);
    return false;
  }

  private async requireUser(userId: string) {
    const user = await this.prisma.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundProblem('That account');
    return user;
  }

  private toSession(
    issued: IssuedTokens,
    user: {
      id: string;
      name: string;
      email: string;
      role: AuthUser['role'];
      status: string;
      mustChangePassword: boolean;
    },
    ledProjectIds: string[],
    trainerId: string | null,
  ): SessionResult {
    return {
      ...issued,
      user: this.toAuthUser(user, ledProjectIds, trainerId),
    };
  }

  private toAuthUser(
    user: {
      id: string;
      name: string;
      email: string;
      role: AuthUser['role'];
      status: string;
      mustChangePassword: boolean;
    },
    ledProjectIds: string[],
    trainerId: string | null,
  ): AuthUser & { capabilities: string[] } {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      trainerId,
      ledProjectIds,
      capabilities: capabilitiesFor(user.role),
    };
  }
}
