import { describe, expect, it } from 'vitest';
import { summariseReviews, type ReviewInput } from '../src/rules.js';

/**
 * What feedback is allowed to claim.
 *
 * A re-hire decision gets made off this, so the cases that matter are the ones
 * where a naive average would say something confident and wrong.
 */
const TODAY = '2026-09-03';

function review(over: Partial<ReviewInput> = {}): ReviewInput {
  return { source: 'client', rating: 4, observedOn: '2026-08-01', ...over };
}

describe('summarising feedback', () => {
  it('says plainly when there is nothing', () => {
    const summary = summariseReviews([], { today: TODAY });
    expect(summary.overall).toBeNull();
    expect(summary.confident).toBe(false);
    expect(summary.caveat).toBe('Nobody has recorded any feedback yet.');
  });

  it('refuses to treat a single review as a verdict', () => {
    const summary = summariseReviews([review({ rating: 5 })], { today: TODAY });
    // The number is reported; what is withheld is the impression it settles
    // anything. A 5.0 printed like a conclusion is how a ranking loses trust.
    expect(summary.overall).toBe(5);
    expect(summary.confident).toBe(false);
    expect(summary.caveat).toMatch(/single review/);
  });

  it('is confident once there are enough reviews', () => {
    const summary = summariseReviews(
      [review({ rating: 4 }), review({ rating: 5 }), review({ rating: 4 })],
      { today: TODAY },
    );
    expect(summary.confident).toBe(true);
    expect(summary.caveat).toBeNull();
  });

  it('is confident on one big cohort, because forty people is not an anecdote', () => {
    const summary = summariseReviews(
      [review({ source: 'learner_batch', rating: 4, respondents: 40 })],
      { today: TODAY },
    );
    expect(summary.confident).toBe(true);
    expect(summary.respondentCount).toBe(40);
  });

  it('weights a cohort by its size within its own source', () => {
    const summary = summariseReviews(
      [
        review({ source: 'learner_batch', rating: 5, respondents: 1 }),
        review({ source: 'learner_batch', rating: 3, respondents: 39 }),
      ],
      { today: TODAY },
    );
    // Not 4. Thirty-nine people saying three outweighs one saying five.
    expect(summary.bySource[0]!.average).toBe(3.05);
  });

  it('does not let a big cohort drown out the client', () => {
    const summary = summariseReviews(
      [
        review({ source: 'learner_batch', rating: 5, respondents: 100 }),
        review({ source: 'client', rating: 1 }),
      ],
      { today: TODAY },
    );
    // Sources are equals: the client decides whether there is more work, and a
    // headcount-weighted mean would have made their view invisible at 4.96.
    expect(summary.overall).toBe(3);
  });

  it('breaks the score down by where it came from', () => {
    const summary = summariseReviews(
      [
        review({ source: 'client', rating: 5 }),
        review({ source: 'internal_observation', rating: 3 }),
        review({ source: 'learner_batch', rating: 4, respondents: 20 }),
      ],
      { today: TODAY },
    );

    expect(summary.bySource.map((entry) => entry.source)).toEqual([
      'client',
      'internal_observation',
      'learner_batch',
    ]);
    expect(summary.bySource.find((entry) => entry.source === 'client')!.average).toBe(5);
    expect(summary.overall).toBe(4);
  });

  it('averages each dimension over the reviews that offered one', () => {
    const summary = summariseReviews(
      [
        review({ knowledge: 5, delivery: 3 }),
        review({ knowledge: 3, delivery: 3, professionalism: 4 }),
        review({}),
      ],
      { today: TODAY },
    );
    expect(summary.dimensions.knowledge).toBe(4);
    expect(summary.dimensions.delivery).toBe(3);
    // Only one review had a view on it, and a blank is not a zero.
    expect(summary.dimensions.professionalism).toBe(4);
  });

  it('leaves a dimension null when nobody scored it', () => {
    const summary = summariseReviews([review({})], { today: TODAY });
    expect(summary.dimensions.knowledge).toBeNull();
  });

  it('ignores a retracted review but still says one was', () => {
    const summary = summariseReviews(
      [review({ rating: 5 }), review({ rating: 1, retracted: true })],
      { today: TODAY },
    );
    expect(summary.overall).toBe(5);
    expect(summary.reviewCount).toBe(1);
    expect(summary.retractedCount).toBe(1);
  });

  it('reports nothing at all when every review was retracted', () => {
    const summary = summariseReviews([review({ retracted: true })], { today: TODAY });
    expect(summary.overall).toBeNull();
    expect(summary.retractedCount).toBe(1);
  });
});

describe('which way it is heading', () => {
  const OLD = '2025-06-01';
  const NEW = '2026-08-01';

  it('calls it improving when the recent months are better', () => {
    const summary = summariseReviews(
      [review({ rating: 2, observedOn: OLD }), review({ rating: 5, observedOn: NEW })],
      { today: TODAY },
    );
    expect(summary.trend).toBe('improving');
    expect(summary.recent).toBe(5);
  });

  it('calls it declining when they are worse', () => {
    const summary = summariseReviews(
      [review({ rating: 5, observedOn: OLD }), review({ rating: 2, observedOn: NEW })],
      { today: TODAY },
    );
    expect(summary.trend).toBe('declining');
  });

  it('calls a small move steady rather than a trend', () => {
    // A quarter of a point on a five-point scale is noise, and naming it a
    // direction would have somebody managed on it.
    const summary = summariseReviews(
      [review({ rating: 4, observedOn: OLD }), review({ rating: 4.25, observedOn: NEW })],
      { today: TODAY },
    );
    expect(summary.trend).toBe('steady');
  });

  it('has no trend when everything is in one window', () => {
    const summary = summariseReviews(
      [review({ rating: 4, observedOn: NEW }), review({ rating: 5, observedOn: NEW })],
      { today: TODAY },
    );
    // Nothing to compare against, and inventing a "before" would be a guess.
    expect(summary.trend).toBeNull();
    expect(summary.recent).toBe(4.5);
  });

  it('has no recent figure when all the feedback is old', () => {
    const summary = summariseReviews([review({ rating: 4, observedOn: OLD })], { today: TODAY });
    expect(summary.recent).toBeNull();
    expect(summary.trend).toBeNull();
    expect(summary.overall).toBe(4);
  });
});
