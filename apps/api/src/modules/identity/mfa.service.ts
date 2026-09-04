import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { toDataURL } from 'qrcode';
import {
  MFA_CHALLENGE_TTL_MINUTES,
  MFA_MAX_ATTEMPTS,
  MFA_RECOVERY_CODE_COUNT,
  MFA_WINDOW_TOLERANCE,
  looksLikeTotpCode,
  mfaReasonsFor,
  mfaRequiredFor,
  type Role,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { DomainRuleProblem, RateLimitProblem, UnauthorizedProblem } from '../../common/errors.js';
import {
  canonicalRecoveryCode,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCode,
  hashMfaValue as hash,
} from './mfa-crypto.js';

const TOTP_PERIOD_SECONDS = 30;

export interface EnrolmentOffer {
  /** Shown so somebody without a camera can type it in. */
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
}

export interface VerifiedChallenge {
  userId: string;
  /** True when the challenge was issued to make them set up a second factor. */
  enrolling: boolean;
}

/**
 * The second factor.
 *
 * Three things here are worth more than the code that implements them.
 *
 * The secret is *encrypted*, not hashed — a TOTP secret has to come back out to
 * verify a code, so a one-way function is not an option. The key lives in the
 * environment, which means a stolen database alone cannot produce codes.
 *
 * A code that has been accepted cannot be accepted again. Without that, a
 * six-digit code read over somebody's shoulder is good for the rest of its
 * thirty-second window, which is exactly long enough for the person who read it.
 *
 * And a challenge is not a session. It carries nothing but the right to present
 * a second factor, so the window between a correct password and a real session
 * opens nothing.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether this role must hold a second factor *here*.
   *
   * Two separate questions, deliberately kept apart: the matrix decides which
   * roles are sensitive enough to need one, and the deployment decides whether
   * enrolment is forced. Turning enforcement down never turns verification off
   * for somebody already enrolled.
   */
  private key(): string {
    return this.config.getOrThrow<string>('mfa.secretKey');
  }

  requiredFor(role: Role): boolean {
    if (this.config.getOrThrow<string>('mfa.enforcement') !== 'required') return false;
    return mfaRequiredFor(role);
  }

  /** What the matrix says, regardless of what this deployment enforces. */
  sensitiveRole(role: Role): boolean {
    return mfaRequiredFor(role);
  }

  /** What the security section on a profile needs to render itself. */
  async statusFor(userId: string, role: Role) {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaEnrolledAt: true },
    });
    return {
      enrolled: user.mfaEnrolledAt !== null,
      enrolledAt: user.mfaEnrolledAt,
      required: this.requiredFor(role),
      sensitive: this.sensitiveRole(role),
      reasons: mfaReasonsFor(role),
      recoveryCodesRemaining: user.mfaEnrolledAt ? await this.recoveryCodesRemaining(userId) : 0,
    };
  }

  /* ------------------------------------------------------------- enrolment */

  /**
   * A fresh secret, stored but not yet active.
   *
   * Overwrites any half-finished enrolment: somebody who scanned a code, lost
   * the phone and came back needs to start again, and the abandoned secret was
   * never a second factor because `mfaEnrolledAt` was never set.
   */
  async beginEnrolment(userId: string): Promise<EnrolmentOffer> {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, mfaEnrolledAt: true },
    });

    if (user.mfaEnrolledAt) {
      throw new DomainRuleProblem(
        'mfa-already-enrolled',
        'You already have an authenticator set up. Remove it before adding another.',
      );
    }

    const secret = generateSecret();
    await this.prisma.db.user.update({
      where: { id: userId },
      data: { mfaSecret: encryptMfaSecret(secret, this.key()), mfaLastUsedStep: null },
    });

    const otpauthUri = generateURI({ issuer: 'ManagedOps', label: user.email, secret });
    return { secret, otpauthUri, qrDataUri: await toDataURL(otpauthUri, { margin: 1 }) };
  }

  /**
   * Proves the authenticator works, and only then counts as enrolled.
   *
   * The recovery codes are returned here and never again — they exist for the
   * lost phone, and a set that could be re-read from the app would be no better
   * than a second password sitting in the session.
   */
  async completeEnrolment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnrolledAt: true },
    });

    if (user.mfaEnrolledAt) {
      throw new DomainRuleProblem('mfa-already-enrolled', 'An authenticator is already set up.');
    }
    if (!user.mfaSecret) {
      throw new DomainRuleProblem('mfa-not-started', 'Start the setup again to get a new code.');
    }

    const step = await this.verifyCode(decryptMfaSecret(user.mfaSecret, this.key()), code);
    if (step === null) {
      throw new UnauthorizedProblem('That code is not right. Check your authenticator and retry.');
    }

    const recoveryCodes = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );

    await this.prisma.db.$transaction([
      this.prisma.db.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.db.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((value) => ({
          id: newId(),
          userId,
          // Hashed in canonical form. The dash is there so somebody can read
          // the code off a piece of paper; whether they type it back is not
          // something the stored value should care about.
          codeHash: hash(canonicalRecoveryCode(value)),
        })),
      }),
      this.prisma.db.user.update({
        where: { id: userId },
        data: { mfaEnrolledAt: new Date(), mfaLastUsedStep: BigInt(step) },
      }),
    ]);

    return { recoveryCodes };
  }

  /**
   * Turning it off. Refused outright for a role that has to hold one — the
   * matrix decides that, not the person.
   */
  async disable(userId: string, role: Role, code: string): Promise<void> {
    if (this.requiredFor(role)) {
      throw new DomainRuleProblem(
        'mfa-required-for-role',
        'Your role requires an authenticator. It cannot be removed while you hold it.',
      );
    }
    await this.assertCodeAccepted(userId, code);
    await this.clear(userId);
  }

  /** For somebody who has lost their phone. The caller decides who may do this. */
  async reset(userId: string): Promise<void> {
    await this.clear(userId);
  }

  private async clear(userId: string): Promise<void> {
    await this.prisma.db.$transaction([
      this.prisma.db.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.db.mfaChallenge.deleteMany({ where: { userId } }),
      this.prisma.db.user.update({
        where: { id: userId },
        data: { mfaSecret: null, mfaEnrolledAt: null, mfaLastUsedStep: null },
      }),
    ]);
  }

  /* ------------------------------------------------------------ challenges */

  /**
   * Issued once the password is right and before any session exists.
   *
   * Any earlier challenge for the same person is dropped, so a stack of them
   * cannot be built up and worked through at leisure.
   */
  async issueChallenge(userId: string, enrolling: boolean): Promise<{ token: string }> {
    const token = randomBytes(32).toString('hex');
    await this.prisma.db.$transaction([
      this.prisma.db.mfaChallenge.deleteMany({ where: { userId, consumedAt: null } }),
      this.prisma.db.mfaChallenge.create({
        data: {
          id: newId(),
          userId,
          tokenHash: hash(token),
          enrolling,
          expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60_000),
        },
      }),
    ]);
    return { token };
  }

  /**
   * A challenge that has not expired, been used or been guessed at too often.
   *
   * Used by the enrol step, which needs to know who is asking without consuming
   * the challenge — they still have to prove the authenticator works afterwards.
   */
  async openChallenge(token: string): Promise<VerifiedChallenge> {
    const challenge = await this.prisma.db.mfaChallenge.findUnique({
      where: { tokenHash: hash(token) },
      select: {
        id: true,
        userId: true,
        enrolling: true,
        expiresAt: true,
        consumedAt: true,
        attempts: true,
      },
    });

    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedProblem('That sign-in has expired. Enter your password again.');
    }
    if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
      throw new RateLimitProblem('Too many attempts. Enter your password again to start over.');
    }
    return { userId: challenge.userId, enrolling: challenge.enrolling };
  }

  /**
   * Spends a challenge against a code.
   *
   * A wrong code counts against the challenge rather than against the account:
   * locking the account would let anybody with a leaked password lock out the
   * person who owns it, which is a denial of service dressed as a control.
   */
  async consumeChallenge(token: string, code: string): Promise<string> {
    const challenge = await this.prisma.db.mfaChallenge.findUnique({
      where: { tokenHash: hash(token) },
      select: {
        id: true,
        userId: true,
        enrolling: true,
        expiresAt: true,
        consumedAt: true,
        attempts: true,
      },
    });

    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedProblem('That sign-in has expired. Enter your password again.');
    }
    if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
      throw new RateLimitProblem('Too many attempts. Enter your password again to start over.');
    }

    try {
      await this.assertCodeAccepted(challenge.userId, code);
    } catch (error) {
      await this.prisma.db.mfaChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw error;
    }

    await this.prisma.db.mfaChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    return challenge.userId;
  }

  /**
   * Spends a challenge that has already been proved another way.
   *
   * Enrolment verifies a code against the brand-new secret rather than against
   * an enrolled one, so it cannot go through `consumeChallenge` — but the
   * challenge still has to be spent, or it would remain a second way in.
   */
  async consumeChallengeWithoutCode(token: string): Promise<void> {
    await this.prisma.db.mfaChallenge.updateMany({
      where: { tokenHash: hash(token), consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /* ------------------------------------------------------------ the codes */

  /**
   * Accepts a code from the authenticator, or one of the recovery codes.
   *
   * Whichever it is, it is spent: a TOTP code by recording its time step, a
   * recovery code by marking it used. Throws on anything else.
   */
  async assertCodeAccepted(userId: string, code: string): Promise<void> {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnrolledAt: true, mfaLastUsedStep: true },
    });

    if (!user.mfaEnrolledAt || !user.mfaSecret) {
      throw new DomainRuleProblem('mfa-not-enrolled', 'This account has no authenticator set up.');
    }

    if (looksLikeTotpCode(code)) {
      const step = await this.verifyCode(decryptMfaSecret(user.mfaSecret, this.key()), code);
      if (step === null) throw new UnauthorizedProblem('That code is not right.');

      // Replay: the same code, inside its own window, from anybody who saw it.
      if (user.mfaLastUsedStep !== null && BigInt(step) <= user.mfaLastUsedStep) {
        throw new UnauthorizedProblem('That code has already been used. Wait for the next one.');
      }

      await this.prisma.db.user.update({
        where: { id: userId },
        data: { mfaLastUsedStep: BigInt(step) },
      });
      return;
    }

    const used = await this.prisma.db.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: hash(canonicalRecoveryCode(code)), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count === 0) throw new UnauthorizedProblem('That code is not right.');

    this.logger.warn({ userId }, 'A recovery code was used to sign in');
  }

  async recoveryCodesRemaining(userId: string): Promise<number> {
    return this.prisma.db.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  /**
   * The time step a code belongs to, or null.
   *
   * otplib reports how many windows away the match was; turning that back into
   * an absolute step is what makes replay detectable, because "the last code I
   * accepted" has to mean the same thing on the next request.
   */
  private async verifyCode(secret: string, code: string): Promise<number | null> {
    const result = await verifyTotp({
      secret,
      token: code,
      epochTolerance: MFA_WINDOW_TOLERANCE * TOTP_PERIOD_SECONDS,
    });
    if (!result.valid) return null;
    const now = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
    return now + ('delta' in result ? (result.delta ?? 0) : 0);
  }
}

/** Exported so a test can prove a stored code is a hash and not the code. */
export function hashRecoveryCode(value: string): string {
  return hash(canonicalRecoveryCode(value));
}
