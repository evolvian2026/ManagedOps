import { expect, test, type Page } from '@playwright/test';

/**
 * The journeys that must never break: signing in, staying signed in, and seeing
 * exactly the navigation your role entitles you to.
 *
 * Every account here comes from `pnpm db:seed`.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';

const ACCOUNTS = {
  superAdmin: 'anoop.dcrust@gmail.com',
  manager: 'priya.nair@managedops.local',
  hr: 'ananya.sharma@managedops.local',
  projectLead: 'karan.mehta@managedops.local',
  trainer: 'sneha.iyer@managedops.local',
} as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  // The router navigates client-side, so wait for the shell rather than the network.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function navLabels(page: Page): Promise<string[]> {
  return page.locator('nav[aria-label="Main"] a').allInnerTexts();
}

/** Lower-cased, because the headings are uppercased by CSS rather than in the markup. */
async function navSections(page: Page): Promise<string[]> {
  const headings = await page.locator('nav[aria-label="Main"] p').allInnerTexts();
  return headings.map((heading) => heading.toLowerCase());
}

test.describe('signing in', () => {
  test('an admin lands on their dashboard', async ({ page }) => {
    await signIn(page, ACCOUNTS.superAdmin);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('h1')).toContainText('Anoop');
  });

  test('a failed sign-in shows what the server actually said', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', ACCOUNTS.superAdmin);
    await page.fill('input[name="password"]', 'definitely-not-the-password');
    await page.click('button[type="submit"]');

    // Never a generic stand-in: the specific server message reaches the user.
    await expect(page.getByRole('alert')).toContainText('do not match an account');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the session survives a reload', async ({ page }) => {
    await signIn(page, ACCOUNTS.hr);
    await page.reload();

    // Recovered from the httpOnly refresh cookie, since the access token only
    // ever lives in memory.
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('signing out really ends the session', async ({ page }) => {
    await signIn(page, ACCOUNTS.manager);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a signed-out visitor is sent to sign in', async ({ page }) => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('what each role can see', () => {
  test('a super admin sees the administration section', async ({ page }) => {
    await signIn(page, ACCOUNTS.superAdmin);
    const nav = await navLabels(page);

    expect(nav).toContain('Users');
    expect(nav).toContain('Audit Log');
    expect(nav).toContain('Talent Pool');
    // An administrator has no trainer profile, so no self-service either.
    expect(nav).not.toContain('My Work');
  });

  test('a trainer sees only their own working life', async ({ page }) => {
    await signIn(page, ACCOUNTS.trainer);
    const nav = await navLabels(page);

    expect(nav).toContain('My Work');
    expect(nav).toContain('My Leave');
    expect(nav).toContain('My Reimbursements');
    expect(nav).not.toContain('Users');
    expect(nav).not.toContain('Audit Log');
    expect(nav).not.toContain('Talent Pool');
  });

  test('a trainer navigating straight to an admin screen is refused', async ({ page }) => {
    await signIn(page, ACCOUNTS.trainer);
    await page.goto('/users');

    // Hiding the link is not the control; the screen itself refuses.
    await expect(page.locator('h1')).toContainText('Not available to your role');
  });

  test('groups the sidebar, and shows no heading with nothing under it', async ({ page }) => {
    await signIn(page, ACCOUNTS.hr);
    // "Your work" is there for everybody now: an administrator has no trainer
    // profile, but they do have a phone number and an authenticator to look
    // after, and My Account is where both live.
    expect(await navSections(page)).toEqual([
      'delivery',
      'people',
      'commercial',
      'your work',
      'administration',
    ]);

    // HR staffs against the client directory but never sees a rate, so
    // Commercial is present without Margin under it.
    const nav = await navLabels(page);
    expect(nav).toContain('Clients');
    expect(nav).not.toContain('Margin');
  });

  test('gives a trainer only the sections they have something in', async ({ page }) => {
    await signIn(page, ACCOUNTS.trainer);

    // Dashboard sits above the first heading, ungrouped — it is not a section.
    expect(await navSections(page)).toEqual(['people', 'your work']);
    expect(await navLabels(page)).toContain('Dashboard');
  });

  test('a project lead gets oversight and self-service together', async ({ page }) => {
    await signIn(page, ACCOUNTS.projectLead);
    const nav = await navLabels(page);

    expect(nav).toContain('Running Projects');
    expect(nav).toContain('Flags');
    // A head trainer teaches too, so they take leave like anyone else.
    expect(nav).toContain('My Leave');
    expect(nav).not.toContain('Users');
  });
});

test.describe('the dashboard', () => {
  test('loads without a single failed request', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      // The session-resume probe legitimately 401s before anyone signs in.
      if (response.status() >= 400 && path !== '/api/v1/auth/refresh') {
        failures.push(`${response.status()} ${path}`);
      }
    });
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(String(error)));

    await signIn(page, ACCOUNTS.superAdmin);
    await page.waitForLoadState('networkidle');

    expect(failures, failures.join(', ')).toHaveLength(0);
    expect(crashes, crashes.join(', ')).toHaveLength(0);
  });

  test('shows an explanatory empty state rather than a blank panel', async ({ page }) => {
    await signIn(page, ACCOUNTS.superAdmin);

    // Nobody has sent this account a notification, so the panel has nothing to
    // list. An empty panel that says why beats a blank rectangle — which is the
    // rule this checks, wherever the emptiness happens to be.
    const notifications = page.getByRole('region', { name: 'Recent notifications' });
    await expect(notifications).toContainText('Nothing yet');
    await expect(notifications).toContainText('Reminders and decisions about your work land here.');
  });
});

test.describe('on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'only meaningful on a mobile viewport');

  test('the sidebar collapses into a drawer', async ({ page }) => {
    await signIn(page, ACCOUNTS.trainer);

    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.locator('nav[aria-label="Main"]')).toBeVisible();
  });

  test('nothing pushes the page sideways', async ({ page }) => {
    await signIn(page, ACCOUNTS.trainer);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});
