import type {
  ApplicationStatus,
  AssetIssueStatus,
  DeboardingStatus,
  FlagStatus,
  InterviewStatus,
  LeaveStatus,
  OfferStatus,
  ReimbursementStatus,
  TrainerStatus,
} from './enums.js';

/**
 * Every lifecycle in the product is declared here as an explicit transition
 * table. Services never assign a status directly — they call `assertTransition`,
 * so an illegal move is a 409 naming both states rather than a silently corrupt
 * row. The API's test suite walks these tables exhaustively, which is why the
 * spec requires 100% coverage on this file.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const APPLICATION_TRANSITIONS: TransitionTable<ApplicationStatus> = {
  applied: ['screening', 'withdrawn'],
  screening: ['interviewing', 'rejected_screening', 'not_available', 'withdrawn'],
  interviewing: ['offer_stage', 'rejected_interview', 'withdrawn'],
  offer_stage: ['hired', 'offer_declined', 'withdrawn'],
  hired: [],
  rejected_screening: [],
  rejected_interview: [],
  not_available: [],
  offer_declined: [],
  withdrawn: [],
};

export const INTERVIEW_TRANSITIONS: TransitionTable<InterviewStatus> = {
  scheduled: ['completed', 'missed', 'cancelled'],
  completed: [],
  // A missed interview is never mutated into a new booking; rescheduling
  // creates a fresh round linked back to this one, so the history survives.
  missed: ['cancelled'],
  cancelled: [],
};

export const OFFER_TRANSITIONS: TransitionTable<OfferStatus> = {
  draft: ['sent', 'withdrawn'],
  sent: ['accepted', 'declined', 'revision_requested', 'withdrawn'],
  accepted: [],
  declined: [],
  // A revision supersedes this offer; the replacement is a new row at version+1.
  revision_requested: ['withdrawn'],
  withdrawn: [],
};

export const TRAINER_TRANSITIONS: TransitionTable<TrainerStatus> = {
  pending_onboarding: ['active', 'archived'],
  active: ['deboarding', 'archived'],
  deboarding: ['deboarded', 'active'],
  deboarded: ['archived', 'active'],
  archived: [],
};

export const LEAVE_TRANSITIONS: TransitionTable<LeaveStatus> = {
  submitted: ['approved', 'rejected', 'escalated', 'cancelled'],
  escalated: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

export const REIMBURSEMENT_TRANSITIONS: TransitionTable<ReimbursementStatus> = {
  submitted: ['under_review', 'approved', 'rejected'],
  under_review: ['approved', 'rejected'],
  approved: ['reimbursed'],
  rejected: [],
  reimbursed: [],
};

export const ASSET_ISSUE_TRANSITIONS: TransitionTable<AssetIssueStatus> = {
  issued: ['returned', 'lost', 'damaged'],
  returned: [],
  lost: ['returned'],
  damaged: ['returned'],
};

export const FLAG_TRANSITIONS: TransitionTable<FlagStatus> = {
  raised: ['acknowledged', 'closed'],
  acknowledged: ['action_taken', 'closed'],
  action_taken: ['closed'],
  closed: [],
};

export const DEBOARDING_TRANSITIONS: TransitionTable<DeboardingStatus> = {
  initiated: ['assets_pending'],
  assets_pending: ['fnf_pending'],
  fnf_pending: ['completed'],
  completed: [],
};

export const TRANSITION_TABLES = {
  application: APPLICATION_TRANSITIONS,
  interview: INTERVIEW_TRANSITIONS,
  offer: OFFER_TRANSITIONS,
  trainer: TRAINER_TRANSITIONS,
  leave: LEAVE_TRANSITIONS,
  reimbursement: REIMBURSEMENT_TRANSITIONS,
  assetIssue: ASSET_ISSUE_TRANSITIONS,
  flag: FLAG_TRANSITIONS,
  deboarding: DEBOARDING_TRANSITIONS,
} as const;

export type LifecycleName = keyof typeof TRANSITION_TABLES;

export class IllegalTransitionError extends Error {
  constructor(
    readonly lifecycle: LifecycleName,
    readonly from: string,
    readonly to: string,
  ) {
    super(`A ${lifecycle} cannot move from "${from}" to "${to}"`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(lifecycle: LifecycleName, from: string, to: string): boolean {
  const table = TRANSITION_TABLES[lifecycle] as Readonly<Record<string, readonly string[]>>;
  return table[from]?.includes(to) ?? false;
}

/** Throws `IllegalTransitionError`, which the API maps to HTTP 409. */
export function assertTransition(lifecycle: LifecycleName, from: string, to: string): void {
  if (!canTransition(lifecycle, from, to)) {
    throw new IllegalTransitionError(lifecycle, from, to);
  }
}

export function nextStates(lifecycle: LifecycleName, from: string): readonly string[] {
  const table = TRANSITION_TABLES[lifecycle] as Readonly<Record<string, readonly string[]>>;
  return table[from] ?? [];
}

export function isTerminal(lifecycle: LifecycleName, state: string): boolean {
  return nextStates(lifecycle, state).length === 0;
}
