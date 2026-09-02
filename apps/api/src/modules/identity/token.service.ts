import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { UnauthorizedProblem } from '../../common/errors.js';
import type { AccessTokenClaims } from '../../common/guards/jwt-auth.guard.js';

export interface TokenSubject {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  trainerId: string | null;
  ledProjectIds: string[];
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Refresh tokens are opaque and stored hashed — the database never holds one. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async issue(
    subject: TokenSubject,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<IssuedTokens> {
    const claims: AccessTokenClaims = {
      sub: subject.id,
      email: subject.email,
      role: subject.role,
      mcp: subject.mustChangePassword,
      tid: subject.trainerId,
      lp: subject.ledProjectIds,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      expiresIn: this.config.getOrThrow<string>('jwt.accessTtl'),
    });

    const refreshToken = randomBytes(48).toString('hex');
    const ttlDays = this.config.getOrThrow<number>('jwt.refreshTtlDays');
    await this.prisma.db.refreshToken.create({
      data: {
        id: newId(),
        userId: subject.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds() };
  }

  /**
   * Rotates a refresh token, with reuse detection.
   *
   * Presenting a token that was already rotated means it leaked — the holder is
   * replaying a token the legitimate client has moved past. Every live token for
   * that user is revoked, forcing a fresh sign-in on both the attacker and the
   * victim, which is the correct outcome when we cannot tell them apart.
   */
  async rotate(
    presented: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<{ tokens: IssuedTokens; subject: TokenSubject }> {
    const tokenHash = hashToken(presented);
    const existing = await this.prisma.db.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) throw new UnauthorizedProblem('Your session is no longer valid. Sign in again.');

    if (existing.revokedAt) {
      await this.revokeAllForUser(existing.userId);
      throw new UnauthorizedProblem(
        'This session was already replaced. For safety every session has been signed out.',
      );
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedProblem('Your session has expired. Sign in again.');
    }

    const subject = await this.loadSubject(existing.userId);
    const tokens = await this.issue(subject, meta);

    await this.prisma.db.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: hashToken(tokens.refreshToken) },
    });

    return { tokens, subject };
  }

  async revoke(presented: string): Promise<void> {
    await this.prisma.db.refreshToken.updateMany({
      where: { tokenHash: hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Loads the claims a token carries. Doing this on every rotation means a role
   * change or a disabled account takes effect within one access-token lifetime.
   */
  async loadSubject(userId: string): Promise<TokenSubject> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, status: 'active' },
      include: {
        trainer: { select: { id: true } },
        ledProjects: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (!user) throw new UnauthorizedProblem('This account is no longer active.');

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      trainerId: user.trainer?.id ?? null,
      ledProjectIds: user.ledProjects.map((project) => project.id),
    };
  }

  accessTtlSeconds(): number {
    const ttl = this.config.getOrThrow<string>('jwt.accessTtl');
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 900;
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return Number(match[1]) * (multipliers[match[2] as string] ?? 60);
  }

  refreshTtlMs(): number {
    return this.config.getOrThrow<number>('jwt.refreshTtlDays') * 24 * 60 * 60 * 1000;
  }
}
