import { z } from 'zod';
import { REVIEW_SOURCES } from '../enums.js';
import { dateStringSchema, paginationSchema, uuidSchema } from './common.js';

/** One to five. Anything else is a bug, not a low score. */
const ratingSchema = z.number().int().min(1, 'Rate it from 1 to 5').max(5, 'Rate it from 1 to 5');

/**
 * Recording what delivery was like.
 *
 * `respondents` is what separates a cohort's view from one person's, and it is
 * required for learner feedback precisely because a batch summary with no
 * headcount behind it cannot be weighted against anything.
 */
export const createReviewSchema = z
  .object({
    assignmentId: uuidSchema,
    source: z.enum(REVIEW_SOURCES),
    rating: ratingSchema,
    knowledge: ratingSchema.optional(),
    delivery: ratingSchema.optional(),
    professionalism: ratingSchema.optional(),
    respondents: z
      .number()
      .int()
      .min(1, 'A cohort of nobody is not a cohort')
      .max(10_000)
      .optional(),
    comment: z.string().trim().max(2000).optional(),
    observedOn: dateStringSchema,
  })
  .strict()
  .refine((value) => value.source !== 'learner_batch' || value.respondents != null, {
    path: ['respondents'],
    message: 'Say how many learners this covers, or it cannot be weighed against anything',
  })
  .refine((value) => value.observedOn <= todayInIst(), {
    path: ['observedOn'],
    message: 'Feedback cannot be about work that has not happened yet',
  });
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

/**
 * Withdrawing one.
 *
 * A reason is required and there is no way to edit a review instead: the record
 * of something having been said survives, and a correction is a new review.
 */
export const retractReviewSchema = z
  .object({
    reason: z.string().trim().min(10, 'Say why it is being withdrawn').max(500),
  })
  .strict();
export type RetractReviewInput = z.infer<typeof retractReviewSchema>;

export const reviewQuerySchema = paginationSchema
  .extend({
    source: z.enum(REVIEW_SOURCES).optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    /** Retracted reviews are hidden unless asked for; they still happened. */
    includeRetracted: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;

function todayInIst(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
