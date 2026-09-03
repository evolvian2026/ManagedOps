import { z } from 'zod';

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
