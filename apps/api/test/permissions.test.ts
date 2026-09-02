import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, can, type Capability, type Role } from '@managedops/shared';
import { createHarness, type Harness, type Session } from './harness.js';

/**
 * The permission matrix, executed.
 *
 * Every route below declares the capability it requires; the test then calls it
 * as all six roles and asserts allow or deny against the same shared matrix the
 * guard consults. Because both sides read one source of truth, the documented
 * matrix and the running behaviour cannot drift — and adding a route without
 * thinking about who may call it shows up here immediately.
 */

interface RouteUnderTest {
  method: 'get' | 'post';
  path: string;
  capability: Capability;
  /** Sent for POST routes so a permitted call fails validation, not routing. */
  body?: Record<string, unknown>;
}

const ROUTES: RouteUnderTest[] = [
  { method: 'get', path: '/api/v1/users', capability: 'users.manage' },
  { method: 'get', path: '/api/v1/audit-logs', capability: 'audit.read' },
  { method: 'get', path: '/api/v1/audit-logs/export.csv', capability: 'audit.read' },
  {
    method: 'post',
    path: '/api/v1/users',
    capability: 'users.manage',
    body: { name: 'A New Admin', email: 'new.admin@test.local', role: 'hr' },
  },
];

let harness: Harness;
const sessions = new Map<Role, Session>();

beforeAll(async () => {
  harness = await createHarness();
  await harness.prisma.truncateAll();

  for (const role of ROLES) {
    const user = await harness.seedUser({ role, email: `matrix.${role}@test.local` });
    sessions.set(role, await harness.signIn(user.email));
  }
});

afterAll(async () => {
  // Guarded: if beforeAll failed to boot the app, this would otherwise throw a
  // second, misleading error on top of the real one.
  await harness?.close();
});

describe('every route is reachable by exactly the roles the matrix allows', () => {
  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = can(role, route.capability);
      const label = `${role} ${allowed ? 'may' : 'may not'} ${route.method.toUpperCase()} ${route.path}`;

      it(label, async () => {
        const session = sessions.get(role);
        expect(session, `no session for ${role}`).toBeDefined();

        const call = harness
          .http()
          [route.method](route.path)
          .set('Authorization', `Bearer ${session!.accessToken}`);

        const response = route.body ? await call.send(route.body) : await call;

        if (allowed) {
          // A permitted caller may still be refused on the merits — what must
          // never happen is a 403, which would mean the guard disagreed.
          expect(response.status, `${role} was forbidden but should be allowed`).not.toBe(403);
        } else {
          expect(response.status, `${role} was allowed but should be forbidden`).toBe(403);
          expect(response.body.title).toBe('Not permitted');
          expect(response.body.detail).toContain(role.replace(/_/g, ' '));
        }
      });
    }
  }
});

describe('unauthenticated access', () => {
  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} refuses an anonymous caller`, async () => {
      const call = harness.http()[route.method](route.path);
      const response = route.body ? await call.send(route.body) : await call;
      expect(response.status).toBe(401);
    });
  }
});

describe('the sensitive boundaries the specification calls out', () => {
  const boundaries: [Role, Capability, boolean][] = [
    // Interviewer sees an assigned interview and its candidate, nothing more.
    ['interviewer', 'trainers.read_salary', false],
    ['interviewer', 'trainers.read_documents', false],
    ['interviewer', 'offers.read', false],
    ['interviewer', 'projects.read', false],
    // Project Lead oversees a team without payroll or identity documents.
    ['project_lead', 'trainers.read_documents', false],
    ['project_lead', 'assignments.manage', false],
    ['project_lead', 'leave.approve', true],
    // A manager approves a claim above HR's ceiling; HR does not.
    ['hr', 'reimbursements.approve_high_value', false],
    ['manager', 'reimbursements.approve_high_value', true],
    // Only a super admin administers accounts.
    ['manager', 'users.manage', false],
    ['hr', 'users.manage', false],
  ];

  it.each(boundaries)('%s %s -> %s', (role, capability, expected) => {
    expect(can(role, capability)).toBe(expected);
  });
});
