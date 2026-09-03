import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  CANDIDATE_SOURCES,
  INTERVIEW_OUTCOMES,
  INTERVIEW_STATUSES,
  OFFER_STATUSES,
  POSITION_STATUSES,
  PROJECT_STATUSES,
  SCREENING_OUTCOMES,
} from '../enums.js';
import {
  clockTimeSchema,
  dateStringSchema,
  emailSchema,
  paginationSchema,
  phoneSchema,
  uuidSchema,
} from './common.js';

/* ------------------------------------------------------------------ projects */

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(3, 'Give the project a name').max(160),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,32}$/, 'Use letters, numbers and hyphens, 3 to 32 characters'),
    clientId: uuidSchema,
    location: z.string().trim().max(160).optional(),
    startDate: dateStringSchema,
    endDate: dateStringSchema.optional(),
    managerId: uuidSchema,
    hrId: uuidSchema,
    leadTrainerId: uuidSchema.optional(),
    workStartTime: clockTimeSchema.default('09:00'),
    graceMinutes: z.number().int().min(0).max(120).default(15),
    /** 0 is Sunday. Defaults to a six-day week. */
    weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7).default([0]),
  })
  .strict()
  .refine((value) => !value.endDate || value.endDate >= value.startDate, {
    path: ['endDate'],
    message: 'A project cannot end before it starts',
  });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema
  .innerType()
  .partial()
  .omit({ code: true })
  .extend({ status: z.enum(PROJECT_STATUSES).optional() })
  .strict();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectQuerySchema = paginationSchema
  .extend({
    status: z.enum(PROJECT_STATUSES).optional(),
    managerId: uuidSchema.optional(),
    hrId: uuidSchema.optional(),
  })
  .strict();
export type ProjectQuery = z.infer<typeof projectQuerySchema>;

export const createHolidaySchema = z
  .object({
    date: dateStringSchema,
    name: z.string().trim().min(2).max(120),
  })
  .strict();

/* ----------------------------------------------------------------- positions */

export const createPositionSchema = z
  .object({
    projectId: uuidSchema,
    title: z.string().trim().min(3, 'Give the position a title').max(160),
    headcount: z.number().int().min(1, 'At least one').max(200).default(1),
    description: z.string().trim().max(4000).optional(),
  })
  .strict();
export type CreatePositionInput = z.infer<typeof createPositionSchema>;

export const updatePositionSchema = createPositionSchema
  .partial()
  .omit({ projectId: true })
  .strict();
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;

export const positionQuerySchema = paginationSchema
  .extend({
    projectId: uuidSchema.optional(),
    status: z.enum(POSITION_STATUSES).optional(),
  })
  .strict();
export type PositionQuery = z.infer<typeof positionQuerySchema>;

/* ---------------------------------------------------------------- candidates */

export const createCandidateSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter their full name').max(160),
    email: emailSchema,
    phone: phoneSchema,
    linkedinUrl: z.string().trim().url('Enter a full URL').max(300).optional(),
    source: z.enum(CANDIDATE_SOURCES).default('other'),
    /** Mandatory at intake (spec 7.2); the id of a confirmed upload. */
    resumeFileId: uuidSchema,
    notes: z.string().trim().max(4000).optional(),
    /** Applying them to a position at the same time is the usual path. */
    positionId: uuidSchema.optional(),
  })
  .strict();
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;

export const updateCandidateSchema = createCandidateSchema
  .partial()
  .omit({ positionId: true, resumeFileId: true })
  .extend({
    resumeFileId: uuidSchema.optional(),
    poolEligible: z.boolean().optional(),
  })
  .strict();
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;

export const candidateQuerySchema = paginationSchema
  .extend({
    source: z.enum(CANDIDATE_SOURCES).optional(),
    poolEligible: z.enum(['true', 'false']).optional(),
    workedBefore: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type CandidateQuery = z.infer<typeof candidateQuerySchema>;

/* -------------------------------------------------------------- applications */

export const createApplicationSchema = z
  .object({
    candidateId: uuidSchema,
    positionId: uuidSchema,
  })
  .strict();
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

/**
 * The screening call outcome. This one field routes the whole pipeline:
 * proceed sends them to interviews, the other two close the application and
 * leave the person in the pool.
 */
export const screenApplicationSchema = z
  .object({
    outcome: z.enum(SCREENING_OUTCOMES),
    notes: z.string().trim().max(2000).optional(),
    /** Required when rejecting, so the pool entry carries a reason. */
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => value.outcome !== 'reject' || (value.reason?.length ?? 0) > 0, {
    path: ['reason'],
    message: 'Give a reason when rejecting, so the pool entry explains itself',
  });
export type ScreenApplicationInput = z.infer<typeof screenApplicationSchema>;

export const applicationQuerySchema = paginationSchema
  .extend({
    positionId: uuidSchema.optional(),
    candidateId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: z.enum(APPLICATION_STATUSES).optional(),
  })
  .strict();
export type ApplicationQuery = z.infer<typeof applicationQuerySchema>;

/* ---------------------------------------------------------------- interviews */

/**
 * Interview times are entered and displayed in IST but travel as an ISO instant,
 * so there is exactly one moment in question and no timezone to misread.
 */
export const scheduleInterviewSchema = z
  .object({
    applicationId: uuidSchema,
    scheduledAt: z.coerce.date(),
    durationMinutes: z.number().int().min(10).max(480).default(45),
    meetingUrl: z.string().trim().url('Enter the full meeting link').max(500).optional(),
    interviewerId: uuidSchema.optional(),
  })
  .strict();
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;

export const updateInterviewSchema = z
  .object({
    scheduledAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(10).max(480).optional(),
    meetingUrl: z.string().trim().url().max(500).optional(),
    interviewerId: uuidSchema.optional(),
  })
  .strict();
export type UpdateInterviewInput = z.infer<typeof updateInterviewSchema>;

export const interviewOutcomeSchema = z
  .object({
    outcome: z.enum(['selected', 'rejected']),
    feedback: z.string().trim().min(1, 'Record what happened').max(4000),
    recordingUrl: z.string().trim().url().max(500).optional(),
  })
  .strict();
export type InterviewOutcomeInput = z.infer<typeof interviewOutcomeSchema>;

/** Rescheduling creates a new round linked to the missed one (spec 4.2). */
export const rescheduleInterviewSchema = z
  .object({
    scheduledAt: z.coerce.date(),
    meetingUrl: z.string().trim().url().max(500).optional(),
    interviewerId: uuidSchema.optional(),
  })
  .strict();
export type RescheduleInterviewInput = z.infer<typeof rescheduleInterviewSchema>;

export const interviewQuerySchema = paginationSchema
  .extend({
    positionId: uuidSchema.optional(),
    applicationId: uuidSchema.optional(),
    interviewerId: uuidSchema.optional(),
    status: z.enum(INTERVIEW_STATUSES).optional(),
    outcome: z.enum(INTERVIEW_OUTCOMES).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    includeArchived: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type InterviewQuery = z.infer<typeof interviewQuerySchema>;

/* -------------------------------------------------------------------- offers */

export const createOfferSchema = z
  .object({
    applicationId: uuidSchema,
    salaryAnnual: z.number().positive('Enter the annual salary').max(100_000_000),
    joiningDate: dateStringSchema,
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

export const sendOfferSchema = z
  .object({
    /** Optional copy of the letter that was sent out of band (spec 15.15). */
    attachmentFileId: uuidSchema.optional(),
  })
  .strict();

export const respondToOfferSchema = z
  .object({
    response: z.enum(['accepted', 'declined', 'revision_requested']),
    notes: z.string().trim().max(2000).optional(),
    respondedAt: z.coerce.date().optional(),
  })
  .strict();
export type RespondToOfferInput = z.infer<typeof respondToOfferSchema>;

export const reviseOfferSchema = z
  .object({
    salaryAnnual: z.number().positive().max(100_000_000),
    joiningDate: dateStringSchema,
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ReviseOfferInput = z.infer<typeof reviseOfferSchema>;

export const offerQuerySchema = paginationSchema
  .extend({
    status: z.enum(OFFER_STATUSES).optional(),
    applicationId: uuidSchema.optional(),
    positionId: uuidSchema.optional(),
    /** Only the newest version of each offer, which is what the UI lists. */
    latestOnly: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type OfferQuery = z.infer<typeof offerQuerySchema>;
