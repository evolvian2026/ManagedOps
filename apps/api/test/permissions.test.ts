import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import { ROLES, can, type Capability, type Role } from '@managedops/shared';
import { CAPABILITY_KEY, IS_PUBLIC_KEY } from '../src/common/decorators/index.js';
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
  /**
   * The capabilities the route declares. Any one of them admits the caller,
   * exactly as the guard decides it — a few endpoints serve two audiences
   * through one URL, and modelling that as a single capability here would make
   * the test disagree with the thing it is testing.
   */
  capabilities: Capability[];
  /** Sent for POST routes so a permitted call fails validation, not routing. */
  body?: Record<string, unknown>;
}

/**
 * Every capability-guarded route in the product.
 *
 * A route missing from this list is a route nobody has decided who may call —
 * which is why the suite also asserts the list covers the whole surface, rather
 * than trusting that anyone adding an endpoint remembers to come back here.
 */
const ROUTES: RouteUnderTest[] = [
  // Platform
  { method: 'get', path: '/api/v1/users', capabilities: ['users.manage'] },
  {
    method: 'post',
    path: '/api/v1/users',
    capabilities: ['users.manage'],
    body: { name: 'A New Admin', email: 'new.admin@test.local', role: 'hr' },
  },
  { method: 'get', path: '/api/v1/audit-logs', capabilities: ['audit.read'] },
  { method: 'get', path: '/api/v1/audit-logs/export.csv', capabilities: ['audit.read'] },

  // Projects and positions
  { method: 'get', path: '/api/v1/projects', capabilities: ['projects.read'] },
  { method: 'post', path: '/api/v1/projects', capabilities: ['projects.manage'], body: {} },
  { method: 'get', path: '/api/v1/positions', capabilities: ['positions.read'] },
  { method: 'post', path: '/api/v1/positions', capabilities: ['positions.manage'], body: {} },

  // Recruitment
  { method: 'get', path: '/api/v1/candidates', capabilities: ['candidates.read'] },
  { method: 'post', path: '/api/v1/candidates', capabilities: ['candidates.manage'], body: {} },
  { method: 'get', path: '/api/v1/applications', capabilities: ['candidates.read'] },
  { method: 'get', path: '/api/v1/interviews', capabilities: ['interviews.read'] },
  { method: 'post', path: '/api/v1/interviews', capabilities: ['interviews.schedule'], body: {} },
  { method: 'get', path: '/api/v1/offers', capabilities: ['offers.read'] },
  { method: 'post', path: '/api/v1/offers', capabilities: ['offers.manage'], body: {} },

  // Workforce
  { method: 'get', path: '/api/v1/trainers', capabilities: ['trainers.read'] },
  { method: 'get', path: '/api/v1/assignments', capabilities: ['assignments.read'] },

  // Attendance
  { method: 'get', path: '/api/v1/attendance', capabilities: ['attendance.read'] },
  {
    method: 'post',
    path: '/api/v1/attendance/punch-in',
    capabilities: ['attendance.punch'],
    body: {},
  },
  {
    method: 'post',
    path: '/api/v1/attendance/punch-out',
    capabilities: ['attendance.punch'],
    body: {},
  },
  { method: 'get', path: '/api/v1/attendance/today', capabilities: ['attendance.punch'] },
  {
    method: 'get',
    path: '/api/v1/attendance/corrections',
    capabilities: ['attendance.corrections.approve'],
  },

  // Leave, logs, deliverables
  { method: 'post', path: '/api/v1/leave-requests', capabilities: ['leave.request'], body: {} },
  { method: 'get', path: '/api/v1/daily-logs', capabilities: ['dailylogs.read'] },
  { method: 'post', path: '/api/v1/daily-logs', capabilities: ['dailylogs.write'], body: {} },
  { method: 'get', path: '/api/v1/deliverables', capabilities: ['deliverables.read'] },
  { method: 'post', path: '/api/v1/deliverables', capabilities: ['deliverables.write'], body: {} },

  // Assets, claims, flags
  { method: 'get', path: '/api/v1/assets', capabilities: ['assets.read'] },
  { method: 'post', path: '/api/v1/assets', capabilities: ['assets.manage'], body: {} },
  {
    method: 'post',
    path: '/api/v1/reimbursements',
    capabilities: ['reimbursements.submit'],
    body: {},
  },
  { method: 'post', path: '/api/v1/flags', capabilities: ['flags.raise'], body: {} },
  {
    method: 'post',
    path: '/api/v1/trainers/00000000-0000-4000-8000-000000000000/documents',
    capabilities: ['trainers.upload_documents', 'trainers.verify_documents'],
    body: {},
  },

  // Exit and re-use
  { method: 'get', path: '/api/v1/deboardings', capabilities: ['deboarding.read'] },
  { method: 'get', path: '/api/v1/deboardings/export.csv', capabilities: ['deboarding.read'] },
  { method: 'post', path: '/api/v1/deboardings', capabilities: ['deboarding.manage'], body: {} },
  { method: 'get', path: '/api/v1/pool', capabilities: ['pool.read'] },
  { method: 'get', path: '/api/v1/pool/export.csv', capabilities: ['pool.read'] },
];

/**
 * Routes deliberately reachable by any signed-in caller, and why.
 *
 * Naming them here is what lets the coverage check below be strict: an endpoint
 * that is neither capability-guarded nor listed as intentionally open is a
 * mistake, not a decision.
 */
const OPEN_TO_ANY_SIGNED_IN_USER = new Map<string, string>([
  ['GET /api/v1/auth/me', 'who am I — the client needs it before anything else'],
  ['POST /api/v1/auth/change-password', 'reachable while a temporary password is in force'],
  ['GET /api/v1/notifications', 'each caller only ever sees their own'],
  ['POST /api/v1/notifications/:id/read', 'scoped to the caller in the query itself'],
  ['POST /api/v1/notifications/read-all', 'scoped to the caller in the query itself'],
  ['GET /api/v1/dashboard/summary', 'shaped by the capabilities the caller holds'],
  ['POST /api/v1/files/upload-url', 'anyone may upload; what they may attach it to is checked'],
  ['POST /api/v1/files/:id/confirm', 'only the uploader may confirm their own upload'],
  ['GET /api/v1/files/:id/download-url', 'authorised against the record the file belongs to'],
]);

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
      const allowed = route.capabilities.some((capability) => can(role, capability));
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

/**
 * The list above is a sample; this is the check that makes it safe to be one.
 *
 * Every controller handler in the running application is inspected for the
 * metadata the guard reads. A handler that declares no capability, is not
 * `@Public()`, and is not named below as intentionally open is an endpoint
 * whose audience nobody decided — which is exactly what left
 * `GET /files/:id/download-url` authorising nothing at all.
 *
 * Walking the container rather than a hand-written list is the point: a route
 * added tomorrow is covered without anyone remembering to come back here.
 */
describe('every route declares who may call it', () => {
  it('leaves no handler without an audience', () => {
    const undeclared = handlers(harness.app)
      .filter((handler) => !handler.isPublic && handler.capabilities.length === 0)
      .map((handler) => handler.label)
      .filter((label) => !OPEN_TO_ANY_SIGNED_IN_USER.has(label))
      .sort();

    expect(undeclared, `these handlers decide nobody's access:\n${undeclared.join('\n')}`).toEqual(
      [],
    );
  });

  it('grants every declared capability to at least one role', () => {
    // A capability no role holds is a route nobody can call — usually a typo,
    // never a decision.
    const unreachable = handlers(harness.app)
      .flatMap((handler) => handler.capabilities)
      .filter((capability) => !ROLES.some((role) => can(role, capability)));

    expect([...new Set(unreachable)]).toEqual([]);
  });

  it('names every intentionally open route with a reason', () => {
    for (const [route, reason] of OPEN_TO_ANY_SIGNED_IN_USER) {
      expect(reason.length, `${route} is open without saying why`).toBeGreaterThan(10);
    }
  });

  it('does not list a route as open that has since been guarded', () => {
    const stillOpen = new Set(
      handlers(harness.app)
        .filter((handler) => !handler.isPublic && handler.capabilities.length === 0)
        .map((handler) => handler.label),
    );
    const stale = [...OPEN_TO_ANY_SIGNED_IN_USER.keys()].filter((route) => !stillOpen.has(route));

    expect(stale, `no longer open, so the exemption should go:\n${stale.join('\n')}`).toEqual([]);
  });
});

interface HandlerUnderInspection {
  label: string;
  capabilities: Capability[];
  isPublic: boolean;
}

/** Every controller handler Nest mounted, with the metadata the guard reads. */
function handlers(app: INestApplication): HandlerUnderInspection[] {
  const modules = app.get(ModulesContainer);
  const found: HandlerUnderInspection[] = [];

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;

      const basePath: string = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
      const prototype = controller.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor') continue;
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;

        const path: string | undefined = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue;

        const method: number = Reflect.getMetadata(METHOD_METADATA, handler) ?? 0;
        found.push({
          label: `${RequestMethod[method]} ${join(basePath, path)}`,
          capabilities:
            (Reflect.getMetadata(CAPABILITY_KEY, handler) as Capability[] | undefined) ??
            (Reflect.getMetadata(CAPABILITY_KEY, controller) as Capability[] | undefined) ??
            [],
          isPublic:
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true,
        });
      }
    }
  }

  return found;
}

function join(base: string, path: string): string {
  const parts = [base, path].filter((part) => part && part !== '/');
  return `/${parts.join('/')}`.replace(/\/+/g, '/');
}
