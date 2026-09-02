import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks against a running stack.
 *
 * These drive a real browser against the real API and a real database — they are
 * the only place the whole chain (cookie, CSRF, guard, query scope, render) is
 * exercised together. Run them with the dev stack up:
 *
 *   pnpm infra:up && pnpm db:seed && pnpm dev
 *   pnpm test:e2e
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * Some environments (CI images, dev containers) ship a preinstalled Chromium
 * whose build does not match the one this Playwright version would download.
 * Pointing at it explicitly is cheaper than re-downloading a browser, and a
 * machine that has run `playwright install` simply leaves this unset.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const launchOptions = executablePath ? { launchOptions: { executablePath } } : {};

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // Sessions and lockout counters are per-account server state, so parallel
  // workers signing in as the same seeded user would interfere with each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...launchOptions } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...launchOptions } },
  ],
});
