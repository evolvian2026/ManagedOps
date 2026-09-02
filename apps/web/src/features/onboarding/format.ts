import { OPERATIONAL_TIMEZONE } from '@managedops/shared';

/**
 * Everything the business does happens in IST, so every timestamp is rendered
 * in IST and labelled as such. A time shown in the reader's local zone would be
 * the same instant and still the wrong answer to "when is the interview?".
 */
export function formatIst(value: string | Date, style: 'full' | 'short' = 'full'): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) return '—';

  return `${instant.toLocaleString('en-IN', {
    timeZone: OPERATIONAL_TIMEZONE,
    dateStyle: style === 'full' ? 'medium' : 'short',
    timeStyle: 'short',
  })} IST`;
}

export function formatDate(value: string | Date | null): string {
  if (!value) return '—';
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) return '—';

  return instant.toLocaleDateString('en-IN', {
    timeZone: OPERATIONAL_TIMEZONE,
    dateStyle: 'medium',
  });
}

/** Indian digit grouping: 8,40,000 rather than 840,000. */
export function formatInr(amount: string | number): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (Number.isNaN(value)) return '—';

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

/** `interview_scheduled` reads as "Interview scheduled" to a person. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The `datetime-local` input works in the browser's timezone, but the business
 * works in IST. These two convert between them so somebody in any timezone
 * types the IST time they mean and gets exactly that instant.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function toIstInputValue(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

export function fromIstInputValue(value: string): string {
  return new Date(new Date(`${value}:00.000Z`).getTime() - IST_OFFSET_MS).toISOString();
}

/** A sensible default for a scheduling form: tomorrow at 10:00 IST. */
export function defaultInterviewSlot(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const istDate = new Date(tomorrow.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return `${istDate}T10:00`;
}

export const STATUS_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  applied: 'neutral',
  screening: 'pending',
  interviewing: 'pending',
  offer_stage: 'pending',
  hired: 'positive',
  rejected_screening: 'critical',
  rejected_interview: 'critical',
  not_available: 'neutral',
  offer_declined: 'critical',
  withdrawn: 'neutral',

  scheduled: 'pending',
  completed: 'positive',
  missed: 'critical',
  cancelled: 'neutral',

  draft: 'neutral',
  sent: 'pending',
  accepted: 'positive',
  declined: 'critical',
  revision_requested: 'pending',

  open: 'positive',
  filled: 'neutral',
  closed: 'neutral',
};
