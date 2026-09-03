import { GLOBAL_ADMIN_ROLES, type Role } from './enums.js';

/**
 * The permission matrix from the specification, expressed as data.
 *
 * The API enforces it through a guard and the test suite walks every cell, so
 * the documented matrix and the running behaviour cannot drift apart. Access is
 * granted by capability, never by checking a role inline in a service.
 */

export const CAPABILITIES = [
  'users.manage',
  'settings.read',
  'settings.manage',
  'audit.read',
  'clients.read',
  'clients.manage',
  'billing.read',
  'billing.manage',
  'skills.read',
  'skills.manage',
  'skills.catalogue',
  'matching.read',
  'payroll.read',
  'projects.read',
  'projects.manage',
  'positions.read',
  'positions.manage',
  'candidates.read',
  'candidates.manage',
  'applications.screen',
  'interviews.read',
  'interviews.schedule',
  'interviews.record_outcome',
  'offers.read',
  'offers.manage',
  'trainers.read',
  'trainers.manage',
  'trainers.read_salary',
  'trainers.read_documents',
  'trainers.upload_documents',
  'trainers.verify_documents',
  'assignments.read',
  'assignments.manage',
  'attendance.read',
  'attendance.punch',
  'attendance.corrections.approve',
  'dailylogs.read',
  'dailylogs.write',
  'dailylogs.unlock',
  'deliverables.read',
  'deliverables.write',
  'leave.request',
  'leave.approve',
  'assets.read',
  'assets.manage',
  'reimbursements.submit',
  'reimbursements.approve',
  'reimbursements.approve_high_value',
  'reimbursements.mark_paid',
  'flags.raise',
  'flags.resolve',
  'deboarding.read',
  'deboarding.manage',
  'pool.read',
  'pool.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * How far a granted capability reaches.
 *  - `all`     every record in the organisation
 *  - `project` only records belonging to a project the user leads
 *  - `own`     only records belonging to the user themselves
 *  - `assigned` only records the user is individually named on (interviewers)
 *
 * A guard checks the capability; the data layer then applies the scope as a
 * query predicate, so a scoped user cannot read outside their scope even if a
 * route were mis-annotated.
 */
export type Scope = 'all' | 'project' | 'own' | 'assigned';

export type Grant = Partial<Record<Capability, Scope>>;

const ALL = 'all' as const;

function grantAll(...caps: Capability[]): Grant {
  return Object.fromEntries(caps.map((c) => [c, ALL])) as Grant;
}

/**
 * Actions that only make sense performed on your own trainer record. An
 * administrator has no assignment to punch into, no leave balance to spend and
 * no onboarding documents of their own, so granting these to an admin role
 * would describe something the product cannot do.
 */
export const SELF_SERVICE_CAPABILITIES: readonly Capability[] = [
  'attendance.punch',
  'leave.request',
  'reimbursements.submit',
  'trainers.upload_documents',
];

/** The roles that come with a trainer profile, and so can act on their own records. */
export const TRAINER_PROFILE_ROLES: readonly Role[] = ['project_lead', 'trainer'];

/** Everything except the self-service actions, which need a trainer profile. */
const SUPER_ADMIN: Grant = grantAll(
  ...CAPABILITIES.filter((capability) => !SELF_SERVICE_CAPABILITIES.includes(capability)),
);

const MANAGER: Grant = {
  ...grantAll(
    'settings.read',
    'audit.read',
    // Commerce is Manager and Super Admin only. HR reads the client
    // directory because they staff against it, but rates and margin are
    // not theirs. A Finance role, if one is ever added, would take
    // `billing.read` without `clients.manage` — which is why these are
    // four capabilities and not one.
    'clients.read',
    'clients.manage',
    'billing.read',
    'billing.manage',
    'skills.read',
    'skills.manage',
    'skills.catalogue',
    'matching.read',
    'payroll.read',
    'projects.read',
    'projects.manage',
    'positions.read',
    'positions.manage',
    'candidates.read',
    'candidates.manage',
    'applications.screen',
    'interviews.read',
    'interviews.schedule',
    'interviews.record_outcome',
    'offers.read',
    'offers.manage',
    'trainers.read',
    'trainers.manage',
    'trainers.read_salary',
    'assignments.read',
    'assignments.manage',
    'attendance.read',
    'attendance.corrections.approve',
    'dailylogs.read',
    'dailylogs.unlock',
    'deliverables.read',
    'deliverables.write',
    'leave.approve',
    'assets.read',
    'assets.manage',
    'reimbursements.approve',
    'reimbursements.approve_high_value',
    'reimbursements.mark_paid',
    'flags.raise',
    'flags.resolve',
    'deboarding.read',
    'deboarding.manage',
    'pool.read',
    'pool.manage',
  ),
  // A Manager may see that documents exist and whether they are verified, but
  // opening an identity document is HR's job (spec 3.3).
  'trainers.read_documents': undefined,
};

const HR: Grant = grantAll(
  'settings.read',
  // The directory, so they can staff against it. Not the rates on it.
  'clients.read',
  // Staffing is HR's job, so finding who fits is theirs too.
  'skills.read',
  'skills.manage',
  'skills.catalogue',
  'matching.read',
  // HR runs the month end, so the register is theirs.
  'payroll.read',
  'audit.read',
  'projects.read',
  'positions.read',
  'positions.manage',
  'candidates.read',
  'candidates.manage',
  'applications.screen',
  'interviews.read',
  'interviews.schedule',
  'interviews.record_outcome',
  'offers.read',
  'offers.manage',
  'trainers.read',
  'trainers.manage',
  'trainers.read_salary',
  'trainers.read_documents',
  'trainers.verify_documents',
  'assignments.read',
  'assignments.manage',
  'attendance.read',
  'attendance.corrections.approve',
  'dailylogs.read',
  'deliverables.read',
  'deliverables.write',
  'leave.approve',
  'assets.read',
  'assets.manage',
  'reimbursements.approve',
  'reimbursements.mark_paid',
  'flags.raise',
  'flags.resolve',
  'deboarding.read',
  'deboarding.manage',
  'pool.read',
  'pool.manage',
);

/**
 * Deliberately narrow (spec 15.6). The reference documents called Interviewer an
 * "Admin User able to manage everything" while separately questioning whether
 * they should see salary or Aadhaar at all; both cannot hold. An interviewer
 * gets exactly what conducting and recording an interview requires.
 */
const INTERVIEWER: Grant = {
  'interviews.read': 'assigned',
  'interviews.record_outcome': 'assigned',
  'candidates.read': 'assigned',
};

/**
 * A project lead is a trainer who also oversees their project's team, so they
 * hold two sets of grants: oversight scoped to the project, and the same
 * self-service actions any trainer has, scoped to their own records. They still
 * cannot add or remove trainers, and never see a colleague's salary.
 */
const PROJECT_LEAD: Grant = {
  // Oversight of the project they lead.
  'projects.read': 'project',
  'positions.read': 'project',
  'trainers.read': 'project',
  'skills.read': 'project',
  'assignments.read': 'project',
  'attendance.read': 'project',
  'attendance.corrections.approve': 'project',
  'dailylogs.read': 'project',
  'deliverables.read': 'project',
  'deliverables.write': 'project',
  'leave.approve': 'project',
  'assets.read': 'project',
  'flags.raise': 'project',
  'deboarding.read': 'project',
  // Their own working life, exactly as a trainer has it.
  'trainers.read_salary': 'own',
  'trainers.upload_documents': 'own',
  'skills.manage': 'own',
  'attendance.punch': 'own',
  'dailylogs.write': 'own',
  'leave.request': 'own',
  'reimbursements.submit': 'own',
};

/**
 * A trainer's own working life, and nothing else.
 *
 * `deboarding.read` is deliberately absent. Nothing in the product shows a
 * trainer their own exit checklist, and a capability no screen serves buys
 * nothing except a "Deboarding" entry in their sidebar that opens an
 * administrator's queue. If a trainer-facing exit summary is ever built, the
 * capability comes back with the screen.
 */
const TRAINER: Grant = {
  'trainers.read': 'own',
  'trainers.read_salary': 'own',
  'trainers.upload_documents': 'own',
  // A trainer keeps their own skills current; nobody else knows them better.
  'skills.read': 'own',
  'skills.manage': 'own',
  'assignments.read': 'own',
  'attendance.read': 'own',
  'attendance.punch': 'own',
  'dailylogs.read': 'own',
  'dailylogs.write': 'own',
  'deliverables.read': 'own',
  'deliverables.write': 'own',
  'leave.request': 'own',
  'assets.read': 'own',
  'reimbursements.submit': 'own',
};

export const PERMISSIONS: Readonly<Record<Role, Grant>> = {
  super_admin: SUPER_ADMIN,
  manager: MANAGER,
  hr: HR,
  interviewer: INTERVIEWER,
  project_lead: PROJECT_LEAD,
  trainer: TRAINER,
};

export function scopeFor(role: Role, capability: Capability): Scope | null {
  return PERMISSIONS[role][capability] ?? null;
}

export function can(role: Role, capability: Capability): boolean {
  return scopeFor(role, capability) !== null;
}

export function isGlobalAdmin(role: Role): boolean {
  return GLOBAL_ADMIN_ROLES.includes(role);
}

/** Capabilities a role holds, for the client to hide controls it cannot use. */
export function capabilitiesFor(role: Role): Capability[] {
  return Object.entries(PERMISSIONS[role])
    .filter(([, scope]) => scope != null)
    .map(([cap]) => cap as Capability);
}
