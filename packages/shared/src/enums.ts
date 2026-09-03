/**
 * Every enum in the system lives here so the API, the database seed, and the
 * web client share one definition. Prisma mirrors these as native Postgres
 * enums; `assertEnumParity` in the API's test suite fails the build if the two
 * ever drift.
 */

export const ROLES = [
  'super_admin',
  'manager',
  'hr',
  'interviewer',
  'project_lead',
  'trainer',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that operate across the whole organisation rather than one project. */
export const GLOBAL_ADMIN_ROLES: readonly Role[] = ['super_admin', 'manager', 'hr'];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * How well somebody knows a skill.
 *
 * Ordered weakest to strongest, and the order is load-bearing: matching
 * compares levels, so `PROFICIENCY_RANK` below is derived from this array
 * rather than written out again.
 */
export const PROFICIENCIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export type Proficiency = (typeof PROFICIENCIES)[number];

/** Where each level sits in that order, for comparing one against another. */
export const PROFICIENCY_RANK: Readonly<Record<Proficiency, number>> = Object.fromEntries(
  PROFICIENCIES.map((level, index) => [level, index]),
) as Record<Proficiency, number>;

export const SKILL_REQUIREMENTS = ['essential', 'desirable'] as const;
export type SkillRequirement = (typeof SKILL_REQUIREMENTS)[number];

export const SKILL_STATUSES = ['active', 'archived'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** A client is either somebody we currently work for or somebody we do not. */
export const CLIENT_STATUSES = ['active', 'inactive'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const PROJECT_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const POSITION_STATUSES = ['open', 'filled', 'closed'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

/** The candidate is the person; their status is deliberately small (spec 15.1). */
export const CANDIDATE_STATUSES = ['active', 'hired', 'archived'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** The application is the person applied to one position — it carries the pipeline. */
export const APPLICATION_STATUSES = [
  'applied',
  'screening',
  'interviewing',
  'offer_stage',
  'hired',
  'rejected_screening',
  'rejected_interview',
  'not_available',
  'offer_declined',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Terminal application states that make a candidate reusable from the pool. */
export const POOL_ELIGIBLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'rejected_screening',
  'rejected_interview',
  'not_available',
  'offer_declined',
];

export const SCREENING_OUTCOMES = ['proceed', 'not_available', 'reject'] as const;
export type ScreeningOutcome = (typeof SCREENING_OUTCOMES)[number];

/** Scheduling state, kept separate from the interview's result. */
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'missed', 'cancelled'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_OUTCOMES = ['pending', 'selected', 'rejected'] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export const OFFER_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'revision_requested',
  'withdrawn',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Employment lifecycle only — never attendance, never flags (spec 15.3). */
export const TRAINER_STATUSES = [
  'pending_onboarding',
  'active',
  'deboarding',
  'deboarded',
  'archived',
] as const;
export type TrainerStatus = (typeof TRAINER_STATUSES)[number];

export const TRAINER_DOCUMENT_TYPES = [
  'aadhaar',
  'pan',
  'education_certificate',
  'experience_certificate',
  'photo',
] as const;
export type TrainerDocumentType = (typeof TRAINER_DOCUMENT_TYPES)[number];

export const MANDATORY_TRAINER_DOCUMENTS: readonly TrainerDocumentType[] = [
  'aadhaar',
  'pan',
  'education_certificate',
];

export const DOCUMENT_STATUSES = ['pending', 'verified', 'rejected'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const ASSIGNMENT_ROLES = ['trainer', 'lead'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_STATUSES = ['active', 'ended'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'missing_punch_out',
  'correction_pending',
  'corrected',
  'absent',
  'on_leave',
  'half_day',
  'leave_without_pay',
  'holiday',
  'weekly_off',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const LOCATION_STATUSES = ['captured', 'unavailable'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const CORRECTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const LEAVE_STATUSES = [
  'submitted',
  'escalated',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const LEAVE_DAY_TYPES = ['full', 'half'] as const;
export type LeaveDayType = (typeof LEAVE_DAY_TYPES)[number];

export const DELIVERABLE_TYPES = ['syllabus', 'other_duty'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const DELIVERABLE_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const ASSET_CATEGORIES = ['hardware', 'accessory', 'digital'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = ['available', 'issued', 'lost', 'damaged', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_ISSUE_STATUSES = ['issued', 'returned', 'lost', 'damaged'] as const;
export type AssetIssueStatus = (typeof ASSET_ISSUE_STATUSES)[number];

export const REIMBURSEMENT_STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'reimbursed',
] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

/** Above this amount (INR) a Manager must approve — spec assumption A4. */
export const HR_REIMBURSEMENT_CEILING_INR = 10_000;

export const FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export const FLAG_STATUSES = ['raised', 'acknowledged', 'action_taken', 'closed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export const FLAG_ACTIONS = ['warning', 'leave_without_pay', 'penalty', 'removal', 'none'] as const;
export type FlagAction = (typeof FLAG_ACTIONS)[number];

export const DEBOARDING_STATUSES = [
  'initiated',
  'assets_pending',
  'fnf_pending',
  'completed',
] as const;
export type DeboardingStatus = (typeof DEBOARDING_STATUSES)[number];

export const FNF_STATUSES = ['pending', 'settled', 'waived'] as const;
export type FnfStatus = (typeof FNF_STATUSES)[number];

export const FILE_SCAN_STATUSES = ['pending', 'clean', 'infected', 'skipped'] as const;
export type FileScanStatus = (typeof FILE_SCAN_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  'interview_reminder',
  'interview_scheduled',
  'offer_sent',
  'credentials_issued',
  'document_reminder',
  'document_escalation',
  'document_rejected',
  'leave_submitted',
  'leave_escalated',
  'leave_decided',
  'attendance_correction',
  'reimbursement_submitted',
  'reimbursement_decided',
  'flag_raised',
  'deboarding_initiated',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const CANDIDATE_SOURCES = [
  'referral',
  'email',
  'whatsapp',
  'job_board',
  'walk_in',
  'pool',
  'other',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
