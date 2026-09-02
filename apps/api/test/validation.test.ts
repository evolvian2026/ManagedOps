import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, eventually, resetDatabase, type Harness, type Session } from './harness.js';

/**
 * How the API refuses things.
 *
 * A rejection that will not say what it rejected is untriageable from a bug
 * report, so these assert on the explanation, not just the status code.
 */
let harness: Harness;
let admin: Session;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
  const user = await harness.seedUser({ role: 'super_admin' });
  admin = await harness.signIn(user.email);
});

function asAdmin(path: string) {
  return harness.http().get(path).set('Authorization', `Bearer ${admin.accessToken}`);
}

describe('query validation', () => {
  it('names the unrecognised parameter and lists what is accepted', async () => {
    const response = await asAdmin('/api/v1/users?nonsense=1').expect(400);

    expect(response.body.detail).toContain('nonsense');
    expect(response.body.detail).toContain('Accepted:');
    expect(response.body.errors).toContainEqual({
      path: 'nonsense',
      message: 'not a recognised parameter',
    });
  });

  it('names the field and the sortable options when a sort is not allowed', async () => {
    const response = await asAdmin('/api/v1/users?sort=-passwordHash').expect(400);

    expect(response.body.detail).toContain('passwordHash');
    expect(response.body.detail).toContain('Sortable fields are');
  });

  it('accepts a sort on an allowed field', async () => {
    await asAdmin('/api/v1/users?sort=-createdAt').expect(200);
    await asAdmin('/api/v1/users?sort=name').expect(200);
  });

  it('bounds the page size rather than letting a client ask for everything', async () => {
    const response = await asAdmin('/api/v1/users?pageSize=5000').expect(422);
    expect(response.body.errors?.[0]?.path).toBe('pageSize');
  });

  it('returns pagination metadata alongside the rows', async () => {
    const response = await asAdmin('/api/v1/users?pageSize=1').expect(200);
    expect(response.body.meta).toMatchObject({ page: 1, pageSize: 1 });
    expect(typeof response.body.meta.total).toBe('number');
  });
});

describe('body validation', () => {
  it('rejects an unknown field instead of silently ignoring it', async () => {
    const response = await harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Someone New', email: 'someone@test.local', role: 'hr', isSuperUser: true })
      .expect(400);

    expect(response.body.detail).toContain('isSuperUser');
  });

  it('refuses to create a trainer account directly', async () => {
    const response = await harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'A Trainer', email: 'trainer@test.local', role: 'trainer' })
      .expect(422);

    // A trainer must come from an accepted offer so they always have a profile.
    expect(response.body.detail).toContain('offer');
  });

  it('rejects a duplicate email with a field error', async () => {
    const existing = await harness.seedUser({ role: 'hr' });

    const response = await harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Same Address', email: existing.email, role: 'manager' })
      .expect(422);

    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ path: 'email', message: 'already in use' }),
    );
  });

  it('rejects a phone number that is not a valid Indian mobile', async () => {
    const response = await harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Bad Phone', email: 'badphone@test.local', role: 'hr', phone: '12345' })
      .expect(422);

    expect(response.body.errors?.[0]?.path).toBe('phone');
  });
});

describe('problem details', () => {
  it('carries a trace id on every error so a report can be correlated', async () => {
    const response = await asAdmin('/api/v1/users?nope=1').expect(400);
    expect(response.body.traceId).toEqual(expect.any(String));
  });

  it('uses a stable type URI a client can branch on', async () => {
    const response = await asAdmin('/api/v1/users?nope=1').expect(400);
    expect(response.body.type).toMatch(/^https:\/\/managedops\.app\/errors\//);
  });

  it('returns 404 with an explanation for a record that does not exist', async () => {
    const response = await asAdmin('/api/v1/users/01931f00-0000-7000-8000-000000000000').expect(
      404,
    );
    expect(response.body.title).toBe('Not found');
    expect(response.body.detail).toBeTruthy();
  });

  it('rejects a malformed identifier before it reaches the database', async () => {
    await asAdmin('/api/v1/users/not-a-uuid').expect(422);
  });
});

describe('user administration rules', () => {
  it('refuses to disable the only remaining super admin', async () => {
    const me = await harness.prisma.db.user.findFirst({ where: { role: 'super_admin' } });

    const response = await harness
      .http()
      .post(`/api/v1/users/${me!.id}/disable`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(409);

    expect(response.body.detail).toContain('only active super admin');
  });

  it('allows disabling a super admin once another one exists', async () => {
    const other = await harness.seedUser({ role: 'super_admin' });

    await harness
      .http()
      .post(`/api/v1/users/${other.id}/disable`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const disabled = await harness.prisma.db.user.findUnique({ where: { id: other.id } });
    expect(disabled?.status).toBe('disabled');
  });

  it('signs out every session when an account is disabled', async () => {
    const other = await harness.seedUser({ role: 'hr' });
    const theirSession = await harness.signIn(other.email);

    await harness
      .http()
      .post(`/api/v1/users/${other.id}/disable`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [theirSession.refreshCookie, `managedops_csrf=${theirSession.csrfToken}`])
      .set('X-CSRF-Token', theirSession.csrfToken)
      .expect(401);
  });

  it('signs out every session when a role changes', async () => {
    const other = await harness.seedUser({ role: 'hr' });
    const theirSession = await harness.signIn(other.email);

    await harness
      .http()
      .patch(`/api/v1/users/${other.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: 'manager' })
      .expect(200);

    // Their old token still carries the old role's claims, so it must not work.
    await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [theirSession.refreshCookie, `managedops_csrf=${theirSession.csrfToken}`])
      .set('X-CSRF-Token', theirSession.csrfToken)
      .expect(401);
  });
});

describe('the audit trail', () => {
  it('records a sign-in once, with the actor resolved', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    await harness.signIn(user.email);

    const entries = await eventually(async () => {
      const rows = await harness.prisma.db.auditLog.findMany({ where: { action: 'LOGIN' } });
      return rows.length > 0 ? rows : null;
    });

    // One row, not two: the auth routes opt out of the generic interceptor
    // precisely so they do not also write an actor-less duplicate.
    const forThisUser = entries.filter((row) => row.actorUserId === user.id);
    expect(forThisUser).toHaveLength(1);

    const duplicates = await harness.prisma.db.auditLog.findMany({
      where: { action: { contains: '/api/v1/auth' } },
    });
    expect(duplicates).toHaveLength(0);
  });

  it('records a mutation with its actor, and never its payload secrets', async () => {
    await harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Audited Person', email: 'audited@test.local', role: 'hr' })
      .expect(201);

    // The interceptor writes after the response, so poll rather than sleep.
    const entries = await eventually(async () => {
      const rows = await harness.prisma.db.auditLog.findMany({
        where: { entityType: 'User', action: { contains: '/api/v1/users' } },
      });
      return rows.length > 0 ? rows : null;
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorUserId).toBe(admin.user.id);
    // The interceptor redacts credentials before anything reaches the trail.
    expect(JSON.stringify(entries[0]?.after)).toContain('audited@test.local');
  });

  it('records a failed sign-in attempt', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'WrongOne1!' })
      .expect(401);

    const failures = await eventually(async () => {
      const rows = await harness.prisma.db.auditLog.findMany({ where: { action: 'LOGIN_FAILED' } });
      return rows.length > 0 ? rows : null;
    });
    expect(failures.length).toBeGreaterThan(0);
  });

  it('never writes a password into the trail', async () => {
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'someone@test.local', password: 'SuperSecret123!' })
      .expect(401);

    await eventually(async () => {
      const rows = await harness.prisma.db.auditLog.findMany({ where: { action: 'LOGIN_FAILED' } });
      return rows.length > 0 ? rows : null;
    });

    const entries = await harness.prisma.db.auditLog.findMany();
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain('SuperSecret123!');
  });
});
