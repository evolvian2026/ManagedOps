import { expect, test, type Page } from '@playwright/test';

/**
 * The commercial side, through the real UI.
 *
 * The rule worth checking here is the one a screenshot cannot: a rate is not
 * merely hidden from HR by CSS, it never arrives — so the column, the control
 * and the whole Margin screen are absent rather than disabled.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const MANAGER = 'priya.nair@managedops.local';
const HR = 'ananya.sharma@managedops.local';
const LEAD = 'karan.mehta@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openSeededRoster(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
  await expect(page.getByRole('table')).toBeVisible();
}

test.describe('the client directory', () => {
  test('lists who we deliver for, with the contract rate for a manager', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/clients');

    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table).toContainText('Horizon Institute of Technology');
    await expect(table).toContainText('₹6,500');
  });

  test('shows HR the directory but neither the rate nor a way to add one', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/clients');

    // They staff against it, so they see it.
    await expect(page.getByRole('table')).toContainText('Horizon Institute of Technology');
    // The column is absent because the field never left the server for them.
    await expect(page.getByRole('columnheader', { name: 'Contract rate' })).toBeHidden();
    await expect(page.getByRole('table')).not.toContainText('₹6,500');
    // And no control the API would refuse after they had filled the form in.
    await expect(page.getByRole('button', { name: 'Add a client' })).toBeHidden();
  });

  test('refuses a project lead and a trainer outright', async ({ page }) => {
    for (const account of [LEAD, TRAINER]) {
      await signIn(page, account);
      await page.goto('/clients');
      await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  });

  test('names what is standing in the way of deactivating a live client', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/clients');

    await page
      .getByRole('row', { name: /Horizon Institute of Technology/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('button', { name: 'Mark inactive' }).click();

    await expect(page.getByRole('alert')).toContainText(/still has 1 active project/);
  });
});

test.describe('the margin report', () => {
  test('shows revenue, cost and margin for the month', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');

    // level and exact both matter: the page's own cards are headed "Margin"
    // and "Margin %", and a substring match on the name picks up all three
    // the moment they render.
    await expect(
      page.getByRole('heading', { name: 'Margin', exact: true, level: 1 }),
    ).toBeVisible();
    const revenue = page.getByRole('region', { name: 'Revenue' });
    await expect(revenue).toContainText('₹');
    await expect(page.getByRole('table')).toContainText('Full Stack Bootcamp');
  });

  test('says plainly that an unrated assignment makes the figure a floor', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');

    // Seeded: one trainer's internal work has never been priced.
    await expect(page.getByText(/no agreed rate/)).toBeVisible();
    await expect(page.getByText(/the floor rather than the answer/)).toBeVisible();
  });

  test('names the assignment behind a thin row rather than only the total', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');

    // The row is a roll-up; the rate that would fix it lives on an assignment.
    await page.getByRole('button', { name: 'Full Stack Bootcamp — Spring Term' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Meera Krishnan');
    await expect(dialog).toContainText('No rate yet');
    // The ones that can be acted on come first, whatever they earned.
    await expect(dialog.getByRole('row').nth(1)).toContainText('Meera Krishnan');
    // And the margin is in view, not off the edge behind a scrollbar: the
    // point of drilling in is seeing that this one assignment is what makes
    // the row thin. Its cost is counted and no revenue is recorded against it.
    await expect(dialog.getByRole('row').nth(1)).toContainText('-₹27,692');
  });

  test('goes straight from the warning to what it is warning about', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');

    await page.getByRole('button', { name: 'Show me which' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Neither a rate nor a decision');
    await expect(dialog).toContainText('Meera Krishnan');
  });

  // Drives the seeded data forward, like the recruitment specs: marking work
  // deliberately unbilled is one-way by design — you cannot un-decide — so this
  // runs after the tests that need the warning still showing, and the suite is
  // run against a fresh seed.
  test('clears the warning when the work is recorded as deliberately unbilled', async ({
    page,
  }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');
    await expect(page.getByText(/the floor rather than the answer/)).toBeVisible();

    await page.getByRole('button', { name: 'Show me which' }).click();
    // Named, because deciding the rate opens a second dialog over this one.
    const list = page.getByRole('dialog', { name: 'Assignments awaiting a rate' });
    await list.getByRole('button', { name: 'No rate yet' }).click();

    const decision = page.getByRole('dialog', { name: 'How is this billed?' });
    await decision.getByRole('radio', { name: 'Not billed at all' }).check();
    await decision.getByLabel('Why').fill('Internal curriculum work, absorbed into the retainer.');
    await decision.getByRole('button', { name: 'Save', exact: true }).click();

    // The list empties as the decision lands, then the screen behind it.
    await expect(list).toContainText('Every assignment is accounted for');
    await list.getByRole('button', { name: 'Close' }).click();

    // The revenue has not moved — nothing was billed either way. What has moved
    // is that there is no longer anything for anybody to do, so the warning
    // that could never be cleared is gone.
    await expect(page.getByText(/the floor rather than the answer/)).toBeHidden();
    await expect(page.getByText(/1 of them is deliberately not billed/)).toBeVisible();
  });

  test('re-cuts the same money rather than asking a different question', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/margin');

    // The figure itself, not the tile's whole text: `innerText` keeps the
    // heading and its line breaks, which `toHaveText` then normalises away, so
    // comparing the two nodes would fail on whitespace and prove nothing.
    const marginFigure = page.getByRole('region', { name: 'Margin', exact: true }).locator('p');
    const byProject = (await marginFigure.innerText()).trim();
    expect(byProject).toMatch(/₹/);

    await page.getByLabel('Group').selectOption('trainer');
    await expect(page.getByRole('table')).toContainText('Sneha Iyer');
    // Every grouping is a roll-up of the same per-assignment figures, so the
    // total cannot move when only the grouping does.
    await expect(marginFigure).toHaveText(byProject);

    await page.getByLabel('Group').selectOption('client');
    await expect(page.getByRole('table')).toContainText('Horizon');
    await expect(marginFigure).toHaveText(byProject);
  });

  test('is not in the sidebar for HR, and refuses them the screen', async ({ page }) => {
    await signIn(page, HR);

    const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
    expect(nav).toContain('Clients');
    expect(nav).not.toContain('Margin');

    await page.goto('/margin');
    await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
  });
});

test.describe('the rate on an assignment', () => {
  test('is shown on the roster to a manager and editable in place', async ({ page }) => {
    await signIn(page, MANAGER);
    await openSeededRoster(page);

    const row = page.getByRole('row', { name: /Sneha Iyer/ });
    await expect(row).toContainText('₹6,500');

    await row.getByRole('button', { name: '₹6,500' }).click();
    await expect(page.getByRole('dialog')).toContainText('What this client pays per day');
    await page.getByLabel('Rate per day').fill('7200');
    await page.getByRole('button', { name: 'Save rate' }).click();

    await expect(page.getByRole('row', { name: /Sneha Iyer/ })).toContainText('₹7,200');
  });

  test('says "not billed" rather than nothing where no rate is agreed', async ({ page }) => {
    await signIn(page, MANAGER);
    await openSeededRoster(page);

    // Meera does internal curriculum work; the absence is deliberate and said.
    await expect(page.getByRole('row', { name: /Meera Krishnan/ })).toContainText('Not billed');
  });

  test('is absent from the roster HR sees, column and all', async ({ page }) => {
    await signIn(page, HR);
    await openSeededRoster(page);

    await expect(page.getByRole('row', { name: /Sneha Iyer/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Day rate' })).toBeHidden();
    await expect(page.getByRole('table')).not.toContainText('₹');
  });
});
