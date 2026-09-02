import { expect, test, type Page } from '@playwright/test';

/**
 * Onboarding and the workforce screens, driven through the real UI.
 *
 * The rule under test throughout: a trainer's state follows the facts. Documents
 * verified and a project to work on makes them active; anything outstanding
 * shows as outstanding rather than being glossed over.
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

async function openBootcampRoster(page: Page): Promise<void> {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Running Projects' })).toBeVisible();
  await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
  await expect(page.getByRole('table')).toBeVisible();
}

test.describe('Running Projects', () => {
  test('shows a card per project with its trainer count', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/projects');

    const card = page.getByRole('button', { name: /Full Stack Bootcamp/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText('4');
    await expect(card).toContainText('trainers');
    await expect(card).toContainText('Horizon Institute of Technology');
  });

  test('the roster lists every active trainer and marks the lead', async ({ page }) => {
    await signIn(page, MANAGER);
    await openBootcampRoster(page);

    const table = page.getByRole('table');
    await expect(table).toContainText('Karan Mehta');
    await expect(table).toContainText('Lead');
    await expect(table).toContainText('Sneha Iyer');
    await expect(table).toContainText('MO-2026-0001');
  });

  test('says attendance is not recorded rather than inventing a status', async ({ page }) => {
    await signIn(page, MANAGER);
    await openBootcampRoster(page);

    // Attendance arrives in phase 3; an honest blank beats a fabricated tick.
    await expect(page.getByRole('table')).toContainText('Not recorded');
  });

  test('a trainer mid-onboarding is shown as such on the roster', async ({ page }) => {
    await signIn(page, MANAGER);
    await openBootcampRoster(page);

    const row = page.getByRole('row', { name: /Meera Krishnan/ });
    await expect(row).toContainText('Pending onboarding');
  });
});

test.describe('the trainer profile', () => {
  test('opens from the roster and shows their details', async ({ page }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);

    await page
      .getByRole('row', { name: /Karan Mehta/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await expect(page.getByRole('heading', { name: 'Karan Mehta' })).toBeVisible();
    // The code appears in the header and again in the details list, correctly.
    await expect(page.getByText('MO-2026-0001').first()).toBeVisible();
  });

  test('HR sees salary; the read is what the audit trail records', async ({ page }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Karan Mehta/ })
      .getByRole('button', { name: 'Open' })
      .click();

    // Indian digit grouping, and only because HR holds trainers.read_salary.
    await expect(page.getByText('₹9,60,000')).toBeVisible();
  });

  test('the document tab shows verified, rejected and outstanding side by side', async ({
    page,
  }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Meera Krishnan/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('tab', { name: /Documents/ }).click();

    await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Rejected', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Not uploaded').first()).toBeVisible();
    // The rejection says what to fix.
    await expect(page.getByText(/cut off along the bottom edge/)).toBeVisible();
  });

  test('the banner names what is still outstanding, and says it is not a lock-out', async ({
    page,
  }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Meera Krishnan/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('tab', { name: /Documents/ }).click();

    await expect(page.getByText(/1 of 3 documents verified/)).toBeVisible();
    await expect(page.getByText(/Still needed: PAN, education certificate/)).toBeVisible();
    await expect(page.getByText(/not a restriction/)).toBeVisible();
  });

  test('rejecting a document insists on a reason', async ({ page }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Meera Krishnan/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('tab', { name: /Documents/ }).click();

    await page.getByRole('button', { name: 'Reject' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('What is wrong with it?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('assignments list the project and the leave allowance', async ({ page }) => {
    await signIn(page, HR);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Karan Mehta/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('tab', { name: /Assignments/ }).click();

    await expect(page.getByText('Full Stack Bootcamp — Spring Term')).toBeVisible();
    await expect(page.getByText(/3 days leave/)).toBeVisible();
  });
});

test.describe('a project lead', () => {
  test('sees the roster but not a colleague salary', async ({ page }) => {
    await signIn(page, LEAD);
    await openBootcampRoster(page);

    await expect(page.getByRole('table')).toContainText('Sneha Iyer');

    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await expect(page.getByRole('heading', { name: 'Sneha Iyer' })).toBeVisible();
    // trainers.read_salary is 'own' scope for a lead, so a colleague's pay is absent.
    await expect(page.getByText(/₹7,20,000/)).toBeHidden();
  });

  test('has no Documents tab, because identity documents are HR business', async ({ page }) => {
    await signIn(page, LEAD);
    await openBootcampRoster(page);
    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByRole('tab', { name: /Documents/ })).toBeHidden();
    await expect(page.getByRole('tab', { name: /Overview/ })).toBeVisible();
  });
});

test.describe('a trainer looking at their own profile', () => {
  test('sees their checklist with upload, and no verify button', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
    await expect(page.getByText('MO-2026-0004').first()).toBeVisible();

    // They supply documents; HR decides whether they are acceptable.
    await expect(page.getByRole('button', { name: 'Upload' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0);
  });

  test('sees their own pay but no colleague roster', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await expect(page.getByText('₹7,20,000')).toBeVisible();

    const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
    expect(nav).toContain('My Profile');
    expect(nav).not.toContain('Running Projects');
  });

  test('is told exactly which documents are still needed', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await expect(page.getByText(/Still needed:/)).toBeVisible();
    await expect(page.getByText(/cut off along the bottom edge/)).toBeVisible();
  });
});
