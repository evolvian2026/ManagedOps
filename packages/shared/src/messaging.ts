import type { NotificationType } from './enums.js';

/**
 * Reaching a trainer on their phone.
 *
 * Email is the wrong channel for most of this. A contract trainer between two
 * client sites reads WhatsApp; the work address we created for them on day one
 * may never be opened. So the operational messages — your account is ready,
 * your documents are outstanding, your leave was decided — also go to a phone.
 *
 * The constraint that shapes everything below: **neither channel accepts free
 * text.** WhatsApp Business rejects a business-initiated message that is not an
 * approved template, and an Indian SMS route requires the content to be
 * registered under TRAI's DLT rules before it will carry it. So a mobile message
 * is a template id plus values for its declared parameters, never a string
 * somebody composed at the call site. That is why this catalogue exists, and why
 * the wording lives here rather than beside the code that sends it: what we
 * registered and what we send have to be the same thing.
 */

export const MESSAGING_CHANNELS = ['in_app', 'email', 'whatsapp', 'sms'] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

/** The two channels that reach a phone, in the order they are tried. */
export const MOBILE_CHANNELS = ['whatsapp', 'sms'] as const satisfies readonly MessagingChannel[];
export type MobileChannel = (typeof MOBILE_CHANNELS)[number];

export const MESSAGE_DELIVERY_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

/**
 * A GSM-7 SMS segment. Longer messages still send, as several segments billed
 * separately, so this is a cost ceiling rather than a hard limit — the test
 * suite holds every template to two segments.
 */
export const SMS_SEGMENT_LENGTH = 160;
export const SMS_MAX_SEGMENTS = 2;

export function smsSegments(text: string): number {
  return Math.max(1, Math.ceil(text.length / SMS_SEGMENT_LENGTH));
}

export interface MobileTemplate {
  /**
   * The name this is registered under — the WhatsApp Business template name and
   * the DLT content template it maps to. Sending an unregistered name fails at
   * the provider, so this is a deployment fact, not a label.
   */
  readonly name: string;
  /** The in-app notification this accompanies. One event, one template. */
  readonly notificationType: NotificationType;
  /**
   * Ordered, because WhatsApp substitutes template parameters *positionally*.
   * The names are for the call site's benefit; the order is the contract, and
   * `mobileTemplateValues` is what turns one into the other.
   */
  readonly params: readonly string[];
  /** What somebody is told this channel is for, on the preferences screen. */
  readonly purpose: string;
  /** The registered wording. Sent verbatim as SMS, and mirrors the approved WhatsApp body. */
  readonly body: (values: Readonly<Record<string, string>>) => string;
}

/**
 * Which events are worth a phone message.
 *
 * Deliberately only the six a trainer needs to act on, and none of the
 * administrative ones. An HR escalation or a raised flag lands on somebody at a
 * desk with the app open, and pushing those to a phone would train people to
 * ignore the channel that carries the ones that matter.
 */
export const MOBILE_TEMPLATES = {
  account_ready: {
    name: 'managedops_account_ready',
    notificationType: 'credentials_issued',
    params: ['name'],
    purpose: 'When your account is created',
    // Deliberately carries no password. A credential sent over SMS or WhatsApp
    // lives forever in a message history on an unlocked phone; the email that
    // does carry it is at least addressed to one inbox.
    body: (v) =>
      `Hi ${v.name}, your ManagedOps account is ready. Your sign-in details are in your email.`,
  },
  documents_outstanding: {
    name: 'managedops_documents_outstanding',
    notificationType: 'document_reminder',
    params: ['name', 'outstanding'],
    purpose: 'When onboarding documents are still outstanding',
    body: (v) =>
      `Hi ${v.name}, ManagedOps still needs these documents from you: ${v.outstanding}. Upload them from My Profile. You are not locked out in the meantime.`,
  },
  document_expiring: {
    name: 'managedops_document_expiring',
    notificationType: 'document_expiry',
    params: ['name', 'document', 'days'],
    purpose: 'When a document you have given us is about to lapse',
    body: (v) =>
      `Hi ${v.name}, your ${v.document} on ManagedOps expires in ${v.days} days. Please upload a current one from My Profile.`,
  },
  document_expired: {
    name: 'managedops_document_expired',
    notificationType: 'document_expiry',
    params: ['name', 'document', 'days'],
    purpose: 'When a document you have given us has lapsed',
    // Its own template rather than a tense bent into the one above: "expires in
    // -3 days" is how a message stops being believed. Both are registered, and
    // the sender picks between them on the fact.
    body: (v) =>
      `Hi ${v.name}, your ${v.document} on ManagedOps expired ${v.days} days ago. A client can refuse you site access until it is current. Upload a new one from My Profile.`,
  },
  leave_decided: {
    name: 'managedops_leave_decided',
    notificationType: 'leave_decided',
    params: ['name', 'dates', 'outcome'],
    purpose: 'When a leave request of yours is approved or rejected',
    body: (v) => `Hi ${v.name}, your ManagedOps leave request for ${v.dates} was ${v.outcome}.`,
  },
  correction_decided: {
    name: 'managedops_correction_decided',
    notificationType: 'attendance_correction',
    params: ['name', 'date', 'outcome'],
    purpose: 'When an attendance correction of yours is decided',
    body: (v) =>
      `Hi ${v.name}, your ManagedOps attendance correction for ${v.date} was ${v.outcome}.`,
  },
  claim_decided: {
    name: 'managedops_claim_decided',
    notificationType: 'reimbursement_decided',
    params: ['name', 'amount', 'outcome'],
    purpose: 'When an expense claim of yours is decided',
    body: (v) => `Hi ${v.name}, your ManagedOps expense claim for ${v.amount} was ${v.outcome}.`,
  },
} as const satisfies Record<string, MobileTemplate>;

export type MobileTemplateId = keyof typeof MOBILE_TEMPLATES;
export const MOBILE_TEMPLATE_IDS = Object.keys(MOBILE_TEMPLATES) as MobileTemplateId[];

/** What the preferences screen lists, so nobody has to guess what a toggle turns off. */
export function mobileMessagePurposes(): string[] {
  return MOBILE_TEMPLATE_IDS.map((id) => MOBILE_TEMPLATES[id].purpose);
}

/**
 * The rendered SMS body, with every declared parameter supplied.
 *
 * A missing value throws rather than rendering "undefined" into a message
 * somebody receives — the call site is wrong, and a loud failure at the send
 * point is cheaper than a trainer being told their leave for `undefined` was
 * approved.
 */
export function renderMobileTemplate(
  id: MobileTemplateId,
  values: Readonly<Record<string, string>>,
): string {
  const template: MobileTemplate = MOBILE_TEMPLATES[id];
  const missing = template.params.filter((param) => {
    const value = values[param];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`Template ${id} is missing ${missing.join(', ')}`);
  }
  return template.body(values);
}

/**
 * The same values as a positional array, which is what a WhatsApp template
 * component takes. Derived from the declared order so the two can never drift.
 */
export function mobileTemplateValues(
  id: MobileTemplateId,
  values: Readonly<Record<string, string>>,
): string[] {
  const template: MobileTemplate = MOBILE_TEMPLATES[id];
  return template.params.map((param) => {
    const value = values[param];
    if (value === undefined || value === '') {
      throw new Error(`Template ${id} is missing ${param}`);
    }
    return value;
  });
}

/**
 * An Indian mobile number in E.164, or null if it is not one.
 *
 * People type their number every way there is — with the country code, with a
 * leading zero, with spaces and hyphens — and both providers want exactly
 * `+91` followed by ten digits. Normalising on the way in means the stored
 * number is always sendable, rather than discovering at 2am that a reminder
 * bounced because somebody typed a bracket.
 *
 * Non-Indian numbers are refused rather than passed through: the DLT route this
 * sends over is registered in India and will not carry them, so accepting one
 * would store a number that silently never receives anything. A business that
 * grows past one country needs a second route, not a looser check here.
 */
export function normaliseIndianMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[\s\-()./]/g, '');
  const bare = digits.startsWith('+91')
    ? digits.slice(3)
    : digits.startsWith('91') && digits.length === 12
      ? digits.slice(2)
      : digits.startsWith('0') && digits.length === 11
        ? digits.slice(1)
        : digits;

  // Ten digits, and an Indian mobile series — 6 to 9. A landline reaches
  // neither WhatsApp nor an SMS inbox, so it is not a mobile number for this
  // purpose however valid it is as a phone number.
  if (!/^[6-9]\d{9}$/.test(bare)) return null;
  return `+91${bare}`;
}

/**
 * A stored number shown back without printing all of it into a page or a log.
 *
 * The country code stays legible because every stored number has the same one —
 * hiding it costs a reader context and protects nothing.
 */
export function maskMobile(e164: string): string {
  const indian = /^\+91(\d{6})(\d{4})$/.exec(e164);
  if (indian) return `+91 ••••••${indian[2]}`;
  return e164.length <= 4 ? e164 : `${e164.slice(0, -4).replace(/\d/g, '•')}${e164.slice(-4)}`;
}
