import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { RateLimitProblem } from '../errors.js';

/**
 * How many requests one address may make, and what happens when it makes more.
 *
 * Two layers, because the two threats are different shapes. The wide limit is a
 * flood ceiling that ordinary use never approaches — it exists so one runaway
 * client cannot saturate the API for everybody else. The narrow one guards the
 * ways in, where each attempt costs an Argon2 hash: an unthrottled sign-in
 * endpoint is a CPU exhaustion vector quite apart from being a guessing one.
 *
 * Neither is the defence against somebody working on *one* account — that is
 * the per-account lockout in `AuthService`, which counts failures per user and
 * is unaffected by where they come from. These count requests per address, and
 * what they stop is the same address working through many different accounts.
 * Saying that plainly matters, because a limit tight enough to stop a targeted
 * attack would also stop a thirty-person office arriving behind one NAT address
 * at nine in the morning — and an office locked out of its own system is how a
 * security control gets switched off.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    // Off is a deliberate setting, not a default: the test suite signs in
    // hundreds of times a minute from one address, and the limiter has its own
    // suite that boots a second application with tight values.
    if (!this.config.get<boolean>('rateLimit.enabled')) return true;
    return super.shouldSkip(context);
  }

  /**
   * The client address, taken from Express, which resolves it through
   * `trust proxy` — so behind Caddy this is the real caller and not the
   * proxy, which would put the whole internet in one bucket.
   */
  protected override async getTracker(request: Request): Promise<string> {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }

  /**
   * One bucket per address per limit, rather than per route.
   *
   * The framework's default keys on the handler as well, which would give an
   * attacker the whole budget again for every endpoint they touched. What is
   * being limited here is a caller, not a URL.
   */
  protected override generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return `${name}:${suffix}`;
  }

  /**
   * Refused the same way as everything else: a Problem Details document with a
   * type a client can branch on, plus `Retry-After` so a well-behaved one knows
   * when to come back rather than hammering until it is let through.
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: { timeToBlockExpire: number },
  ): Promise<void> {
    const seconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(seconds));

    throw new RateLimitProblem(
      `Too many requests from this address. Try again in ${seconds} second${
        seconds === 1 ? '' : 's'
      }.`,
    );
  }
}
