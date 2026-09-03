import { describe, expect, it } from 'vitest';
import { availabilityIn, scoreMatch, type HeldSkill, type RequiredSkill } from '../src/rules.js';

/**
 * The judgements behind a ranked list of people.
 *
 * A matching feature earns trust by being arguable: every case here is one a
 * staffer would raise if the list looked wrong, and the assertions are as much
 * about the sentences as the number.
 */
const REACT: RequiredSkill = { skillId: 'react', name: 'React', requirement: 'essential' };
const NODE: RequiredSkill = { skillId: 'node', name: 'Node.js', requirement: 'essential' };
const DOCKER: RequiredSkill = { skillId: 'docker', name: 'Docker', requirement: 'desirable' };
const TESTING: RequiredSkill = { skillId: 'testing', name: 'Testing', requirement: 'desirable' };

const TODAY = '2026-09-03';

function held(skillId: string, proficiency: HeldSkill['proficiency'], lastUsedOn?: string) {
  return { skillId, proficiency, lastUsedOn: lastUsedOn ?? null };
}

describe('scoring a trainer against a position', () => {
  it('disqualifies somebody missing an essential skill, however strong elsewhere', () => {
    const result = scoreMatch(
      [REACT, NODE, DOCKER, TESTING],
      [
        held('react', 'expert', TODAY),
        held('docker', 'expert', TODAY),
        held('testing', 'expert', TODAY),
      ],
      { today: TODAY },
    );

    // Three expert skills and still zero: the position exists for Node.
    expect(result.eligible).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons[0]).toBe('Missing an essential skill: Node.js.');
  });

  it('treats a skill held below the level asked for as not held, and says so', () => {
    const result = scoreMatch(
      [{ ...REACT, minProficiency: 'advanced' }],
      [held('react', 'beginner', TODAY)],
      { today: TODAY },
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain('below the level asked for');
    expect(result.matches[0].belowRequestedLevel).toBe(true);
    expect(result.matches[0].proficiency).toBe('beginner');
  });

  it('accepts a skill at exactly the level asked for', () => {
    const result = scoreMatch(
      [{ ...REACT, minProficiency: 'advanced' }],
      [held('react', 'advanced', TODAY)],
      { today: TODAY },
    );
    expect(result.eligible).toBe(true);
  });

  it('ranks a complete match above one that only meets the essentials', () => {
    const complete = scoreMatch(
      [REACT, NODE, DOCKER, TESTING],
      [
        held('react', 'advanced', TODAY),
        held('node', 'advanced', TODAY),
        held('docker', 'intermediate', TODAY),
        held('testing', 'intermediate', TODAY),
      ],
      { today: TODAY },
    );
    const bare = scoreMatch(
      [REACT, NODE, DOCKER, TESTING],
      [held('react', 'advanced', TODAY), held('node', 'advanced', TODAY)],
      { today: TODAY },
    );

    expect(complete.score).toBeGreaterThan(bare.score);
    expect(bare.eligible).toBe(true);
    expect(bare.reasons).toContain('Has 0 of 2 desirable skills.');
  });

  it('ranks depth above breadth at the same coverage', () => {
    const deep = scoreMatch([REACT, NODE], [held('react', 'expert'), held('node', 'expert')]);
    const shallow = scoreMatch(
      [REACT, NODE],
      [held('react', 'beginner'), held('node', 'beginner')],
    );
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  it('prefers a current skill to a stale one, and names the staleness', () => {
    const current = scoreMatch([REACT], [held('react', 'advanced', '2026-08-01')], {
      today: TODAY,
    });
    const stale = scoreMatch([REACT], [held('react', 'advanced', '2022-01-01')], { today: TODAY });

    expect(current.score).toBeGreaterThan(stale.score);
    expect(current.reasons).toContain('Used the essential skills within six months.');
    expect(stale.reasons).toContain('Has not used the essential skills in 4 years.');
  });

  it('does not let a current soft skill vouch for a stale essential one', () => {
    // The failure this guards against: somebody whose Python is three years old
    // but who taught a class last month reading as "used within six months".
    // True of the wrong skill, and the sort of plausible answer that costs a
    // ranking its credibility.
    const stalePython = scoreMatch(
      [REACT, { ...TESTING, requirement: 'desirable' }],
      [held('react', 'advanced', '2022-01-01'), held('testing', 'advanced', '2026-08-01')],
      { today: TODAY },
    );
    const currentPython = scoreMatch(
      [REACT, { ...TESTING, requirement: 'desirable' }],
      [held('react', 'advanced', '2026-08-01'), held('testing', 'advanced', '2026-08-01')],
      { today: TODAY },
    );

    expect(stalePython.score).toBeLessThan(currentPython.score);
    expect(stalePython.reasons).toContain('Has not used the essential skills in 4 years.');
  });

  it('judges recency on the stalest essential, not the freshest', () => {
    // A position needing two skills is not served by somebody current on one
    // and years off the other.
    const lopsided = scoreMatch(
      [REACT, NODE],
      [held('react', 'advanced', '2026-08-01'), held('node', 'advanced', '2021-01-01')],
      { today: TODAY },
    );
    const bothCurrent = scoreMatch(
      [REACT, NODE],
      [held('react', 'advanced', '2026-08-01'), held('node', 'advanced', '2026-08-01')],
      { today: TODAY },
    );

    expect(lopsided.score).toBeLessThan(bothCurrent.score);
  });

  it('neither credits nor punishes a profile that never says when a skill was used', () => {
    const unknown = scoreMatch([REACT], [held('react', 'advanced')], { today: TODAY });
    const current = scoreMatch([REACT], [held('react', 'advanced', '2026-08-01')], {
      today: TODAY,
    });
    const stale = scoreMatch([REACT], [held('react', 'advanced', '2020-01-01')], { today: TODAY });

    // An unfilled field is missing information, not evidence of staleness.
    expect(unknown.score).toBeLessThan(current.score);
    expect(unknown.score).toBeGreaterThan(stale.score);
  });

  it('rules nobody out for a position that lists no essential skills', () => {
    const result = scoreMatch([DOCKER], [], { today: TODAY });
    expect(result.eligible).toBe(true);
    expect(result.reasons[0]).toMatch(/no essential skills/);
  });

  it('gives a position with nothing required at all a defined answer', () => {
    const result = scoreMatch([], [held('react', 'expert')], { today: TODAY });
    expect(result.eligible).toBe(true);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it('never exceeds 100 even for a flawless profile', () => {
    const result = scoreMatch(
      [REACT, NODE, DOCKER, TESTING],
      [
        held('react', 'expert', TODAY),
        held('node', 'expert', TODAY),
        held('docker', 'expert', TODAY),
        held('testing', 'expert', TODAY),
      ],
      { today: TODAY },
    );
    expect(result.score).toBe(100);
  });

  it('ignores skills the position never asked about', () => {
    const focused = scoreMatch([REACT], [held('react', 'advanced', TODAY)], { today: TODAY });
    const cluttered = scoreMatch(
      [REACT],
      [held('react', 'advanced', TODAY), held('cobol', 'expert', '2001-01-01')],
      { today: TODAY },
    );
    // A stale COBOL entry says nothing about a React posting.
    expect(cluttered.score).toBe(focused.score);
  });
});

describe('working out what is left of somebody', () => {
  const WINDOW = { from: '2026-10-01', to: '2026-10-31' };

  it('reports a trainer with nothing booked as on the bench', () => {
    const result = availabilityIn([], WINDOW);
    expect(result).toEqual({
      committedPercent: 0,
      availablePercent: 100,
      availableFrom: '2026-10-01',
      onBench: true,
    });
  });

  it('reports a full-time commitment as fully booked', () => {
    const result = availabilityIn(
      [{ startDate: '2026-01-01', endDate: '2026-12-31', allocationPercent: 100 }],
      WINDOW,
    );
    expect(result.availablePercent).toBe(0);
    expect(result.onBench).toBe(false);
    expect(result.availableFrom).toBe('2027-01-01');
  });

  it('adds part-time commitments together', () => {
    const result = availabilityIn(
      [
        { startDate: '2026-01-01', endDate: null, allocationPercent: 60 },
        { startDate: '2026-01-01', endDate: null, allocationPercent: 20 },
      ],
      WINDOW,
    );
    expect(result.committedPercent).toBe(80);
    expect(result.availablePercent).toBe(20);
  });

  it('measures the busiest point, not the average across the window', () => {
    // Free for most of October, fully booked for the last week. Somebody who
    // cannot take a month-long posting must not read as 75% free.
    const result = availabilityIn(
      [{ startDate: '2026-10-25', endDate: '2026-11-30', allocationPercent: 100 }],
      WINDOW,
    );
    expect(result.committedPercent).toBe(100);
    expect(result.availablePercent).toBe(0);
  });

  it('says it does not know when an open-ended commitment frees up', () => {
    const result = availabilityIn(
      [{ startDate: '2026-01-01', endDate: null, allocationPercent: 100 }],
      WINDOW,
    );
    // Null rather than a guess: "we do not know" is not "never", and inventing
    // a date would put somebody on a shortlist they cannot be on.
    expect(result.availableFrom).toBeNull();
  });

  it('ignores a commitment that ends before the window opens', () => {
    const result = availabilityIn(
      [{ startDate: '2026-01-01', endDate: '2026-09-30', allocationPercent: 100 }],
      WINDOW,
    );
    expect(result.onBench).toBe(true);
    expect(result.availablePercent).toBe(100);
  });

  it('ignores a commitment that starts after the window closes', () => {
    const result = availabilityIn(
      [{ startDate: '2026-11-01', endDate: null, allocationPercent: 100 }],
      WINDOW,
    );
    expect(result.onBench).toBe(true);
  });

  it('counts a commitment that only touches the last day of the window', () => {
    const result = availabilityIn(
      [{ startDate: '2026-10-31', endDate: null, allocationPercent: 100 }],
      WINDOW,
    );
    expect(result.onBench).toBe(false);
    expect(result.availablePercent).toBe(0);
  });

  it('frees them the day after the last commitment ends', () => {
    const result = availabilityIn(
      [
        { startDate: '2026-01-01', endDate: '2026-11-15', allocationPercent: 100 },
        { startDate: '2026-01-01', endDate: '2026-10-20', allocationPercent: 100 },
      ],
      WINDOW,
    );
    expect(result.availableFrom).toBe('2026-11-16');
  });
});
