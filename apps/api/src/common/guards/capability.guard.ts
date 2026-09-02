import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Capability } from '@managedops/shared';
import { CAPABILITY_KEY, IS_PUBLIC_KEY, type AuthenticatedUser } from '../decorators/index.js';
import { ForbiddenProblem, UnauthorizedProblem } from '../errors.js';

/**
 * Layer two of the three-layer model: the route names a capability, and the
 * shared permission matrix decides whether this role holds it. Scope — which
 * rows the caller may see — is layer three and is applied in the data layer.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const capabilities = this.reflector.getAllAndOverride<Capability[] | undefined>(
      CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No capability declared means authentication alone is enough (e.g. /auth/me).
    if (!capabilities?.length) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) throw new UnauthorizedProblem();

    // Any one of the declared capabilities admits the caller; which of them they
    // hold then decides the scope their query runs under, in the data layer.
    if (!capabilities.some((capability) => can(user.role, capability))) {
      throw new ForbiddenProblem(`A ${user.role.replace(/_/g, ' ')} cannot perform this action.`);
    }
    return true;
  }
}
