import { scopeFor, type Capability } from '@managedops/shared';
import { ForbiddenProblem } from './errors.js';
import type { AuthenticatedUser } from './decorators/index.js';

/**
 * Layer three of the permission model.
 *
 * A guard has already decided the caller *may* perform this action. This decides
 * *which rows* they may perform it on, by turning their scope into a Prisma
 * `where` predicate. It is deliberately applied in the data layer rather than in
 * each service's own filtering, so a scoped user cannot read outside their scope
 * even if a route were annotated wrongly.
 *
 * The predicates are written per resource rather than generated, because
 * "records this user may see" means something different for each one — and a
 * clever generic version would hide exactly the reasoning that matters here.
 */

/**
 * Combines a caller's scope with the request's own filters.
 *
 * Scope predicates must never be spread into the same object literal as
 * user-supplied filters. Both sides legitimately name the same keys — `id`,
 * `projectId`, `interviewerId` — and in a spread the last one written silently
 * wins, which either drops the caller's scope or drops the record they asked
 * for. Combining under `AND` makes the scope a floor that no filter can raise.
 */
export function scopedWhere<S extends object, F extends object>(
  scope: S,
  filters: F,
): { AND: [S, F] } {
  return { AND: [scope, filters] };
}

/** Matches nothing. Used when a scope resolves to an empty set of rows. */
const MATCH_NOTHING = { id: { in: [] as string[] } };

function requireScope(user: AuthenticatedUser, capability: Capability) {
  const scope = scopeFor(user.role, capability);
  if (!scope) {
    throw new ForbiddenProblem(`A ${user.role.replace(/_/g, ' ')} cannot perform this action.`);
  }
  return scope;
}

/** Projects the caller may see. */
export function projectScope(user: AuthenticatedUser, capability: Capability = 'projects.read') {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'project') {
    return user.ledProjectIds.length > 0 ? { id: { in: user.ledProjectIds } } : MATCH_NOTHING;
  }
  // A trainer reaches their project through their assignment, not directly.
  return { assignments: { some: { trainer: { userId: user.userId } } } };
}

/** Positions the caller may see, filtered through the project that owns them. */
export function positionScope(user: AuthenticatedUser, capability: Capability = 'positions.read') {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { projectId: { in: user.ledProjectIds } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}

/**
 * Candidates the caller may see.
 *
 * An interviewer's 'assigned' scope resolves to the candidates behind the
 * interviews they are personally named on — enough to prepare for and conduct
 * the interview, and nothing else in the pipeline.
 */
export function candidateScope(
  user: AuthenticatedUser,
  capability: Capability = 'candidates.read',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'assigned') {
    return {
      applications: {
        some: { interviews: { some: { interviewerId: user.userId, deletedAt: null } } },
      },
    };
  }
  return MATCH_NOTHING;
}

/** Applications the caller may see, through the position's project. */
export function applicationScope(
  user: AuthenticatedUser,
  capability: Capability = 'candidates.read',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'assigned') {
    return { interviews: { some: { interviewerId: user.userId, deletedAt: null } } };
  }
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { position: { projectId: { in: user.ledProjectIds } } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}

/** Interviews the caller may see. */
export function interviewScope(
  user: AuthenticatedUser,
  capability: Capability = 'interviews.read',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'assigned') return { interviewerId: user.userId };
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { application: { position: { projectId: { in: user.ledProjectIds } } } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}

/** Offers the caller may see. Offers carry salary, so nothing below 'all'. */
export function offerScope(user: AuthenticatedUser, capability: Capability = 'offers.read') {
  const scope = requireScope(user, capability);
  return scope === 'all' ? {} : MATCH_NOTHING;
}

/**
 * Trainers the caller may see.
 *
 * A trainer sees themselves; a project lead sees the people on the project they
 * lead; HR and managers see everyone. Note this is only *which trainers* — a
 * lead seeing a colleague's row still cannot open their salary or documents,
 * because those are separate capabilities they do not hold.
 */
export function trainerScope(user: AuthenticatedUser, capability: Capability = 'trainers.read') {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'own') {
    return user.trainerId ? { id: user.trainerId } : MATCH_NOTHING;
  }
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { assignments: { some: { projectId: { in: user.ledProjectIds } } } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}

/** Assignments the caller may see. */
export function assignmentScope(
  user: AuthenticatedUser,
  capability: Capability = 'assignments.read',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'own') {
    return user.trainerId ? { trainerId: user.trainerId } : MATCH_NOTHING;
  }
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { projectId: { in: user.ledProjectIds } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}
