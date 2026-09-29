import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * What happens when one address asks too often.
 *
 * The rest of the suite runs with development-sized limits, because it signs in
 * hundreds of times a minute from a single address. So this file sets tight
 * ones *before* the application is built — the configuration is parsed from the
 * environment at boot — and gets its own instance to attack. Vitest isolates
 * each test file, so nothing here reaches the suites that run alongside it.
 *
 * The two limits answer different threats and are tested apart:
 *
 *  - the wide one is a flood ceiling, and proves an address cannot escape it by
 *    spreading requests across different endpoints;
 *  - the narrow one guards the ways in, where every attempt costs an Argon2
 *    hash, and proves that working through many accounts from one address runs
 *    out long before the accounts do.
 */
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.RATE_LIMIT_MAX = '12';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '900';
process.env.AUTH_RATE_LIMIT_MAX = '4';

const { createHarness, resetDatabase } = await import('./harness.js');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let harness: Harness;
let token: string;

const WIDE_LIMIT = 12;
const ENTRY_LIMIT = 4;

beforeAll(async () => {
  harness = await createHarness();
  await resetDatabase(harness.prisma);
  const admin = await harness.seedUser({ role: 'super_admin' });
  // Signing in costs one of the narrow budget, which the tests below account for.
  const session = await harness.signIn(admin.email);
  token = session.accessToken;
});

afterAll(async () => {
  await harness.close();
});

describe('the wide limit', () => {
  it('refuses an address that keeps asking, and says when to come back', async () => {
    let refusal: {
      status: number;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    } | null = null;

    // One past the limit. Sequential rather than parallel: a burst of promises
    // would race the counter and make the boundary untestable.
    for (let attempt = 0; attempt < WIDE_LIMIT + 1; attempt += 1) {
      const response = await harness.http().get('/api/v1/notifications').set(auth());
      if (response.status === 429) {
        refusal = response as never;
        break;
      }
    }

    expect(refusal, 'nothing was refused within the limit plus one').not.toBeNull();
    // Refused the same way as everything else, so a client branches on `type`
    // rather than parsing prose.
    expect(refusal!.body.type).toMatch(/too-many-requests$/);
    expect(refusal!.body.status).toBe(429);
    // A well-behaved client needs to know when to return; without this it
    // hammers until it is let through, which is the behaviour being limited.
    expect(Number(refusal!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts a caller, not a route', async () => {
    // The framework keys on the handler by default, which would hand an
    // attacker the whole budget again for every endpoint they touched.
    const response = await harness.http().get('/api/v1/clients').set(auth());
    expect(response.status).toBe(429);
  });
});

describe('the narrow limit on the ways in', () => {
  it('runs out while an attacker is still working through accounts', async () => {
    let refusedAt: number | null = null;

    for (let attempt = 0; attempt < ENTRY_LIMIT + 2; attempt += 1) {
      const response = await harness
        .http()
        .post('/api/v1/auth/login')
        // A different account every time, which is what spraying looks like:
        // the per-account lockout never fires, so this limit is the only thing
        // between one address and every password in the company.
        .send({ email: `sprayed-${attempt}@managedops.local`, password: 'Whatever!2026' });

      if (response.status === 429) {
        refusedAt = attempt;
        break;
      }
      // Until then it is an ordinary failed sign-in, not a leak of which
      // accounts exist.
      expect(response.status).toBe(401);
    }

    expect(refusedAt, 'spraying was never refused').not.toBeNull();
    expect(refusedAt!).toBeLessThanOrEqual(ENTRY_LIMIT);
  });

  it('leaves the rest of the API alone once the ways in are shut', async () => {
    // The narrow limit is spent by the test above. Somebody already signed in
    // is not the threat it exists for, and should not be collateral.
    const response = await harness.http().post('/api/v1/auth/login').send({
      email: 'anybody@managedops.local',
      password: 'Whatever!2026',
    });
    expect(response.status).toBe(429);

    // A separate application, so the wide budget spent above is not in play.
    const fresh = await createHarness();
    try {
      const ordinary = await fresh.http().get('/api/v1/health');
      expect(ordinary.status).not.toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

function auth() {
  return { Authorization: `Bearer ${token}` };
}
