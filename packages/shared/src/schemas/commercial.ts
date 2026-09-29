import { z } from 'zod';
import { CLIENT_STATUSES } from '../enums.js';
import { emailSchema, dateStringSchema, paginationSchema, phoneSchema } from './common.js';

/* ----------------------------------------------------------------- clients */

/**
 * A day rate in rupees.
 *
 * Two decimal places, because a rate agreed in paise is a rate somebody will
 * eventually round differently from the database. The ceiling is a typo guard,
 * not a business limit — a day rate above ten lakh is somebody entering an
 * annual figure in the wrong box.
 */
export const dayRateSchema = z
  .number()
  .nonnegative('A rate cannot be negative')
  .max(1_000_000, 'That looks like an annual figure, not a day rate')
  .refine((value) => Number.isInteger(Math.round(value * 100)), 'At most two decimal places');

/** India-only, so the tax identifier is a GSTIN: 15 characters, state code first. */
export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN');

export const createClientSchema = z
  .object({
    name: z.string().trim().min(2, 'Name the client').max(160),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,32}$/, 'Use letters, numbers and hyphens, 2 to 32 characters'),
    contactName: z.string().trim().max(160).optional(),
    contactEmail: emailSchema.optional(),
    contactPhone: phoneSchema.optional(),
    billingAddress: z.string().trim().max(500).optional(),
    gstin: gstinSchema.optional(),
    defaultDayRate: dayRateSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const updateClientSchema = createClientSchema
  .partial()
  .extend({ status: z.enum(CLIENT_STATUSES).optional() })
  .strict();
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const clientQuerySchema = paginationSchema
  .extend({ status: z.enum(CLIENT_STATUSES).optional() })
  .strict();
export type ClientQuery = z.infer<typeof clientQuerySchema>;

/* ----------------------------------------------------------------- billing */

/**
 * How one trainer's days on one assignment are billed.
 *
 * Three answers, not two. A rate, or a stated decision not to bill this work
 * at all, or — the state an assignment starts in — nobody has said yet. The
 * first two are settled; only the third is money going uncollected, and the
 * margin screen can only stop warning about the deliberate ones if the
 * decision is recorded here rather than left in the audit trail.
 *
 * A reason is required to record that decision, and deliberately so: "not
 * billed" with no explanation is indistinguishable a month later from nobody
 * having got round to it, which is the very confusion this exists to end.
 */
export const setBillRateSchema = z
  .object({
    billRatePerDay: dayRateSchema.nullable(),
    notBilledReason: z
      .string()
      .trim()
      .min(4, 'Say why this work is not billed')
      .max(280)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => !(value.billRatePerDay != null && value.notBilledReason), {
    message: 'An assignment is either billed at a rate or deliberately not billed, not both',
    path: ['notBilledReason'],
  });
export type SetBillRateInput = z.infer<typeof setBillRateSchema>;

/**
 * The window a margin is asked for.
 *
 * A month is the natural unit — salary is monthly, so any shorter period would
 * have to prorate a figure nobody quotes that way. `from`/`to` are inclusive
 * calendar dates and default to the current month at the API.
 */
export const marginQuerySchema = z
  .object({
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    clientId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    groupBy: z.enum(['project', 'trainer', 'client']).default('project'),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.to >= value.from, {
    path: ['to'],
    message: 'The end of the period cannot precede its start',
  });
export type MarginQuery = z.infer<typeof marginQuerySchema>;

/**
 * The assignments behind one row of the margin report.
 *
 * A margin row is a roll-up and a rate lives on an assignment, so acting on a
 * thin project means getting from the one to the other. `key` is whatever the
 * row was keyed by — a project, a client or a trainer — which is why the
 * grouping has to come with it rather than being guessed from the id.
 *
 * `undecidedOnly` serves the banner: it names a number of assignments with no
 * rate and no decision, and this is the query that lists exactly those.
 */
export const marginAssignmentsQuerySchema = z
  .object({
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    groupBy: z.enum(['project', 'trainer', 'client']).default('project'),
    /** Omitted when the caller wants every assignment in the period. */
    key: z.string().uuid().optional(),
    undecidedOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.to >= value.from, {
    path: ['to'],
    message: 'The end of the period cannot precede its start',
  });
export type MarginAssignmentsQuery = z.infer<typeof marginAssignmentsQuerySchema>;
