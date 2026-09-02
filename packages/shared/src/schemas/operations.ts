import { z } from 'zod';
import {
  ASSET_CATEGORIES,
  ATTENDANCE_STATUSES,
  CORRECTION_STATUSES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  FLAG_ACTIONS,
  FLAG_SEVERITIES,
  FLAG_STATUSES,
  LEAVE_DAY_TYPES,
  LEAVE_STATUSES,
  REIMBURSEMENT_STATUSES,
} from '../enums.js';
import {
  dateStringSchema,
  latitudeSchema,
  longitudeSchema,
  paginationSchema,
  uuidSchema,
} from './common.js';

/* -------------------------------------------------------------- attendance */

/**
 * Where the punch happened, when the browser is willing to say.
 *
 * Location is recorded, never enforced: there is no geofence (spec 4.5). A
 * trainer whose browser refuses the permission still punches in successfully,
 * and the record says `unavailable` rather than pretending a location was
 * captured. Sending only one of the two coordinates is refused, because half a
 * position is not a position.
 */
const bothCoordinatesOrNeither = {
  path: ['lng'],
  message: 'Send both coordinates or neither',
};

/** True when a punch names both coordinates or neither of them. */
function locationIsWholeOrAbsent(value: { lat?: number; lng?: number }): boolean {
  return (value.lat === undefined) === (value.lng === undefined);
}

/**
 * Both punch bodies are single flat objects rather than an intersection of a
 * location object and a punch object. An intersection of two `.strict()` shapes
 * rejects every request: each half sees the other half's keys as unrecognised,
 * so the only body that satisfies both is the empty one.
 */
export const punchInSchema = z
  .object({
    lat: latitudeSchema.optional(),
    lng: longitudeSchema.optional(),
    assignmentId: uuidSchema.optional(),
    /** Recorded once, before the first punch of their working life (spec 4.5). */
    locationConsent: z.boolean().optional(),
    notes: z.string().trim().max(280).optional(),
  })
  .strict()
  .refine(locationIsWholeOrAbsent, bothCoordinatesOrNeither);
export type PunchInInput = z.infer<typeof punchInSchema>;

export const punchOutSchema = z
  .object({
    lat: latitudeSchema.optional(),
    lng: longitudeSchema.optional(),
    assignmentId: uuidSchema.optional(),
    notes: z.string().trim().max(280).optional(),
  })
  .strict()
  .refine(locationIsWholeOrAbsent, bothCoordinatesOrNeither);
export type PunchOutInput = z.infer<typeof punchOutSchema>;

export const attendanceQuerySchema = paginationSchema
  .extend({
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.to >= value.from, {
    path: ['to'],
    message: 'The end of the range is before its start',
  });
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

/**
 * A correction asks an approver to rewrite the times on one day.
 *
 * At least one of the two times must be proposed — a request that changes
 * nothing is a note, not a correction — and the reason is mandatory because the
 * approver has no other evidence to decide on.
 */
export const requestCorrectionSchema = z
  .object({
    requestedPunchIn: z.string().datetime({ offset: true }).optional(),
    requestedPunchOut: z.string().datetime({ offset: true }).optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .refine((value) => value.requestedPunchIn ?? value.requestedPunchOut, {
    path: ['requestedPunchIn'],
    message: 'Propose a punch-in time, a punch-out time, or both',
  })
  .refine(
    (value) =>
      !value.requestedPunchIn ||
      !value.requestedPunchOut ||
      value.requestedPunchOut > value.requestedPunchIn,
    { path: ['requestedPunchOut'], message: 'Punch-out must be after punch-in' },
  );
export type RequestCorrectionInput = z.infer<typeof requestCorrectionSchema>;

export const decideCorrectionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reviewNote: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'rejected' || (value.reviewNote?.length ?? 0) > 0, {
    path: ['reviewNote'],
    message: 'Say why it is being rejected, so they know what to do next',
  });
export type DecideCorrectionInput = z.infer<typeof decideCorrectionSchema>;

export const correctionQuerySchema = paginationSchema
  .extend({
    status: z.enum(CORRECTION_STATUSES).optional(),
    projectId: uuidSchema.optional(),
  })
  .strict();
export type CorrectionQuery = z.infer<typeof correctionQuerySchema>;

/* ------------------------------------------------------------------- leave */

export const createLeaveSchema = z
  .object({
    assignmentId: uuidSchema.optional(),
    startDate: dateStringSchema,
    endDate: dateStringSchema,
    dayType: z.enum(LEAVE_DAY_TYPES).default('full'),
    reason: z.string().trim().min(5).max(500),
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    path: ['endDate'],
    message: 'Leave cannot end before it starts',
  })
  .refine((value) => value.dayType !== 'half' || value.startDate === value.endDate, {
    path: ['dayType'],
    message: 'A half day applies to a single date',
  });
export type CreateLeaveInput = z.infer<typeof createLeaveSchema>;

export const decideLeaveSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    decisionNote: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'rejected' || (value.decisionNote?.length ?? 0) > 0, {
    path: ['decisionNote'],
    message: 'Give a reason, so they can plan around the refusal',
  });
export type DecideLeaveInput = z.infer<typeof decideLeaveSchema>;

export const leaveQuerySchema = paginationSchema
  .extend({
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: z.enum(LEAVE_STATUSES).optional(),
    /** Only what this approver can still act on. */
    pending: z.enum(['true', 'false']).optional(),
    /**
     * Restricts the result to the caller's own records.
     *
     * A Project Lead's read capability is project-scoped, so without this their
     * own "My …" screen would list their whole team — correct for an oversight
     * view, wrong for the screen that says "my". It can only narrow: it is
     * combined with the caller's scope under AND, never instead of it.
     */
    mine: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type LeaveQuery = z.infer<typeof leaveQuerySchema>;

/* --------------------------------------------------------------- daily log */

/**
 * One teaching session. `sessionNo` is chosen by the server rather than the
 * client: two tabs open on the same day would otherwise both pick number 2 and
 * one of them would lose to the unique index for no reason the trainer can act
 * on.
 */
export const createDailyLogSchema = z
  .object({
    assignmentId: uuidSchema.optional(),
    workDate: dateStringSchema,
    topic: z.string().trim().min(3).max(200),
    hours: z.number().positive().max(12),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateDailyLogInput = z.infer<typeof createDailyLogSchema>;

export const updateDailyLogSchema = z
  .object({
    topic: z.string().trim().min(3).max(200).optional(),
    hours: z.number().positive().max(12).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type UpdateDailyLogInput = z.infer<typeof updateDailyLogSchema>;

export const unlockDailyLogSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
export type UnlockDailyLogInput = z.infer<typeof unlockDailyLogSchema>;

export const dailyLogQuerySchema = paginationSchema
  .extend({
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    /**
     * Restricts the result to the caller's own records.
     *
     * A Project Lead's read capability is project-scoped, so without this their
     * own "My …" screen would list their whole team — correct for an oversight
     * view, wrong for the screen that says "my". It can only narrow: it is
     * combined with the caller's scope under AND, never instead of it.
     */
    mine: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type DailyLogQuery = z.infer<typeof dailyLogQuerySchema>;

/* ------------------------------------------------------------ deliverables */

export const createDeliverableSchema = z
  .object({
    assignmentId: uuidSchema,
    type: z.enum(DELIVERABLE_TYPES).default('syllabus'),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(2000).optional(),
    dueDate: dateStringSchema.optional(),
  })
  .strict();
export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;

export const updateDeliverableSchema = z
  .object({
    status: z.enum(DELIVERABLE_STATUSES).optional(),
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    dueDate: dateStringSchema.optional(),
    /** Evidence of the work, optional by design (spec 2.3). */
    fileId: uuidSchema.nullable().optional(),
  })
  .strict();
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;

export const deliverableQuerySchema = paginationSchema
  .extend({
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    type: z.enum(DELIVERABLE_TYPES).optional(),
    status: z.enum(DELIVERABLE_STATUSES).optional(),
    /**
     * Restricts the result to the caller's own records.
     *
     * A Project Lead's read capability is project-scoped, so without this their
     * own "My …" screen would list their whole team — correct for an oversight
     * view, wrong for the screen that says "my". It can only narrow: it is
     * combined with the caller's scope under AND, never instead of it.
     */
    mine: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type DeliverableQuery = z.infer<typeof deliverableQuerySchema>;

/* ------------------------------------------------------------------ assets */

/**
 * Hardware carries a serial number and digital resources do not — a work email
 * account has no serial to reconcile on return, and inventing one would make the
 * return check meaningless.
 */
export const createAssetSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    category: z.enum(ASSET_CATEGORIES),
    serialNumber: z.string().trim().min(3).max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((value) => value.category === 'digital' || Boolean(value.serialNumber), {
    path: ['serialNumber'],
    message: 'Hardware and accessories are tracked by serial number',
  });
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const issueAssetSchema = z
  .object({
    assignmentId: uuidSchema,
    /** Re-typed at issue and compared on return (spec 4.8). */
    issueSerial: z.string().trim().min(3).max(120).optional(),
    issueNotes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type IssueAssetInput = z.infer<typeof issueAssetSchema>;

export const returnAssetSchema = z
  .object({
    condition: z.enum(['returned', 'lost', 'damaged']).default('returned'),
    returnSerial: z.string().trim().min(3).max(120).optional(),
    returnNotes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((value) => value.condition === 'returned' || (value.returnNotes?.length ?? 0) > 0, {
    path: ['returnNotes'],
    message: 'Describe what happened to it',
  });
export type ReturnAssetInput = z.infer<typeof returnAssetSchema>;

export const assetQuerySchema = paginationSchema
  .extend({
    category: z.enum(ASSET_CATEGORIES).optional(),
    status: z.enum(['available', 'issued', 'lost', 'damaged', 'retired']).optional(),
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
  })
  .strict();
export type AssetQuery = z.infer<typeof assetQuerySchema>;

/* ---------------------------------------------------------- reimbursements */

export const REIMBURSEMENT_CATEGORIES = [
  'travel',
  'accommodation',
  'meals',
  'materials',
  'other',
] as const;
export type ReimbursementCategory = (typeof REIMBURSEMENT_CATEGORIES)[number];

export const createReimbursementSchema = z
  .object({
    assignmentId: uuidSchema.optional(),
    category: z.enum(REIMBURSEMENT_CATEGORIES),
    amount: z.number().positive().max(1_000_000),
    description: z.string().trim().min(5).max(1000),
    /** Mandatory: a claim without proof cannot be assessed (spec 4.7). */
    proofFileId: uuidSchema,
  })
  .strict();
export type CreateReimbursementInput = z.infer<typeof createReimbursementSchema>;

export const decideReimbursementSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reviewNote: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'rejected' || (value.reviewNote?.length ?? 0) > 0, {
    path: ['reviewNote'],
    message: 'A rejected claim must say why',
  });
export type DecideReimbursementInput = z.infer<typeof decideReimbursementSchema>;

export const markPaidSchema = z
  .object({ reference: z.string().trim().max(120).optional() })
  .strict();
export type MarkPaidInput = z.infer<typeof markPaidSchema>;

export const reimbursementQuerySchema = paginationSchema
  .extend({
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: z.enum(REIMBURSEMENT_STATUSES).optional(),
    category: z.enum(REIMBURSEMENT_CATEGORIES).optional(),
  })
  .strict();
export type ReimbursementQuery = z.infer<typeof reimbursementQuerySchema>;

/* ------------------------------------------------------------------- flags */

export const createFlagSchema = z
  .object({
    assignmentId: uuidSchema,
    severity: z.enum(FLAG_SEVERITIES).default('medium'),
    description: z.string().trim().min(10).max(2000),
  })
  .strict();
export type CreateFlagInput = z.infer<typeof createFlagSchema>;

export const resolveFlagSchema = z
  .object({
    actionTaken: z.enum(FLAG_ACTIONS),
    resolutionNote: z.string().trim().min(5).max(2000),
  })
  .strict();
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;

export const flagQuerySchema = paginationSchema
  .extend({
    assignmentId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    status: z.enum(FLAG_STATUSES).optional(),
    severity: z.enum(FLAG_SEVERITIES).optional(),
    /** Everything not yet closed — the queue an approver works from. */
    open: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type FlagQuery = z.infer<typeof flagQuerySchema>;

/* ------------------------------------------------------------------ shapes */

/** What a trainer's home screen needs to render the punch card. */
export interface TodayState {
  workDate: string;
  assignment: { id: string; projectName: string; workStartTime: string; graceMinutes: number };
  attendance: {
    id: string;
    status: string;
    punchInAt: string | null;
    punchOutAt: string | null;
  } | null;
  /** Which punch, if any, is available right now — and why not, when it is not. */
  action: 'punch_in' | 'punch_out' | 'done' | 'not_working';
  reason: string | null;
  locationConsentGiven: boolean;
}
