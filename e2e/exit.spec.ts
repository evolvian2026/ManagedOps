import { expect, test, type Page } from '@playwright/test';

/**
 * Exit and re-use, through the real UI.
 *
 * These follow the two rules that make this phase worth having: a deboarding
 * that says exactly what is standing in its way rather than merely refusing,
 * and a Talent Pool that is a live query — nobody adds anybody to it, and
 * changing the underlying fact changes the list.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const LEAD = 'karan.mehta@managedops.local';
const TRAINER = 'meera.krishnan@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test.describe('the deboarding queue', () => {
  test('lists who is leaving, with the state of each checklist', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/deboarding');

    await expect(page.getByRole('heading', { name: 'Deboarding' })).toBeVisible();
    const table = page.getByRole('table');
    // Karan is mid-deboarding and still holds the seeded laptop.
    await expect(table).toContainText('Karan Mehta');
    await expect(table).toContainText('Outstanding');
  });

  test('names the asset standing in the way rather than only refusing', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/deboarding');
    await page
      .getByRole('row', { name: /Karan Mehta/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByText('Not yet — this is what is outstanding.')).toBeVisible();
    await expect(page.getByText(/Still to reconcile: Dell Latitude 5440/)).toBeVisible();
    await expect(page.getByText(/settlement is still pending/)).toBeVisible();

    // Named individually too, with the serial that has to come back — which
    // appears in the blocker sentence and again in the list, correctly.
    await expect(page.getByRole('heading', { name: 'Assets still out' })).toBeVisible();
    await expect(page.getByText('DL5440-0001', { exact: true })).toBeVisible();
  });

  test('says plainly that re-hire eligibility is what drives the pool', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/deboarding');
    await page
      .getByRole('row', { name: /Karan Mehta/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(
      page.getByText(/puts them in the Talent Pool when the deboarding completes/),
    ).toBeVisible();
  });

  test('shows a completed one as settled, with what happened next', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/deboarding');
    await page.getByRole('tab', { name: 'All history' }).click();

    const row = page.getByRole('row', { name: /Rohit Varma/ });
    await expect(row).toContainText('Completed');
    await row.getByRole('button', { name: 'Open' }).click();

    await expect(
      page.getByText(/Marked re-hire eligible, so they appear in the Talent Pool/),
    ).toBeVisible();
  });

  test('is not something a trainer can reach, or even see in the sidebar', async ({ page }) => {
    await signIn(page, TRAINER);

    // A trainer holds no deboarding capability: nothing shows them their own
    // exit checklist, so an administrator's queue has no business in their nav.
    const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
    expect(nav).not.toContain('Deboarding');

    await page.goto('/deboarding');
    await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
  });
});

test.describe('the talent pool', () => {
  test('lists the past trainer we would take back', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    await expect(page.getByRole('heading', { name: 'Talent Pool' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table).toContainText('Rohit Varma');
    await expect(table).toContainText('Worked here');
    await expect(table).toContainText('Deboarded');
  });

  test('shows a screened-out candidate with the reason they were rejected', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    const row = page.getByRole('row', { name: /Priyanka Rane/ });
    await expect(row).toContainText('Rejected screening');
    // The rejection reason, not the internal notes from the call.
    await expect(row).toContainText(/Wants a Java cohort/);
    await expect(row).not.toContainText(/strong on fundamentals/);
  });

  test('filters to people who have actually worked here', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    await page.getByLabel('Worked with us').selectOption('true');
    await expect(page.getByRole('table')).toContainText('Rohit Varma');

    await page.getByLabel('Worked with us').selectOption('false');
    await expect(page.getByRole('table').getByText('Rohit Varma')).toBeHidden();
  });

  test('searches by employee code', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    await page.getByLabel('Search').fill('MO-2026-0099');
    await expect(page.getByRole('table')).toContainText('Rohit Varma');
    await expect(page.getByRole('row')).toHaveCount(2); // header plus one match
  });

  test('offers only open positions when considering somebody', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    await page.getByRole('button', { name: 'Consider' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Put them forward for')).toBeVisible();
    // Creating is blocked until a position is chosen, rather than failing after.
    await expect(dialog.getByRole('button', { name: 'Create application' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('is not readable by a trainer', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/pool');
    await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
  });
});

test.describe('the dashboard', () => {
  test('gives a manager counts that lead to the screens behind them', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/');

    await expect(page.getByText('Active trainers')).toBeVisible();
    await expect(page.getByText('Waiting on you').first()).toBeVisible();

    await page.getByRole('button', { name: /Active trainers/ }).click();
    await expect(page.getByRole('heading', { name: 'Running Projects' })).toBeVisible();
  });

  test('names what is waiting rather than only counting it', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/');

    // Seeded: a correction, a leave request and a claim are all outstanding.
    // Scoped to the card, because the sidebar is a list too.
    const queue = page.getByRole('region').filter({ hasText: 'Waiting on you' });
    await expect(queue).toContainText(/requested leave|corrected|submitted a claim/);
  });

  test('gives a trainer their own day, not a queue they cannot act on', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/');

    await expect(page.getByText('My assignments')).toBeVisible();
    await expect(page.getByText('Days needing attention')).toBeVisible();
    // They approve nothing, so the tile is absent rather than a permanent zero.
    await expect(page.getByText('Approvals waiting')).toBeHidden();
  });

  test('withholds the activity feed from a lead, who cannot read the audit log', async ({
    page,
  }) => {
    await signIn(page, LEAD);
    await page.goto('/');
    await expect(page.getByText('My assignments')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeHidden();
  });

  test('shows the activity feed to a manager, who can', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  });
});
