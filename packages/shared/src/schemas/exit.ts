import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  CANDIDATE_SOURCES,
  DEBOARDING_STATUSES,
  FNF_STATUSES,
} from '../enums.js';
import { dateStringSchema, paginationSchema, uuidSchema } from './common.js';

/* -------------------------------------------------------------- deboarding */

/**
 * Starting a deboarding is a statement about one assignment, not one person: a
 * trainer may hold two, and only the one they are leaving is winding down.
 */
export const createDeboardingSchema = z
  .object({
    assignmentId: uuidSchema,
    lastWorkingDay: dateStringSchema,
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export type CreateDeboardingInput = z.infer<typeof createDeboardingSchema>;

/**
 * The checklist, updated a field at a time as each item is settled.
 *
 * `assetsReconciled` is not accepted from the client: it is derived from the
 * asset register, because a checkbox saying the laptop came back is worth
 * nothing next to a row saying it did not.
 */
export const updateDeboardingSchema = z
  .object({
    lastWorkingDay: dateStringSchema.optional(),
    travelNotes: z.string().trim().max(1000).optional(),
    fnfStatus: z.enum(FNF_STATUSES).optional(),
    fnfAmount: z.number().min(0).max(100_000_000).optional(),
    feedback: z.string().trim().max(4000).optional(),
    /** Whether they may be re-engaged later; drives the Talent Pool. */
    rehireEligible: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.fnfStatus !== 'settled' || value.fnfAmount !== undefined, {
    path: ['fnfAmount'],
    message: 'A settled amount has to say how much',
  });
export type UpdateDeboardingInput = z.infer<typeof updateDeboardingSchema>;

export const deboardingQuerySchema = paginationSchema
  .extend({
    projectId: uuidSchema.optional(),
    trainerId: uuidSchema.optional(),
    status: z.enum(DEBOARDING_STATUSES).optional(),
    /** Everything not yet completed — the queue HR works from. */
    open: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type DeboardingQuery = z.infer<typeof deboardingQuerySchema>;

/** What blocks a deboarding from completing, named rather than merely counted. */
export interface DeboardingBlockers {
  outstandingAssets: { id: string; name: string; serialNumber: string | null; status: string }[];
  fnfSettled: boolean;
  canComplete: boolean;
  reasons: string[];
}

/* ------------------------------------------------------------- talent pool */

export const POOL_SOURCES = ['candidate', 'past_trainer'] as const;
export type PoolSource = (typeof POOL_SOURCES)[number];

export const poolQuerySchema = paginationSchema
  .extend({
    source: z.enum(POOL_SOURCES).optional(),
    /** Only people who have actually worked with us before. */
    workedBefore: z.enum(['true', 'false']).optional(),
    lastStatus: z.enum(APPLICATION_STATUSES).optional(),
    positionId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    candidateSource: z.enum(CANDIDATE_SOURCES).optional(),
  })
  .strict();
export type PoolQuery = z.infer<typeof poolQuerySchema>;

/**
 * One row of the Talent Pool.
 *
 * The pool is a query, not a table (spec 15.2): a person cannot be both
 * "rejected at interview" and "in the pool" if those are the same field, and a
 * derived pool can never go stale. `id` is the candidate the entry resolves to,
 * which is what a new application is created against.
 */
export interface PoolEntry {
  id: string;
  source: PoolSource;
  name: string;
  email: string;
  phone: string;
  resumeFileId: string | null;
  workedBefore: boolean;
  /** Where they last got to: an application status, or how they left us. */
  lastStatus: string;
  lastReason: string | null;
  lastPosition: { id: string; title: string } | null;
  lastProject: { id: string; name: string } | null;
  lastSeenAt: string;
  employeeCode: string | null;
}

export const considerForPositionSchema = z.object({ positionId: uuidSchema }).strict();
export type ConsiderForPositionInput = z.infer<typeof considerForPositionSchema>;

/* -------------------------------------------------------------- dashboards */

/** A single number on the dashboard, with where clicking it should lead. */
export interface DashboardTile {
  key: string;
  label: string;
  value: number;
  /** The screen that shows the rows behind the number. */
  href: string;
  tone: 'neutral' | 'positive' | 'pending' | 'critical';
}

/** One thing waiting on the signed-in user specifically. */
export interface ActionItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  since: string;
}

export interface DashboardSummary {
  role: string;
  tiles: DashboardTile[];
  actions: ActionItem[];
  recent: { id: string; action: string; entityType: string; actor: string | null; at: string }[];
}
