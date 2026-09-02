import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Role } from '@managedops/shared';
import {
  ALLOW_PASSWORD_CHANGE_KEY,
  IS_PUBLIC_KEY,
  type AuthenticatedUser,
} from '../decorators/index.js';
import { ForbiddenProblem, UnauthorizedProblem } from '../errors.js';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  mcp: boolean;
  tid: string | null;
  lp: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedProblem('Sign in to continue.');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
      });
    } catch {
      throw new UnauthorizedProblem('Your session has expired. Sign in again.');
    }

    const user: AuthenticatedUser = {
      userId: claims.sub,
      email: claims.email,
      role: claims.role,
      mustChangePassword: claims.mcp,
      trainerId: claims.tid ?? null,
      ledProjectIds: claims.lp ?? [],
    };
    request.user = user;

    // A temporary password buys exactly one thing: the ability to replace it.
    if (user.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new ForbiddenProblem('Change your password before using the rest of ManagedOps.');
      }
    }

    return true;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
