import { describe, expect, it } from 'vitest';
import {
  MOBILE_TEMPLATES,
  MOBILE_TEMPLATE_IDS,
  NOTIFICATION_TYPES,
  SMS_MAX_SEGMENTS,
  maskMobile,
  mobileMessagePurposes,
  mobileTemplateValues,
  normaliseIndianMobile,
  renderMobileTemplate,
  smsSegments,
} from '../src/index.js';

/**
 * The rules behind reaching somebody on their phone.
 *
 * Two things are worth proving here. First, that a number somebody typed by
 * hand either becomes something a provider will accept or is refused outright —
 * a stored number that looks fine and silently never delivers is the worst of
 * the three outcomes. Second, that every template's declared parameters and its
 * registered wording agree: WhatsApp substitutes positionally, so a parameter
 * declared but never used shifts every value after it into the wrong slot.
 */

describe('normalising a mobile number', () => {
  it('accepts the ways people actually type an Indian number', () => {
    for (const typed of [
      '9800001002',
      '+919800001002',
      '+91 98000 01002',
      '91 9800001002',
      '09800001002',
      '098000-01002',
      '(+91) 98000.01002',
    ]) {
      expect(normaliseIndianMobile(typed), typed).toBe('+919800001002');
    }
  });

  it('refuses a number that is not a mobile, however valid a phone number it is', () => {
    // A Delhi landline. It is a real number; it just reaches neither WhatsApp
    // nor an SMS inbox, so storing it as a mobile would be storing a dead end.
    expect(normaliseIndianMobile('011 2345 6789')).toBeNull();
    // The 2-5 series are landline and special ranges; mobiles are 6 to 9.
    expect(normaliseIndianMobile('5800001002')).toBeNull();
  });

  it('refuses a number that is the wrong length rather than padding or truncating it', () => {
    expect(normaliseIndianMobile('980000100')).toBeNull();
    expect(normaliseIndianMobile('98000010021')).toBeNull();
  });

  it('refuses a non-Indian number, because the route it would send over will not carry it', () => {
    expect(normaliseIndianMobile('+14155552671')).toBeNull();
    expect(normaliseIndianMobile('+442071838750')).toBeNull();
  });

  it('has nothing to say about an absent number', () => {
    expect(normaliseIndianMobile(null)).toBeNull();
    expect(normaliseIndianMobile(undefined)).toBeNull();
    expect(normaliseIndianMobile('')).toBeNull();
    expect(normaliseIndianMobile('   ')).toBeNull();
  });

  it('is idempotent, so re-saving a profile cannot corrupt a stored number', () => {
    const once = normaliseIndianMobile('09800001002');
    expect(once).not.toBeNull();
    expect(normaliseIndianMobile(once)).toBe(once);
  });
});

describe('showing a number back', () => {
  it('keeps the country code and the last four digits legible, and nothing else', () => {
    expect(maskMobile('+919800001002')).toBe('+91 ••••••1002');
  });

  it('leaves something too short to mask alone rather than throwing', () => {
    expect(maskMobile('1002')).toBe('1002');
  });
});

describe('the mobile template catalogue', () => {
  const sample: Record<string, string> = {
    name: 'Sneha Iyer',
    outstanding: 'PAN, education certificate',
    document: 'police verification',
    days: '14',
    dates: '12–14 Oct 2026',
    date: '12 Oct 2026',
    outcome: 'approved',
    amount: '₹12,500',
  };

  it('is not empty, and every entry names a real notification type', () => {
    expect(MOBILE_TEMPLATE_IDS.length).toBeGreaterThan(0);
    for (const id of MOBILE_TEMPLATE_IDS) {
      expect(NOTIFICATION_TYPES).toContain(MOBILE_TEMPLATES[id].notificationType);
    }
  });

  it('covers only events that have an in-app notification behind them', () => {
    // Several templates may serve one event — a document that will expire and
    // one that already has are the same notification and two different
    // sentences — but a template for an event nothing raises is dead wording
    // somebody will one day try to send.
    const types = new Set(MOBILE_TEMPLATE_IDS.map((id) => MOBILE_TEMPLATES[id].notificationType));
    expect(types.size).toBeGreaterThan(0);
    for (const type of types) expect(NOTIFICATION_TYPES).toContain(type);
  });

  it('registers each template under a distinct name', () => {
    const names = MOBILE_TEMPLATE_IDS.map((id) => MOBILE_TEMPLATES[id].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses every parameter it declares', () => {
    // The one that bites: WhatsApp fills a template's parameters positionally.
    // A parameter declared but not used in the body means every value after it
    // lands in the wrong slot, and the message is wrong rather than refused.
    for (const id of MOBILE_TEMPLATE_IDS) {
      const template = MOBILE_TEMPLATES[id];
      const sentinels = Object.fromEntries(template.params.map((param) => [param, `<<${param}>>`]));
      const rendered = template.body(sentinels);
      for (const param of template.params) {
        expect(rendered, `${id} never uses ${param}`).toContain(`<<${param}>>`);
      }
    }
  });

  it('names ManagedOps in every message, so an unexpected one is not a mystery', () => {
    for (const id of MOBILE_TEMPLATE_IDS) {
      expect(renderMobileTemplate(id, sample), id).toContain('ManagedOps');
    }
  });

  it('keeps every message inside two SMS segments', () => {
    for (const id of MOBILE_TEMPLATE_IDS) {
      const rendered = renderMobileTemplate(id, sample);
      expect(smsSegments(rendered), `${id} is ${rendered.length} characters`).toBeLessThanOrEqual(
        SMS_MAX_SEGMENTS,
      );
    }
  });

  it('never carries a credential to a phone', () => {
    // A password in a message history on an unlocked phone outlives its
    // usefulness by years. The account-ready message points at the email
    // instead, and this is the assertion that keeps it that way.
    const rendered = renderMobileTemplate('account_ready', sample);
    expect(rendered).not.toMatch(/password/i);
    expect(rendered).toMatch(/email/i);
  });

  it('refuses to render a message with a value missing', () => {
    expect(() => renderMobileTemplate('leave_decided', { name: 'Sneha Iyer' })).toThrow(
      /missing dates, outcome/,
    );
    // An empty string counts as missing: "your leave for  was approved" is not
    // a message worth sending either.
    expect(() =>
      renderMobileTemplate('leave_decided', { name: 'Sneha', dates: '', outcome: 'approved' }),
    ).toThrow(/missing dates/);
  });

  it('hands the provider its values in the declared order', () => {
    expect(mobileTemplateValues('leave_decided', sample)).toEqual([
      'Sneha Iyer',
      '12–14 Oct 2026',
      'approved',
    ]);
  });

  it('lists a purpose per template for the preferences screen', () => {
    const purposes = mobileMessagePurposes();
    expect(purposes).toHaveLength(MOBILE_TEMPLATE_IDS.length);
    expect(purposes.every((purpose) => purpose.length > 0)).toBe(true);
  });
});

describe('counting SMS segments', () => {
  it('charges one segment for anything up to 160 characters, including nothing', () => {
    expect(smsSegments('')).toBe(1);
    expect(smsSegments('a'.repeat(160))).toBe(1);
  });

  it('rolls to a second segment at 161', () => {
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(320))).toBe(2);
    expect(smsSegments('a'.repeat(321))).toBe(3);
  });
});
