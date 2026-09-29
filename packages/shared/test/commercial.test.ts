import { describe, expect, it } from 'vitest';
import { billingStateOf, computeMargin, isBillingUndecided, tallyDays } from '../src/rules.js';
import { setBillRateSchema } from '../src/schemas/commercial.js';

/**
 * The accounting judgements, in the only place they are made.
 *
 * The cases that matter are the asymmetric ones: a day the trainer is paid for
 * but the client is not charged for, a day that belongs to neither calendar,
 * and work nobody agreed a rate for at all.
 */
describe('tallying a set of days', () => {
  it('charges the client only for days actually delivered', () => {
    const tally = tallyDays(['present', 'late', 'corrected', 'missing_punch_out']);
    expect(tally).toEqual({ billableDays: 4, payableDays: 4, workingDays: 4 });
  });

  it('pays for approved leave and bills for none of it', () => {
    const tally = tallyDays(['present', 'on_leave', 'on_leave']);
    expect(tally.billableDays).toBe(1);
    expect(tally.payableDays).toBe(3);
    expect(tally.workingDays).toBe(3);
  });

  it('keeps weekly offs and holidays out of the working calendar entirely', () => {
    // Not unpaid days — nobody is docked for a Sunday — but not days of pay
    // earned either. Counting them either way would distort the salary ratio.
    const tally = tallyDays(['weekly_off', 'holiday']);
    expect(tally).toEqual({ billableDays: 0, payableDays: 0, workingDays: 0 });
  });

  it('treats a half day as half delivered but wholly earned', () => {
    const tally = tallyDays(['half_day']);
    expect(tally.billableDays).toBe(0.5);
    expect(tally.payableDays).toBe(1);
    expect(tally.workingDays).toBe(1);
  });

  it('counts absence and leave without pay as working days that earned nothing', () => {
    const tally = tallyDays(['absent', 'leave_without_pay']);
    expect(tally.billableDays).toBe(0);
    expect(tally.payableDays).toBe(0);
    // Still working days: they are what the missed pay is measured against.
    expect(tally.workingDays).toBe(2);
  });

  it('ignores a status it does not recognise rather than assuming it was free', () => {
    const tally = tallyDays(['present', 'something_new']);
    expect(tally).toEqual({ billableDays: 1, payableDays: 1, workingDays: 1 });
  });

  it('has nothing to say about an empty month', () => {
    expect(tallyDays([])).toEqual({ billableDays: 0, payableDays: 0, workingDays: 0 });
  });
});

describe('computing a margin', () => {
  /** A full 26-working-day month, delivered without absence. */
  const base = {
    billableDays: 26,
    dayRate: 5000,
    salaryAnnual: 720_000,
    payableDays: 26,
    workingDaysInPeriod: 26,
  };

  it('earns the day rate for every delivered day', () => {
    expect(computeMargin(base).revenue).toBe(130_000);
  });

  it('costs a twelfth of the annual salary for a month worked in full', () => {
    expect(computeMargin(base).salaryCost).toBe(60_000);
  });

  it('reports the margin and its percentage of revenue', () => {
    const result = computeMargin(base);
    expect(result.margin).toBe(70_000);
    expect(result.marginPercent).toBe(53.85);
  });

  it('docks the salary for days that earned no pay', () => {
    // Two days absent: 24 of 26 earned.
    const result = computeMargin({ ...base, billableDays: 24, payableDays: 24 });
    expect(result.salaryCost).toBe(55_384.62);
    expect(result.revenue).toBe(120_000);
  });

  it('charges a half-month assignment half the month, not all of it', () => {
    // The denominator is the period, never the assignment. This is the case
    // that a dock-the-absences model gets wrong: 13 payable days out of the
    // month's 26 is half a month's salary, however long the assignment ran.
    const result = computeMargin({ ...base, billableDays: 13, payableDays: 13 });
    expect(result.salaryCost).toBe(30_000);
    expect(result.revenue).toBe(65_000);
    expect(result.margin).toBe(35_000);
  });

  it('never charges more than the period’s salary, whatever the records say', () => {
    const result = computeMargin({ ...base, payableDays: 40 });
    expect(result.salaryCost).toBe(60_000);
  });

  it('adds reimbursements to the cost, because they are real money out', () => {
    const result = computeMargin({ ...base, reimbursements: 12_500 });
    expect(result.cost).toBe(72_500);
    expect(result.margin).toBe(57_500);
  });

  it('marks work with no agreed rate as unbilled rather than a total loss', () => {
    const result = computeMargin({ ...base, dayRate: null });
    expect(result.unbilled).toBe(true);
    expect(result.revenue).toBe(0);
    // The cost is real and still reported; what is absent is a percentage,
    // because dividing by no revenue would invent a -100% that means nothing.
    expect(result.salaryCost).toBe(60_000);
    expect(result.marginPercent).toBeNull();
  });

  it('reports a loss honestly when the rate does not cover the salary', () => {
    const result = computeMargin({ ...base, dayRate: 1000 });
    expect(result.revenue).toBe(26_000);
    expect(result.margin).toBe(-34_000);
    expect(result.marginPercent).toBe(-130.77);
    expect(result.unbilled).toBe(false);
  });

  it('costs nothing for a period with no working days in it', () => {
    const result = computeMargin({ ...base, workingDaysInPeriod: 0, payableDays: 0 });
    expect(Number.isFinite(result.salaryCost)).toBe(true);
    expect(result.salaryCost).toBe(0);
  });

  it('scales the salary across a multi-month window', () => {
    const result = computeMargin({
      ...base,
      months: 3,
      payableDays: 78,
      workingDaysInPeriod: 78,
    });
    expect(result.salaryCost).toBe(180_000);
  });

  it('costs nothing in salary for a trainer whose pay is not recorded', () => {
    const result = computeMargin({ ...base, salaryAnnual: null });
    expect(result.salaryCost).toBe(0);
    expect(result.margin).toBe(130_000);
  });
});

/**
 * Which of the three billing answers an assignment is on.
 *
 * The distinction this exists for: a null day rate used to mean both "internal
 * work, never billed" and "nobody has agreed a rate". One is finished business
 * and the other is money going uncollected, and a screen that cannot tell them
 * apart has to warn about both forever.
 */
describe('how an assignment is billed', () => {
  it('is rated when there is a rate', () => {
    expect(billingStateOf({ dayRate: 6500, notBilledReason: null })).toBe('rated');
  });

  it('is undecided when there is neither a rate nor a reason', () => {
    expect(billingStateOf({ dayRate: null, notBilledReason: null })).toBe('undecided');
  });

  it('is settled once somebody says why it is not billed', () => {
    expect(billingStateOf({ dayRate: null, notBilledReason: 'Internal curriculum work.' })).toBe(
      'not_billed',
    );
  });

  it('treats a rate of zero as a rate, not as an absence of one', () => {
    // Agreeing to deliver at no charge is a decision; it is not the same as
    // never having priced the work, and rounding it to "undecided" would put
    // it back in the queue of things to chase.
    expect(billingStateOf({ dayRate: 0, notBilledReason: null })).toBe('rated');
  });

  it('ignores an empty reason, which is not a reason', () => {
    expect(billingStateOf({ dayRate: null, notBilledReason: '' })).toBe('undecided');
  });

  it('names only the undecided ones as needing something done', () => {
    expect(isBillingUndecided({ dayRate: null, notBilledReason: null })).toBe(true);
    expect(isBillingUndecided({ dayRate: null, notBilledReason: 'Goodwill.' })).toBe(false);
    expect(isBillingUndecided({ dayRate: 6500, notBilledReason: null })).toBe(false);
  });
});

describe('deciding how a client is charged', () => {
  it('refuses a rate and a reason not to bill in the same breath', () => {
    // Contradictory answers to one question. The database refuses the row too;
    // this is the refusal that reaches the person while they can still fix it.
    const result = setBillRateSchema.safeParse({
      billRatePerDay: 6500,
      notBilledReason: 'Internal work.',
    });
    expect(result.success).toBe(false);
  });

  it('insists a decision not to bill says why', () => {
    expect(
      setBillRateSchema.safeParse({ billRatePerDay: null, notBilledReason: 'no' }).success,
    ).toBe(false);
  });

  it('takes a rate on its own, and a reason on its own', () => {
    expect(setBillRateSchema.safeParse({ billRatePerDay: 6500 }).success).toBe(true);
    expect(
      setBillRateSchema.safeParse({ billRatePerDay: null, notBilledReason: 'Internal curriculum.' })
        .success,
    ).toBe(true);
  });

  it('still allows clearing a rate without deciding anything', () => {
    // Undoing a rate is not the same as declaring the work unbilled, and
    // forcing a reason here would make a correction impossible to record.
    expect(setBillRateSchema.safeParse({ billRatePerDay: null }).success).toBe(true);
  });
});
