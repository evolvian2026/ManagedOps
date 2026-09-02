import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_MAX_ATTEMPTS } from '@managedops/shared';
import { createHarness, resetDatabase, TEST_PASSWORD, type Harness } from './harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
});

describe('POST /auth/login', () => {
  it('returns an access token, the user and their capabilities', async () => {
    const user = await harness.seedUser({ role: 'hr' });

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ id: user.id, role: 'hr', status: 'active' });
    expect(response.body.user.capabilities).toContain('candidates.manage');
    // The refresh token must never travel in the body where script could read it.
    expect(response.body.refreshToken).toBeUndefined();
  });

  it('puts the refresh token in an httpOnly, SameSite=Strict cookie', async () => {
    const user = await harness.seedUser({ role: 'manager' });

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
    const refresh = cookies.find((cookie) => cookie.startsWith('managedops_refresh='));

    expect(refresh).toBeDefined();
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('SameSite=Strict');
    expect(refresh).toContain('Path=/api/v1/auth');
  });

  it('never stores the refresh token in a form the database could replay', async () => {
    const user = await harness.seedUser({ role: 'manager' });
    const session = await harness.signIn(user.email);
    const presented = session.refreshCookie.split('=')[1] ?? '';

    const stored = await harness.prisma.db.refreshToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(presented);
    expect(stored[0]?.tokenHash).toHaveLength(64);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const user = await harness.seedUser({ role: 'hr' });

    const wrongPassword = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'NotTheRightOne1!' })
      .expect(401);

    const unknownAccount = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'NotTheRightOne1!' })
      .expect(401);

    // Any difference here would let an attacker enumerate real accounts.
    expect(wrongPassword.body.detail).toBe(unknownAccount.body.detail);
    expect(wrongPassword.body.type).toBe(unknownAccount.body.type);
  });

  it('refuses a disabled account', async () => {
    const user = await harness.seedUser({ role: 'hr', status: 'disabled' });

    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);

    expect(response.body.detail).toContain('disabled');
  });

  it('locks the account after repeated failures and says how long for', async () => {
    const user = await harness.seedUser({ role: 'hr' });

    for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt += 1) {
      await harness
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'WrongPassword1!' })
        .expect(401);
    }

    // Even the correct password is refused while the lockout holds.
    const locked = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(429);

    expect(locked.body.detail).toMatch(/try again in \d+ minute/i);
  });

  it('rejects a malformed email with a field-level message', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'whatever' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'email' }));
  });
});

describe('GET /auth/me', () => {
  it('refuses a request with no token', async () => {
    const response = await harness.http().get('/api/v1/auth/me').expect(401);
    expect(response.body.title).toBe('Not authenticated');
  });

  it('refuses a token that is not ours', async () => {
    await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('returns the signed-in user', async () => {
    const user = await harness.seedUser({ role: 'interviewer' });
    const session = await harness.signIn(user.email);

    const response = await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({ id: user.id, role: 'interviewer' });
    // An interviewer's capability set is deliberately tiny (spec 15.6).
    expect(response.body.capabilities).toEqual(
      expect.arrayContaining(['interviews.read', 'interviews.record_outcome']),
    );
    expect(response.body.capabilities).not.toContain('trainers.read_salary');
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the token and refuses the old one afterwards', async () => {
    const user = await harness.seedUser({ role: 'manager' });
    const session = await harness.signIn(user.email);

    const rotated = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [session.refreshCookie, `managedops_csrf=${session.csrfToken}`])
      .set('X-CSRF-Token', session.csrfToken)
      .expect(200);

    expect(rotated.body.accessToken).toEqual(expect.any(String));

    // Presenting the superseded token means it leaked; the family is revoked.
    const reuse = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [session.refreshCookie, `managedops_csrf=${session.csrfToken}`])
      .set('X-CSRF-Token', session.csrfToken)
      .expect(401);

    expect(reuse.body.detail).toContain('already replaced');

    const live = await harness.prisma.db.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('refuses a refresh without the matching CSRF header', async () => {
    const user = await harness.seedUser({ role: 'manager' });
    const session = await harness.signIn(user.email);

    const response = await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [session.refreshCookie, `managedops_csrf=${session.csrfToken}`])
      .expect(403);

    expect(response.body.title).toBe('Not permitted');
  });

  it('refuses a CSRF header that does not match the cookie', async () => {
    const user = await harness.seedUser({ role: 'manager' });
    const session = await harness.signIn(user.email);

    await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [session.refreshCookie, `managedops_csrf=${session.csrfToken}`])
      .set('X-CSRF-Token', 'a-different-value')
      .expect(403);
  });

  it('refuses a refresh with no cookie at all', async () => {
    await harness.http().post('/api/v1/auth/refresh').expect(401);
  });
});

describe('forced password change', () => {
  it('blocks every other route until the password is changed', async () => {
    const user = await harness.seedUser({ role: 'super_admin', mustChangePassword: true });
    const session = await harness.signIn(user.email);

    expect(session.user.mustChangePassword).toBe(true);

    // Enforced on the server, so a client that skips the screen gains nothing.
    const blocked = await harness
      .http()
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(403);
    expect(blocked.body.detail).toContain('Change your password');

    // The two routes needed to actually change it stay reachable.
    await harness
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
  });

  it('clears the flag, issues fresh tokens and revokes other sessions', async () => {
    const user = await harness.seedUser({ role: 'super_admin', mustChangePassword: true });
    const first = await harness.signIn(user.email);
    const second = await harness.signIn(user.email);

    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'BrandNewPass1234' })
      .expect(200);

    expect(response.body.user.mustChangePassword).toBe(false);
    expect(response.body.accessToken).toEqual(expect.any(String));

    // The other device's refresh token no longer works.
    await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [first.refreshCookie, `managedops_csrf=${first.csrfToken}`])
      .set('X-CSRF-Token', first.csrfToken)
      .expect(401);

    // And the old password is genuinely gone.
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(401);

    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'BrandNewPass1234' })
      .expect(200);
  });

  it('refuses a wrong current password with a field error', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    const session = await harness.signIn(user.email);

    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: 'NotMyPassword1!', newPassword: 'BrandNewPass1234' })
      .expect(422);

    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ path: 'currentPassword' }),
    );
  });

  it('refuses a new password that does not meet the policy', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    const session = await harness.signIn(user.email);

    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'newPassword' }));
  });

  it('refuses reusing the current password as the new one', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    const session = await harness.signIn(user.email);

    await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
      .expect(422);
  });
});

describe('POST /auth/forgot-password', () => {
  it('answers identically whether or not the address has an account', async () => {
    const user = await harness.seedUser({ role: 'hr' });

    const known = await harness
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email: user.email })
      .expect(202);

    const unknown = await harness
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'stranger@test.local' })
      .expect(202);

    expect(known.body).toEqual(unknown.body);
  });

  it('refuses a reset token that has already been used', async () => {
    const user = await harness.seedUser({ role: 'hr' });
    await harness.http().post('/api/v1/auth/forgot-password').send({ email: user.email });

    const reset = await harness.prisma.db.passwordReset.findFirst({ where: { userId: user.id } });
    expect(reset).toBeTruthy();

    await harness.prisma.db.passwordReset.update({
      where: { id: reset!.id },
      data: { usedAt: new Date() },
    });

    await harness
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'a'.repeat(64), newPassword: 'BrandNewPass1234' })
      .expect(422);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the presented refresh token', async () => {
    const user = await harness.seedUser({ role: 'manager' });
    const session = await harness.signIn(user.email);

    await harness
      .http()
      .post('/api/v1/auth/logout')
      .set('Cookie', [session.refreshCookie])
      .expect(204);

    await harness
      .http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [session.refreshCookie, `managedops_csrf=${session.csrfToken}`])
      .set('X-CSRF-Token', session.csrfToken)
      .expect(401);
  });
});
