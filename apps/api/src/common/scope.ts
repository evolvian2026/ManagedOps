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

/**
 * Everything below hangs off an assignment: a punch, a leave request, a session
 * in the daily log, a deliverable, an issued laptop, a flag. So they all reuse
 * `assignmentScope` rather than restating "own means my trainer id, project
 * means the projects I lead" seven more times — one definition, seven callers,
 * and no chance of the seventh drifting from the first.
 */
function throughAssignment(user: AuthenticatedUser, capability: Capability) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  return { assignment: assignmentScope(user, capability) };
}

export function attendanceScope(
  user: AuthenticatedUser,
  capability: Capability = 'attendance.read',
) {
  return throughAssignment(user, capability);
}

/**
 * Corrections reach their assignment through the attendance record they amend.
 *
 * The approval capability is what scopes this queue, not the read capability: a
 * project lead approves for their own project, HR and managers for everyone.
 */
export function correctionScope(
  user: AuthenticatedUser,
  capability: Capability = 'attendance.corrections.approve',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  return { attendanceRecord: { assignment: assignmentScope(user, capability) } };
}

export function leaveScope(user: AuthenticatedUser, capability: Capability = 'leave.approve') {
  return throughAssignment(user, capability);
}

export function dailyLogScope(user: AuthenticatedUser, capability: Capability = 'dailylogs.read') {
  return throughAssignment(user, capability);
}

export function deliverableScope(
  user: AuthenticatedUser,
  capability: Capability = 'deliverables.read',
) {
  return throughAssignment(user, capability);
}

export function assetIssueScope(user: AuthenticatedUser, capability: Capability = 'assets.read') {
  return throughAssignment(user, capability);
}

export function flagScope(user: AuthenticatedUser, capability: Capability = 'flags.resolve') {
  return throughAssignment(user, capability);
}

/**
 * Reimbursements name a trainer directly and an assignment only optionally — a
 * claim can outlive the assignment it was incurred on. Scoping through the
 * trainer keeps a claim visible to its owner after their project ends, which
 * scoping through the assignment would not.
 */
export function reimbursementScope(
  user: AuthenticatedUser,
  capability: Capability = 'reimbursements.approve',
) {
  const scope = requireScope(user, capability);
  if (scope === 'all') return {};
  if (scope === 'own') {
    return user.trainerId ? { trainerId: user.trainerId } : MATCH_NOTHING;
  }
  if (scope === 'project') {
    return user.ledProjectIds.length > 0
      ? { trainer: { assignments: { some: { projectId: { in: user.ledProjectIds } } } } }
      : MATCH_NOTHING;
  }
  return MATCH_NOTHING;
}

/**
 * The `mine=true` narrowing, expressed as a predicate on the owning assignment.
 *
 * This is not a scope — the caller's scope has already been applied and this is
 * combined with it under `AND`, so it can only ever shrink the result. It exists
 * because a Project Lead legitimately reads their whole project, which makes
 * their own "My …" screen list their team unless the screen says whose records
 * it means.
 */
export function ownAssignmentFilter(user: AuthenticatedUser) {
  return user.trainerId ? { assignment: { trainerId: user.trainerId } } : MATCH_NOTHING;
}

export function deboardingScope(
  user: AuthenticatedUser,
  capability: Capability = 'deboarding.read',
) {
  return throughAssignment(user, capability);
}
