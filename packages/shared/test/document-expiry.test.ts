import { describe, expect, it } from 'vitest';
import { defaultExpiryFor, documentValidity } from '../src/rules.js';

/**
 * Whether a document is still worth anything.
 *
 * The case that matters is the one an absent date makes easy to get wrong:
 * treating "nobody recorded when this lapses" as "fine" is exactly how an
 * expired police verification reaches a client site.
 */
const TODAY = '2026-09-04';

describe('deciding whether a document is current', () => {
  it('has nothing to say about a document that does not lapse', () => {
    const result = documentValidity('aadhaar', null, { today: TODAY });
    expect(result.state).toBe('not_applicable');
    expect(result.message).toBeNull();
  });

  it('ignores an expiry date on a document that cannot have one', () => {
    // A degree certificate does not stop being true. A date typed against one
    // is noise, and reporting it as expiring would send somebody chasing it.
    const result = documentValidity('education_certificate', '2020-01-01', { today: TODAY });
    expect(result.state).toBe('not_applicable');
  });

  it('calls a lapsing document with no date a gap, not a reassurance', () => {
    const result = documentValidity('police_verification', null, { today: TODAY });
    expect(result.state).toBe('missing_date');
    expect(result.daysRemaining).toBeNull();
    expect(result.message).toMatch(/nobody can tell whether this is still current/);
  });

  it('treats an empty string the same as no date at all', () => {
    expect(documentValidity('police_verification', '', { today: TODAY }).state).toBe(
      'missing_date',
    );
  });

  it('is valid while there is plenty of time left', () => {
    const result = documentValidity('police_verification', '2027-03-01', { today: TODAY });
    expect(result.state).toBe('valid');
    expect(result.daysRemaining).toBe(178);
    // Nothing to say about a document nobody needs to do anything about.
    expect(result.message).toBeNull();
  });

  it('starts warning a month out', () => {
    const result = documentValidity('police_verification', '2026-10-01', { today: TODAY });
    expect(result.state).toBe('expiring_soon');
    expect(result.daysRemaining).toBe(27);
    expect(result.message).toBe('Expires in 27 days.');
  });

  it('warns on the boundary day rather than one day late', () => {
    // Thirty days out is inside the window; thirty-one is not.
    expect(documentValidity('medical_certificate', '2026-10-04', { today: TODAY }).state).toBe(
      'expiring_soon',
    );
    expect(documentValidity('medical_certificate', '2026-10-05', { today: TODAY }).state).toBe(
      'valid',
    );
  });

  it('says a document expiring today expires today, not in zero days', () => {
    const result = documentValidity('police_verification', TODAY, { today: TODAY });
    expect(result.state).toBe('expiring_soon');
    expect(result.daysRemaining).toBe(0);
    expect(result.message).toBe('Expires today.');
  });

  it('counts the days since one lapsed', () => {
    const result = documentValidity('police_verification', '2026-08-25', { today: TODAY });
    expect(result.state).toBe('expired');
    expect(result.daysRemaining).toBe(-10);
    expect(result.message).toBe('Expired 10 days ago.');
  });

  it('says "1 day" rather than "1 days"', () => {
    expect(documentValidity('police_verification', '2026-09-05', { today: TODAY }).message).toBe(
      'Expires in 1 day.',
    );
    expect(documentValidity('police_verification', '2026-09-03', { today: TODAY }).message).toBe(
      'Expired 1 day ago.',
    );
  });

  it('takes a different warning window when one is given', () => {
    const result = documentValidity('police_verification', '2026-11-01', {
      today: TODAY,
      warningDays: 90,
    });
    expect(result.state).toBe('expiring_soon');
  });
});

describe('working out when a new one would run to', () => {
  it('gives a police verification a year', () => {
    expect(defaultExpiryFor('police_verification', '2026-09-04')).toBe('2027-09-04');
  });

  it('has no answer for a document that does not lapse', () => {
    expect(defaultExpiryFor('aadhaar', '2026-09-04')).toBeNull();
  });

  it('rolls a month-end date forward rather than inventing a day', () => {
    // 29 February plus twelve months is 1 March in a non-leap year, which is
    // what the calendar says and what a renewal reminder has to agree with.
    expect(defaultExpiryFor('medical_certificate', '2028-02-29')).toBe('2029-03-01');
  });
});
