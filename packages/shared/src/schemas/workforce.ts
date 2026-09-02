import { z } from 'zod';
import {
  ASSIGNMENT_ROLES,
  DOCUMENT_STATUSES,
  TRAINER_DOCUMENT_TYPES,
  TRAINER_STATUSES,
} from '../enums.js';
import {
  dateStringSchema,
  emailSchema,
  paginationSchema,
  phoneSchema,
  uuidSchema,
} from './common.js';

/* ------------------------------------------------------- offer conversion */

/**
 * Turns an accepted offer into a working trainer: a login, a profile, and a
 * temporary password emailed to the address they applied from. This is the only
 * way a trainer account comes into being, so every trainer has a profile behind
 * their login and a hiring decision behind their profile.
 */
export const convertOfferSchema = z
  .object({
    /** Where the credentials go. Defaults to the email they applied with. */
    personalEmail: emailSchema.optional(),
    /** Assigned by IT; ManagedOps records it rather than creating a mailbox. */
    workEmail: emailSchema.optional(),
    joiningDate: dateStringSchema.optional(),
    /** Assigning them to a project during conversion is the usual path. */
    projectId: uuidSchema.optional(),
    assignmentRole: z.enum(ASSIGNMENT_ROLES).default('trainer'),
  })
  .strict();
export type ConvertOfferInput = z.infer<typeof convertOfferSchema>;

/* ---------------------------------------------------------------- trainers */

export const trainerQuerySchema = paginationSchema
  .extend({
    status: z.enum(TRAINER_STATUSES).optional(),
    projectId: uuidSchema.optional(),
    /** Only those still missing a mandatory document. */
    documentsPending: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type TrainerQuery = z.infer<typeof trainerQuerySchema>;

export const updateTrainerSchema = z
  .object({
    phone: phoneSchema.optional(),
    personalEmail: emailSchema.optional(),
    workEmail: emailSchema.optional(),
    joiningDate: dateStringSchema.optional(),
    salaryAnnual: z.number().positive().max(100_000_000).optional(),
    rehireEligible: z.boolean().optional(),
    travelArrivalDate: dateStringSchema.optional(),
    travelMode: z.string().trim().max(120).optional(),
    travelCost: z.number().nonnegative().max(10_000_000).optional(),
  })
  .strict();
export type UpdateTrainerInput = z.infer<typeof updateTrainerSchema>;

/* --------------------------------------------------------------- documents */

/**
 * Aadhaar and PAN identifiers are never stored in full (spec 15.16). The
 * uploaded document is the proof; four characters are enough to tell two
 * documents apart on a screen. Anything longer is refused here rather than
 * quietly truncated, so nobody believes the full number was captured.
 */
export const uploadDocumentSchema = z
  .object({
    docType: z.enum(TRAINER_DOCUMENT_TYPES),
    fileId: uuidSchema,
    lastFour: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4}$/, 'Enter exactly the last four characters')
      .optional(),
  })
  .strict()
  .refine(
    (value) => !['aadhaar', 'pan'].includes(value.docType) || (value.lastFour?.length ?? 0) === 4,
    {
      path: ['lastFour'],
      message: 'Give the last four characters so this document can be identified later',
    },
  );
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export const verifyDocumentSchema = z
  .object({
    decision: z.enum(['verified', 'rejected']),
    rejectReason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'rejected' || (value.rejectReason?.length ?? 0) > 0, {
    path: ['rejectReason'],
    message: 'Say what is wrong with it, so they know what to re-upload',
  });
export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>;

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);

/* ------------------------------------------------------------- assignments */

export const createAssignmentSchema = z
  .object({
    projectId: uuidSchema,
    role: z.enum(ASSIGNMENT_ROLES).default('trainer'),
    startDate: dateStringSchema,
    endDate: dateStringSchema.optional(),
    /** Per assignment, never carried over (spec assumption A5). */
    leaveAllowanceDays: z.number().min(0).max(30).default(3),
  })
  .strict()
  .refine((value) => !value.endDate || value.endDate >= value.startDate, {
    path: ['endDate'],
    message: 'An assignment cannot end before it starts',
  });
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const endAssignmentSchema = z
  .object({ endDate: dateStringSchema, reason: z.string().trim().max(500).optional() })
  .strict();

export const assignmentQuerySchema = paginationSchema
  .extend({
    projectId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    status: z.enum(['active', 'ended']).optional(),
    role: z.enum(ASSIGNMENT_ROLES).optional(),
  })
  .strict();
export type AssignmentQuery = z.infer<typeof assignmentQuerySchema>;

/* ------------------------------------------------------------------ shapes */

/** What the onboarding checklist reports about one trainer. */
export interface DocumentProgress {
  required: number;
  verified: number;
  pending: number;
  rejected: number;
  missing: string[];
  complete: boolean;
  /** Hours since the account was created, which drives the reminder stages. */
  hoursSinceCreated: number;
}
