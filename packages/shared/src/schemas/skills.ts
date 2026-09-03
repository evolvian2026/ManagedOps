import { z } from 'zod';
import { PROFICIENCIES, SKILL_REQUIREMENTS, SKILL_STATUSES } from '../enums.js';
import { dateStringSchema, paginationSchema, uuidSchema } from './common.js';

/* -------------------------------------------------------- the catalogue */

/**
 * A skill's name is the thing matching turns on, so it is normalised on the
 * way in rather than trusted. "  react  " and "React" must not become two
 * catalogue entries that never match each other — which is the whole reason
 * this is a catalogue and not a free-text field on the trainer.
 */
export const skillNameSchema = z
  .string()
  .trim()
  .min(2, 'Name the skill')
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 .+#/&'’-]*$/, 'Letters, numbers and . + # / & - are allowed');

export const createSkillSchema = z
  .object({
    name: skillNameSchema,
    category: z.string().trim().max(60).optional(),
  })
  .strict();
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = createSkillSchema
  .partial()
  .extend({ status: z.enum(SKILL_STATUSES).optional() })
  .strict();
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

export const skillQuerySchema = paginationSchema
  .extend({
    status: z.enum(SKILL_STATUSES).optional(),
    category: z.string().trim().max(60).optional(),
  })
  .strict();
export type SkillQuery = z.infer<typeof skillQuerySchema>;

/* ------------------------------------------------------- a trainer's skills */

export const setTrainerSkillSchema = z
  .object({
    skillId: uuidSchema,
    proficiency: z.enum(PROFICIENCIES).default('intermediate'),
    years: z.number().nonnegative().max(60, 'That is more years than a career').optional(),
    lastUsedOn: dateStringSchema.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => !value.lastUsedOn || value.lastUsedOn <= today(), {
    path: ['lastUsedOn'],
    message: 'A skill cannot have been last used in the future',
  });
export type SetTrainerSkillInput = z.infer<typeof setTrainerSkillSchema>;

/* ---------------------------------------------------- a position's needs */

export const setPositionSkillSchema = z
  .object({
    skillId: uuidSchema,
    requirement: z.enum(SKILL_REQUIREMENTS).default('essential'),
    minProficiency: z.enum(PROFICIENCIES).optional(),
  })
  .strict();
export type SetPositionSkillInput = z.infer<typeof setPositionSkillSchema>;

/* ------------------------------------------------------------- the search */

/**
 * Finding somebody to do the work.
 *
 * Either a position — whose requirements are read from the position itself —
 * or an ad-hoc list of skills, because the question is often asked before
 * anybody has opened a requisition.
 */
export const matchQuerySchema = paginationSchema
  .extend({
    positionId: uuidSchema.optional(),
    /** Comma-separated skill ids, for the ad-hoc case. */
    skillIds: z
      .string()
      .trim()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
      )
      .pipe(z.array(uuidSchema).max(20, 'Twenty skills is already more than a shortlist')),
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    /** Hide anybody with no capacity in the window. */
    availableOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    /** Hide anybody missing an essential skill. On by default: they cannot do the job. */
    eligibleOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value !== 'false'),
    projectId: uuidSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.to >= value.from, {
    path: ['to'],
    message: 'The end of the window cannot precede its start',
  });
export type MatchQuery = z.infer<typeof matchQuerySchema>;

/** Today in IST, as the date string the schemas compare against. */
function today(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
