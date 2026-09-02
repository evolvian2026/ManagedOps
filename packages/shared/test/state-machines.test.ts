import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  DEBOARDING_STATUSES,
  INTERVIEW_STATUSES,
  LEAVE_STATUSES,
  OFFER_STATUSES,
  REIMBURSEMENT_STATUSES,
  TRAINER_STATUSES,
} from '../src/enums.js';
import {
  IllegalTransitionError,
  TRANSITION_TABLES,
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
  type LifecycleName,
} from '../src/state-machines.js';

const lifecycles = Object.keys(TRANSITION_TABLES) as LifecycleName[];

describe('transition tables', () => {
  it('covers every lifecycle the product defines', () => {
    expect(lifecycles).toEqual([
      'application',
      'interview',
      'offer',
      'trainer',
      'leave',
      'reimbursement',
      'assetIssue',
      'flag',
      'deboarding',
    ]);
  });

  it.each(lifecycles)('%s only ever names states declared in its own table', (lifecycle) => {
    const table = TRANSITION_TABLES[lifecycle] as Record<string, readonly string[]>;
    const declared = new Set(Object.keys(table));
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        expect(declared, `${lifecycle}.${from} -> ${to}`).toContain(to);
      }
    }
  });

  it.each(lifecycles)('%s never declares a self-transition', (lifecycle) => {
    const table = TRANSITION_TABLES[lifecycle] as Record<string, readonly string[]>;
    for (const [from, targets] of Object.entries(table)) {
      expect(targets, `${lifecycle}.${from}`).not.toContain(from);
    }
  });

  it.each(lifecycles)('%s reaches at least one terminal state', (lifecycle) => {
    const table = TRANSITION_TABLES[lifecycle] as Record<string, readonly string[]>;
    const terminals = Object.keys(table).filter((state) => isTerminal(lifecycle, state));
    expect(terminals.length).toBeGreaterThan(0);
  });
});

/** Each table's keys must be exactly the enum it governs — no drift either way. */
describe('table keys match their enums', () => {
  const pairs: [LifecycleName, readonly string[]][] = [
    ['application', APPLICATION_STATUSES],
    ['interview', INTERVIEW_STATUSES],
    ['offer', OFFER_STATUSES],
    ['trainer', TRAINER_STATUSES],
    ['leave', LEAVE_STATUSES],
    ['reimbursement', REIMBURSEMENT_STATUSES],
    ['deboarding', DEBOARDING_STATUSES],
  ];

  it.each(pairs)('%s', (lifecycle, statuses) => {
    expect(Object.keys(TRANSITION_TABLES[lifecycle]).sort()).toEqual([...statuses].sort());
  });
});

describe('assertTransition', () => {
  it('permits every legal move in every lifecycle', () => {
    for (const lifecycle of lifecycles) {
      const table = TRANSITION_TABLES[lifecycle] as Record<string, readonly string[]>;
      for (const [from, targets] of Object.entries(table)) {
        for (const to of targets) {
          expect(() => assertTransition(lifecycle, from, to)).not.toThrow();
          expect(canTransition(lifecycle, from, to)).toBe(true);
        }
      }
    }
  });

  it('rejects every move not declared, across every state pair', () => {
    for (const lifecycle of lifecycles) {
      const table = TRANSITION_TABLES[lifecycle] as Record<string, readonly string[]>;
      const states = Object.keys(table);
      for (const from of states) {
        for (const to of states) {
          if (table[from]?.includes(to)) continue;
          expect(() => assertTransition(lifecycle, from, to)).toThrow(IllegalTransitionError);
          expect(canTransition(lifecycle, from, to)).toBe(false);
        }
      }
    }
  });

  it('names both states in the error so the API can explain the refusal', () => {
    try {
      assertTransition('offer', 'accepted', 'draft');
      expect.unreachable('accepted -> draft must not be allowed');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      const illegal = error as IllegalTransitionError;
      expect(illegal.from).toBe('accepted');
      expect(illegal.to).toBe('draft');
      expect(illegal.message).toContain('accepted');
      expect(illegal.message).toContain('draft');
    }
  });

  it('treats an unknown state as illegal rather than passing it through', () => {
    expect(canTransition('leave', 'nonsense', 'approved')).toBe(false);
    expect(nextStates('leave', 'nonsense')).toEqual([]);
  });
});

describe('specific rules the specification calls out', () => {
  it('never lets a hired application move on', () => {
    expect(nextStates('application', 'hired')).toEqual([]);
  });

  it('never reopens a missed interview into a booking', () => {
    // Rescheduling creates a new round; the missed record stays missed.
    expect(canTransition('interview', 'missed', 'scheduled')).toBe(false);
  });

  it('never revives a declined offer', () => {
    expect(canTransition('offer', 'declined', 'sent')).toBe(false);
  });

  it('lets a deboarded trainer return to active when re-hired from the pool', () => {
    expect(canTransition('trainer', 'deboarded', 'active')).toBe(true);
  });

  it('allows leave to be escalated then decided', () => {
    expect(canTransition('leave', 'submitted', 'escalated')).toBe(true);
    expect(canTransition('leave', 'escalated', 'approved')).toBe(true);
  });

  it('only pays a reimbursement that was approved first', () => {
    expect(canTransition('reimbursement', 'submitted', 'reimbursed')).toBe(false);
    expect(canTransition('reimbursement', 'approved', 'reimbursed')).toBe(true);
  });

  it('walks deboarding through assets and settlement before completion', () => {
    expect(canTransition('deboarding', 'initiated', 'completed')).toBe(false);
    expect(nextStates('deboarding', 'initiated')).toEqual(['assets_pending']);
    expect(nextStates('deboarding', 'fnf_pending')).toEqual(['completed']);
  });
});
