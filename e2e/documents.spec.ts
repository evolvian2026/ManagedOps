import { expect, test, type Page } from '@playwright/test';

/**
 * Documents that lapse, through the real UI.
 *
 * The behaviour worth checking is the one an absent date makes easy to get
 * wrong: a police verification with no expiry is on the queue, not off it,
 * because it is worth exactly as much as an expired one.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test.describe('the document compliance queue', () => {
  test('lists what has lapsed and says why it matters', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/documents');

    await expect(page.getByRole('heading', { name: 'Document Compliance' })).toBeVisible();
    await expect(page.getByText(/already expired/)).toBeVisible();
    await expect(page.getByText(/may refuse the trainer access to site/)).toBeVisible();
  });

  test('shows all three states, including a document nobody dated', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/documents');

    const table = page.getByRole('table');
    await expect(table).toContainText('Expired');
    await expect(table).toContainText('Expiring soon');
    // The one that is easiest to treat as fine, and is not.
    await expect(table).toContainText('No date');
    await expect(table).toContainText(/nobody can tell whether this is still current/);
  });

  test('narrows to one state at a time', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/documents');

    await page.getByLabel('Show').selectOption('expired');
    await expect(page.getByRole('table')).toContainText('Expired');
    await expect(page.getByRole('table')).not.toContainText('Expiring soon');
  });

  test('leaves out documents that cannot expire at all', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/documents');

    // A degree certificate does not stop being true.
    await expect(page.getByRole('table')).not.toContainText('Education certificate');
    await expect(page.getByRole('table')).not.toContainText('Aadhaar');
  });

  test('shows a trainer only their own', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/documents');

    const table = page.getByRole('table');
    await expect(table).toContainText('Sneha Iyer');
    await expect(table).not.toContainText('Arjun Desai');
  });

  test('offers a manager no way to open the document itself', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/documents');

    // Seeing that it lapsed is not the same question as being allowed to read
    // it — the rule the checklist already follows.
    await expect(page.getByRole('table')).toContainText('On file');
    await expect(page.getByRole('button', { name: 'Open' })).toBeHidden();
  });
});

test.describe('expiry on the checklist', () => {
  test('shows when a document runs out, and marks an expired one', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/projects');
    await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.getByRole('tab', { name: 'Documents' }).click();

    await expect(page.getByText(/Expired \d+ days ago/)).toBeVisible();
    await expect(page.getByText(/Expires \d/).first()).toBeVisible();
  });

  test('says nothing about expiry for a document that does not have one', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    const aadhaar = page.locator('li').filter({ hasText: 'Aadhaar' }).first();
    await expect(aadhaar).toBeVisible();
    await expect(aadhaar).not.toContainText('Expires');
  });
});
