import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Capability } from '@managedops/shared';
import type { Role } from '@managedops/shared';

export const IS_PUBLIC_KEY = 'managedops:public';
export const CAPABILITY_KEY = 'managedops:capability';
export const ALLOW_PASSWORD_CHANGE_KEY = 'managedops:allowDuringPasswordChange';
export const AUDIT_ACTION_KEY = 'managedops:auditAction';
export const SKIP_AUDIT_KEY = 'managedops:skipAudit';

/** Reachable without a token — login, refresh, health. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The capability a caller must hold. The guard reads the shared RBAC matrix. */
export const RequireCapability = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, [capability]);

/**
 * Any one of these is enough.
 *
 * A few endpoints legitimately serve two audiences through one URL: the leave
 * list is a queue to an approver and a history to the trainer who filed the
 * requests, and both read the same rows through different scopes. The
 * alternative — a parallel `/mine` route per resource — duplicates the
 * pagination, filtering and serialisation of the endpoint it shadows, and the
 * duplicate is where the scope eventually gets forgotten.
 */
export const RequireAnyCapability = (...capabilities: Capability[]) =>
  SetMetadata(CAPABILITY_KEY, capabilities);

/**
 * A user with `mustChangePassword` is blocked from every route except the few
 * marked here — otherwise a temporary password would be a working session.
 */
export const AllowDuringPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);

/** Names the entity an audited mutation touches, e.g. `Project`. */
export const Audited = (entityType: string) => SetMetadata(AUDIT_ACTION_KEY, entityType);

/**
 * Opts a controller out of the automatic audit interceptor.
 *
 * Only for routes that write their own, richer entries — authentication records
 * LOGIN, LOGIN_FAILED and PASSWORD_CHANGED with the resolved actor, which the
 * generic interceptor cannot do on a public route where nobody is signed in yet.
 * Without this, every sign-in would produce two rows: a good one and an
 * actor-less duplicate.
 */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  trainerId: string | null;
  /** Projects this user leads — the scope predicate for a project_lead. */
  ledProjectIds: string[];
}

export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
