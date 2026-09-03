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
 * Setting what a client pays for one trainer's days.
 *
 * Explicitly nullable, because "this work is not billed" is a real answer and
 * has to be distinguishable from "nobody has said yet". Both arrive as null;
 * the difference is that one of them was chosen, which the audit trail records.
 */
export const setBillRateSchema = z.object({ billRatePerDay: dayRateSchema.nullable() }).strict();
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
