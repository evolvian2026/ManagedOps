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
      'attendance',
      'correction',
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

describe('the attendance day', () => {
  it('downgrades an open day at the nightly close', () => {
    // The edge the close job depends on: a day recorded optimistically at
    // punch-in becomes missing_punch_out if nobody ever closed it.
    expect(canTransition('attendance', 'present', 'missing_punch_out')).toBe(true);
    expect(canTransition('attendance', 'late', 'missing_punch_out')).toBe(true);
  });

  it('never turns a corrected day back into an ordinary present one', () => {
    // A day somebody amended stays distinguishable from one punched cleanly.
    expect(canTransition('attendance', 'corrected', 'present')).toBe(false);
    expect(canTransition('attendance', 'correction_pending', 'corrected')).toBe(true);
  });

  it('puts a rejected correction back to any status the punches support', () => {
    for (const status of ['present', 'late', 'missing_punch_out', 'absent']) {
      expect(canTransition('attendance', 'correction_pending', status)).toBe(true);
    }
  });

  it('treats a leave or calendar day as settled', () => {
    for (const status of ['on_leave', 'half_day', 'leave_without_pay', 'holiday', 'weekly_off']) {
      expect(nextStates('attendance', status)).toEqual([]);
    }
  });

  it('lets an approved leave overwrite a day that was only marked absent', () => {
    expect(canTransition('attendance', 'absent', 'on_leave')).toBe(true);
    expect(canTransition('attendance', 'absent', 'leave_without_pay')).toBe(true);
  });
});

describe('a correction', () => {
  it('is decided exactly once', () => {
    expect(canTransition('correction', 'pending', 'approved')).toBe(true);
    expect(canTransition('correction', 'pending', 'rejected')).toBe(true);
    expect(nextStates('correction', 'approved')).toEqual([]);
    expect(nextStates('correction', 'rejected')).toEqual([]);
  });
});

describe('an asset issue', () => {
  it('can still be returned after being written off as lost', () => {
    // Kit does turn up again; the register should be able to say so.
    expect(canTransition('assetIssue', 'lost', 'returned')).toBe(true);
    expect(canTransition('assetIssue', 'damaged', 'returned')).toBe(true);
  });

  it('is finished once it has come back', () => {
    expect(nextStates('assetIssue', 'returned')).toEqual([]);
  });
});

describe('a flag', () => {
  it('cannot be reopened once it is closed', () => {
    expect(nextStates('flag', 'closed')).toEqual([]);
    expect(canTransition('flag', 'closed', 'closed')).toBe(false);
  });
});
