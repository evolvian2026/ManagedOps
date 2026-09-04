import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generate } from 'otplib';

// Enforcement is a deployment posture, and this suite is the one that runs with
// it on. Set before the app is built, because the configuration is parsed once
// at boot — which is also what makes a misconfigured deployment fail loudly
// rather than at the first sign-in.
process.env.MFA_ENFORCEMENT = 'required';

const { createHarness, resetDatabase, TEST_PASSWORD } = await import('./harness.js');
type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * The second factor.
 *
 * The interesting cases are all about what a correct password is *not* enough
 * for, and about the ways a six-digit code can be got round: replaying one
 * somebody read over a shoulder, guessing at it, or simply declining to set one
 * up and carrying on regardless.
 */
let harness: Harness;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function code(secret: string): Promise<string> {
  return generate({ secret });
}

/** A password sign-in that is expected to stop at the challenge. */
async function passwordOnly(email: string) {
  const response = await harness
    .http()
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return response.body as { mfa?: string; challengeToken?: string; accessToken?: string };
}

/** Seeds a privileged account and takes it all the way through enrolment. */
async function enrolledAdmin(role: 'hr' | 'manager' | 'super_admin' = 'hr') {
  const seeded = await harness.seedUser({ role });
  const first = await passwordOnly(seeded.email);
  expect(first.mfa).toBe('enrolment');

  const enrol = await harness
    .http()
    .post('/api/v1/auth/login/mfa/enrol')
    .send({ challengeToken: first.challengeToken })
    .expect(200);

  const secret = enrol.body.secret as string;
  const activated = await harness
    .http()
    .post('/api/v1/auth/login/mfa/activate')
    .send({ challengeToken: first.challengeToken, code: await code(secret) })
    .expect(200);

  return {
    ...seeded,
    secret,
    accessToken: activated.body.accessToken as string,
    recoveryCodes: activated.body.recoveryCodes as string[],
  };
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
});

afterAll(async () => {
  await harness.close();
});

describe('who is asked for a second factor', () => {
  it('stops a privileged sign-in at a challenge rather than issuing a session', async () => {
    const seeded = await harness.seedUser({ role: 'hr' });
    const result = await passwordOnly(seeded.email);

    expect(result.mfa).toBe('enrolment');
    expect(result.challengeToken).toBeTruthy();
    // The thing that matters: a correct password on its own buys no session.
    expect(result.accessToken).toBeUndefined();
  });

  it('sets no refresh cookie alongside a challenge', async () => {
    const seeded = await harness.seedUser({ role: 'manager' });
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: seeded.email, password: TEST_PASSWORD })
      .expect(200);

    const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.filter((cookie) => cookie.startsWith('managedops_refresh='))).toEqual([]);
  });

  it('lets a trainer straight in, because they can only see themselves', async () => {
    const seeded = await harness.seedUser({ role: 'trainer' });
    const result = await passwordOnly(seeded.email);

    expect(result.mfa).toBeUndefined();
    expect(result.accessToken).toBeTruthy();
  });

  it('lets a project lead straight in, whose salary access is their own only', async () => {
    const seeded = await harness.seedUser({ role: 'project_lead' });
    const result = await passwordOnly(seeded.email);
    expect(result.accessToken).toBeTruthy();
  });

  it('still refuses a wrong password before any of this', async () => {
    const seeded = await harness.seedUser({ role: 'hr' });
    await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: seeded.email, password: 'not-the-password' })
      .expect(401);
  });
});

describe('enrolling', () => {
  it('hands back a secret, a QR code and a set of recovery codes', async () => {
    const admin = await enrolledAdmin();

    expect(admin.secret).toMatch(/^[A-Z2-7]+$/);
    expect(admin.recoveryCodes).toHaveLength(8);
    expect(admin.accessToken).toBeTruthy();
  });

  it('offers the secret as a scannable code and as text to type', async () => {
    const seeded = await harness.seedUser({ role: 'hr' });
    const first = await passwordOnly(seeded.email);
    const enrol = await harness
      .http()
      .post('/api/v1/auth/login/mfa/enrol')
      .send({ challengeToken: first.challengeToken })
      .expect(200);

    expect(enrol.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/ManagedOps/);
    // Not everybody has a camera to hand; the same secret is offered as text.
    expect(enrol.body.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(enrol.body.secret).toBeTruthy();
  });

  it('refuses to turn on a factor the authenticator has not proved', async () => {
    const seeded = await harness.seedUser({ role: 'hr' });
    const first = await passwordOnly(seeded.email);
    await harness
      .http()
      .post('/api/v1/auth/login/mfa/enrol')
      .send({ challengeToken: first.challengeToken })
      .expect(200);

    await harness
      .http()
      .post('/api/v1/auth/login/mfa/activate')
      .send({ challengeToken: first.challengeToken, code: '000000' })
      .expect(401);

    // Still not enrolled — an abandoned enrolment is not a second factor.
    const user = await harness.prisma.db.user.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(user.mfaEnrolledAt).toBeNull();
  });

  it('spends the challenge once enrolment completes', async () => {
    const admin = await enrolledAdmin();
    const challenges = await harness.prisma.db.mfaChallenge.findMany({
      where: { userId: admin.id },
    });
    // A challenge left open after it has done its job is a second way in.
    expect(challenges.every((row) => row.consumedAt !== null)).toBe(true);
  });

  it('never stores the secret as it was shown', async () => {
    const admin = await enrolledAdmin();
    const user = await harness.prisma.db.user.findUniqueOrThrow({ where: { id: admin.id } });

    expect(user.mfaSecret).toBeTruthy();
    // Encrypted, not hashed — verifying needs it back — so what is worth
    // asserting is that the stored form is not the secret itself.
    expect(user.mfaSecret).not.toContain(admin.secret);
  });

  it('stores recovery codes hashed', async () => {
    const admin = await enrolledAdmin();
    const stored = await harness.prisma.db.mfaRecoveryCode.findMany({
      where: { userId: admin.id },
    });

    expect(stored).toHaveLength(8);
    for (const row of stored) {
      expect(admin.recoveryCodes).not.toContain(row.codeHash);
    }
  });
});

describe('signing in with a second factor already set up', () => {
  it('exchanges a code for a session', async () => {
    const admin = await enrolledAdmin();
    const second = await passwordOnly(admin.email);
    expect(second.mfa).toBe('verification');

    // A fresh window, so the enrolment code is not being replayed.
    await waitForNextWindow();
    const verified = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.challengeToken, code: await code(admin.secret) })
      .expect(200);

    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.body.user.role).toBe('hr');
  });

  it('refuses the same code twice', async () => {
    const admin = await enrolledAdmin();
    await waitForNextWindow();
    const shared = await code(admin.secret);

    const first = await passwordOnly(admin.email);
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: first.challengeToken, code: shared })
      .expect(200);

    // The case this exists for: somebody reads the code over a shoulder and has
    // the rest of its thirty seconds to use it.
    const second = await passwordOnly(admin.email);
    const replay = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.challengeToken, code: shared })
      .expect(401);

    expect(JSON.stringify(replay.body)).toMatch(/already been used/i);
  });

  it('gives up on a challenge after five wrong codes', async () => {
    const admin = await enrolledAdmin();
    const challenge = await passwordOnly(admin.email);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness
        .http()
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: challenge.challengeToken, code: '000000' })
        .expect(401);
    }

    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.challengeToken, code: '000000' })
      .expect(429);

    // The account itself is untouched. Locking it would let anybody holding a
    // leaked password lock out the person who owns it.
    const user = await harness.prisma.db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(user.lockedUntil).toBeNull();
  });

  it('refuses a challenge token that was already spent', async () => {
    const admin = await enrolledAdmin();
    await waitForNextWindow();
    const challenge = await passwordOnly(admin.email);

    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.challengeToken, code: await code(admin.secret) })
      .expect(200);

    await waitForNextWindow();
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.challengeToken, code: await code(admin.secret) })
      .expect(401);
  });

  it('refuses a challenge token nobody issued', async () => {
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: 'a'.repeat(64), code: '000000' })
      .expect(401);
  });
});

describe('recovery codes', () => {
  it('lets somebody who has lost their phone in', async () => {
    const admin = await enrolledAdmin();
    const challenge = await passwordOnly(admin.email);

    const result = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.challengeToken, code: admin.recoveryCodes[0] })
      .expect(200);

    expect(result.body.accessToken).toBeTruthy();
  });

  it('spends each one exactly once', async () => {
    const admin = await enrolledAdmin();
    const first = await passwordOnly(admin.email);
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: first.challengeToken, code: admin.recoveryCodes[0] })
      .expect(200);

    const second = await passwordOnly(admin.email);
    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: second.challengeToken, code: admin.recoveryCodes[0] })
      .expect(401);
  });

  it('counts down what is left', async () => {
    const admin = await enrolledAdmin();
    const before = await harness
      .http()
      .get('/api/v1/auth/mfa')
      .set(auth(admin.accessToken))
      .expect(200);
    expect(before.body.recoveryCodesRemaining).toBe(8);

    const challenge = await passwordOnly(admin.email);
    const session = await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: challenge.challengeToken, code: admin.recoveryCodes[1] })
      .expect(200);

    const after = await harness
      .http()
      .get('/api/v1/auth/mfa')
      .set(auth(session.body.accessToken))
      .expect(200);
    expect(after.body.recoveryCodesRemaining).toBe(7);
  });

  it('is accepted however it was typed back', async () => {
    const admin = await enrolledAdmin();
    const challenge = await passwordOnly(admin.email);

    await harness
      .http()
      .post('/api/v1/auth/mfa/verify')
      .send({
        challengeToken: challenge.challengeToken,
        code: admin.recoveryCodes[2]!.toLowerCase(),
      })
      .expect(200);
  });
});

describe('turning it off', () => {
  it('refuses a role that has to hold one', async () => {
    const admin = await enrolledAdmin();
    await waitForNextWindow();

    const response = await harness
      .http()
      .delete('/api/v1/auth/mfa')
      .set(auth(admin.accessToken))
      .send({ code: await code(admin.secret) })
      .expect(409);

    expect(JSON.stringify(response.body)).toMatch(/role requires an authenticator/i);
  });

  it('lets an administrator clear it for somebody who lost their phone', async () => {
    const admin = await enrolledAdmin();
    const superAdmin = await enrolledAdmin('super_admin');

    await harness
      .http()
      .post(`/api/v1/users/${admin.id}/reset-mfa`)
      .set(auth(superAdmin.accessToken))
      .expect(200);

    const user = await harness.prisma.db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(user.mfaEnrolledAt).toBeNull();
    expect(user.mfaSecret).toBeNull();

    // They are back to enrolling, not to signing in with a password alone.
    const next = await passwordOnly(admin.email);
    expect(next.mfa).toBe('enrolment');
  });

  it('ends every session the reset was meant to close', async () => {
    const admin = await enrolledAdmin();
    const superAdmin = await enrolledAdmin('super_admin');

    await harness
      .http()
      .post(`/api/v1/users/${admin.id}/reset-mfa`)
      .set(auth(superAdmin.accessToken))
      .expect(200);

    // Whoever asked for the reset may be the person who lost the phone, or the
    // person who found it. A session left running would be the whole problem.
    const tokens = await harness.prisma.db.refreshToken.findMany({ where: { userId: admin.id } });
    expect(tokens.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('is not something an ordinary user can do to somebody else', async () => {
    const admin = await enrolledAdmin();
    const trainer = await harness.seedUser({ role: 'trainer' });
    const session = await harness.signIn(trainer.email);

    await harness
      .http()
      .post(`/api/v1/users/${admin.id}/reset-mfa`)
      .set(auth(session.accessToken))
      .expect(403);
  });
});

describe('what the profile is told', () => {
  it('names why the role needs one', async () => {
    const admin = await enrolledAdmin();
    const status = await harness
      .http()
      .get('/api/v1/auth/mfa')
      .set(auth(admin.accessToken))
      .expect(200);

    expect(status.body.enrolled).toBe(true);
    expect(status.body.required).toBe(true);
    expect(status.body.reasons).toContain('trainers.read_documents');
  });

  it('tells a trainer they are not required to hold one', async () => {
    const trainer = await harness.seedUser({ role: 'trainer' });
    const session = await harness.signIn(trainer.email);

    const status = await harness
      .http()
      .get('/api/v1/auth/mfa')
      .set(auth(session.accessToken))
      .expect(200);

    expect(status.body.required).toBe(false);
    expect(status.body.enrolled).toBe(false);
    expect(status.body.reasons).toEqual([]);
  });
});

/**
 * Waits until the next thirty-second TOTP window.
 *
 * Codes are single-use, so a test that signs in twice needs two windows. This
 * is also exactly why the other suites run with enforcement off: a suite doing
 * this on every sign-in would take hours.
 */
async function waitForNextWindow(): Promise<void> {
  const msIntoWindow = Date.now() % 30_000;
  await new Promise((resolve) => setTimeout(resolve, 30_000 - msIntoWindow + 250));
}
