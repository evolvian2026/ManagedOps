import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '../src/enums.js';
import {
  CAPABILITIES,
  PERMISSIONS,
  SELF_SERVICE_CAPABILITIES,
  TRAINER_PROFILE_ROLES,
  can,
  capabilitiesFor,
  isGlobalAdmin,
  scopeFor,
  type Capability,
} from '../src/rbac.js';

describe('permission matrix', () => {
  it('defines a grant for every role', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it('only grants capabilities that exist', () => {
    for (const role of ROLES) {
      for (const capability of Object.keys(PERMISSIONS[role])) {
        expect(CAPABILITIES, `${role} grants ${capability}`).toContain(capability);
      }
    }
  });

  it('gives super_admin every administrative capability at full scope', () => {
    for (const capability of CAPABILITIES) {
      if (SELF_SERVICE_CAPABILITIES.includes(capability)) continue;
      expect(scopeFor('super_admin', capability)).toBe('all');
    }
  });

  it('grants self-service actions only to roles that have a trainer profile', () => {
    for (const capability of SELF_SERVICE_CAPABILITIES) {
      const holders = ROLES.filter((role) => can(role, capability));
      expect(holders.sort(), `${capability} needs a trainer profile`).toEqual(
        [...TRAINER_PROFILE_ROLES].sort(),
      );
      for (const role of holders) {
        expect(scopeFor(role, capability), `${role}.${capability}`).toBe('own');
      }
    }
  });

  it('leaves no capability unreachable by every role', () => {
    for (const capability of CAPABILITIES) {
      const holders = ROLES.filter((role) => can(role, capability));
      expect(holders.length, `nobody can ${capability}`).toBeGreaterThan(0);
    }
  });
});

describe('scoped roles stay inside their scope', () => {
  const scopedExpectations: [Role, ('project' | 'own' | 'assigned')[]][] = [
    // A project lead oversees their project and separately acts on their own
    // records as a trainer, so both scopes are legitimate — but never 'all'.
    ['project_lead', ['project', 'own']],
    ['trainer', ['own']],
    ['interviewer', ['assigned']],
  ];

  it.each(scopedExpectations)('%s never holds an organisation-wide grant', (role, allowed) => {
    for (const [capability, scope] of Object.entries(PERMISSIONS[role])) {
      expect(allowed, `${role}.${capability} has scope ${scope}`).toContain(scope);
    }
  });
});

describe('sensitive data boundaries', () => {
  const forbidden: [Role, Capability][] = [
    // Interviewer: assigned interviews and the candidate only (spec 15.6).
    ['interviewer', 'trainers.read_salary'],
    ['interviewer', 'trainers.read_documents'],
    ['interviewer', 'projects.read'],
    ['interviewer', 'offers.read'],
    ['interviewer', 'candidates.manage'],
    ['interviewer', 'interviews.schedule'],
    // Project Lead: oversight without payroll or identity documents. Their own
    // salary is scoped to 'own' and covered separately below.
    ['project_lead', 'trainers.read_documents'],
    ['project_lead', 'trainers.verify_documents'],
    ['project_lead', 'assignments.manage'],
    ['project_lead', 'flags.resolve'],
    ['project_lead', 'pool.read'],
    // Trainer: strictly self-service.
    ['trainer', 'trainers.manage'],
    ['trainer', 'attendance.corrections.approve'],
    ['trainer', 'leave.approve'],
    ['trainer', 'reimbursements.approve'],
    ['trainer', 'audit.read'],
    ['trainer', 'pool.read'],
    // Only a Super Admin administers accounts.
    ['manager', 'users.manage'],
    ['hr', 'users.manage'],
    // Reimbursements above the HR ceiling need a Manager (assumption A4).
    ['hr', 'reimbursements.approve_high_value'],
    // Managers see that documents are verified, not the documents themselves.
    ['manager', 'trainers.read_documents'],
  ];

  it.each(forbidden)('%s cannot %s', (role, capability) => {
    expect(can(role, capability)).toBe(false);
  });
});

describe('grants the product depends on', () => {
  const allowed: [Role, Capability][] = [
    ['hr', 'trainers.verify_documents'],
    ['hr', 'reimbursements.approve'],
    ['manager', 'reimbursements.approve_high_value'],
    ['project_lead', 'leave.approve'],
    ['project_lead', 'flags.raise'],
    ['trainer', 'attendance.punch'],
    ['trainer', 'leave.request'],
    ['trainer', 'trainers.upload_documents'],
    ['interviewer', 'interviews.record_outcome'],
  ];

  it.each(allowed)('%s can %s', (role, capability) => {
    expect(can(role, capability)).toBe(true);
  });

  it('keeps leave requesting away from the roles that approve it', () => {
    for (const role of ['super_admin', 'manager', 'hr'] as const) {
      expect(can(role, 'leave.request'), `${role} should not request leave`).toBe(false);
      expect(can(role, 'leave.approve'), `${role} should approve leave`).toBe(true);
    }
  });

  it('lets a project lead both take leave and approve their team, at different scopes', () => {
    expect(scopeFor('project_lead', 'leave.request')).toBe('own');
    expect(scopeFor('project_lead', 'leave.approve')).toBe('project');
  });

  it('lets a project lead see their own salary but never a colleague', () => {
    expect(scopeFor('project_lead', 'trainers.read_salary')).toBe('own');
  });
});

describe('helpers', () => {
  it('identifies the organisation-wide admin roles', () => {
    expect(ROLES.filter(isGlobalAdmin)).toEqual(['super_admin', 'manager', 'hr']);
  });

  it('lists a role capabilities so the client can hide controls it cannot use', () => {
    const trainerCaps = capabilitiesFor('trainer');
    expect(trainerCaps).toContain('attendance.punch');
    expect(trainerCaps).not.toContain('leave.approve');
    expect(capabilitiesFor('super_admin')).toHaveLength(
      CAPABILITIES.length - SELF_SERVICE_CAPABILITIES.length,
    );
  });
});
