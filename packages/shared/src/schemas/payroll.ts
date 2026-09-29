import { z } from 'zod';
import { PAYROLL_EXPORT_LAYOUT_IDS } from '../payroll-export.js';

/**
 * A payroll month.
 *
 * `YYYY-MM` rather than a pair of dates, because a payroll period is a calendar
 * month and nothing else — offering an arbitrary range would invite somebody to
 * run a fortnight and pay a full month's salary against it.
 */
export const payrollQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month as YYYY-MM')
      .optional(),
    projectId: z.string().uuid().optional(),
    /** Hide the rows that are settled, leaving only what still needs doing. */
    unresolvedOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
export type PayrollQuery = z.infer<typeof payrollQuerySchema>;

/**
 * Exporting a month.
 *
 * `force` exists because refusing outright would be its own failure mode —
 * somebody does occasionally need the file for a month that will never fully
 * settle. It has to be asked for, though, and the file it produces carries
 * every blocker so the choice travels with the data.
 */
export const payrollExportQuerySchema = payrollQuerySchema
  .extend({
    layout: z.enum(PAYROLL_EXPORT_LAYOUT_IDS as [string, ...string[]]).optional(),
    force: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
export type PayrollExportQuery = z.infer<typeof payrollExportQuerySchema>;
