import { expect, test, type Page } from '@playwright/test';

/**
 * The payroll register, through the real UI.
 *
 * The behaviour worth checking here is the refusal: a register that looks
 * settled while a correction is pending is one somebody pays from, so the
 * screen has to say what is outstanding rather than quietly round past it.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const LEAD = 'karan.mehta@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';

/** The seed fills the previous calendar month, which is what payroll is run for. */
function lastCompleteMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** The month in progress, whose attendance is by definition incomplete. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test.describe('the payroll register', () => {
  test('opens on the month that has finished, not the one in progress', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');

    await expect(page.getByRole('heading', { name: 'Payroll Register' })).toBeVisible();
    // Opening on the current month would mark every row not ready for reasons
    // nobody can act on yet.
    await expect(page.getByLabel('Month')).toHaveValue(lastCompleteMonth());
  });

  test('says the month is settled when nothing is outstanding', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');

    await expect(page.getByText('Every row is accounted for')).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Sneha Iyer');
  });

  test('docks unpaid days and shows what they cost', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');

    // Seeded: one trainer took two unpaid days in the month.
    const row = page.getByRole('row', { name: /Arjun Desai/ });
    await expect(row).toContainText('24');
    await expect(row).toContainText('₹55,385');
  });

  test('pays approved leave in full and still reports it', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');

    const row = page.getByRole('row', { name: /Meera Krishnan/ });
    await expect(row).toContainText('2 on leave');
    await expect(row).toContainText('₹60,000');
  });

  test('refuses to look final for a month still in progress', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');
    await page.getByLabel('Month').fill(currentMonth());

    await expect(page.getByText(/not ready to pay from/)).toBeVisible();
    await expect(page.getByText(/no attendance recorded/).first()).toBeVisible();
    await expect(
      page.getByText(/the figures will change after the file leaves here/),
    ).toBeVisible();
  });

  test('names the decision holding a row up, not just that one is', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');
    await page.getByLabel('Month').fill(currentMonth());

    // Seeded: a correction awaiting the lead, and leave nobody has decided.
    await expect(page.getByText('1 attendance correction awaiting a decision.')).toBeVisible();
    await expect(page.getByText('1 leave request still undecided.')).toBeVisible();
  });

  test('narrows to only what still needs doing', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');
    await page.getByLabel('Month').fill(currentMonth());
    await page.getByLabel('Only rows that still need something').check();

    await expect(page.getByRole('table')).toContainText('Not ready');
    await expect(page.getByText('Every row is accounted for')).toBeHidden();
  });

  test('says plainly that these are gross figures, not take-home pay', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/payroll');

    // The register is an input to payroll, not a payslip. Claiming otherwise
    // would be a number that looks official and is wrong.
    await expect(
      page.getByText(/statutory deductions are applied by your payroll system/),
    ).toBeVisible();
  });

  test('is open to a manager as well as HR', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/payroll');
    await expect(page.getByRole('heading', { name: 'Payroll Register' })).toBeVisible();
  });

  test('is refused to a lead and a trainer, and absent from their sidebar', async ({ page }) => {
    for (const account of [LEAD, TRAINER]) {
      await signIn(page, account);
      const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
      expect(nav).not.toContain('Payroll');

      await page.goto('/payroll');
      await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  });
});
