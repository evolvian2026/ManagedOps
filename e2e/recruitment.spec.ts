import { expect, test, type Page } from '@playwright/test';

/**
 * The recruitment pipeline, driven through the real UI.
 *
 * These walk the journey the Onboarding screens exist for: a screening call
 * routes an applicant, a booking appears on the interview board, a result moves
 * them to the offer stage, and an answer closes it out.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const INTERVIEWER = 'rohit.verma@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openOnboarding(
  page: Page,
  tab: 'Open Positions' | 'Interview Pipeline' | 'Offer Letters',
) {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Onboarding' })).toBeVisible();
  await page.getByRole('tab', { name: new RegExp(tab) }).click();
}

test.describe('Open Positions', () => {
  test('shows a card per position with its applicant count', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Open Positions');

    const card = page.getByRole('button', { name: /Data Analytics Trainer/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText('4');
    await expect(card).toContainText('applicants');
  });

  test('opening a card reveals that position applicants', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Open Positions');

    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();
    await expect(page.getByRole('heading', { name: 'Data Analytics Trainer' })).toBeVisible();

    // Each row carries what the specification asks a row to carry.
    const table = page.getByRole('table');
    await expect(table).toContainText('Nikhil Joshi');
    await expect(table).toContainText('nikhil.joshi@example.com');
    await expect(table).toContainText('Resume');
  });

  test('going back returns to the card grid', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Open Positions');

    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();
    await page.getByRole('button', { name: '← All positions' }).click();
    await expect(page.getByRole('button', { name: /Data Analytics Trainer/ })).toBeVisible();
  });

  test('screening demands a reason to reject, then routes the applicant', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Open Positions');
    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();

    // Ritika is the seeded applicant left awaiting a screening call. Waiting for
    // the row rather than probing with isVisible keeps this deterministic — a
    // bare visibility check does not auto-wait, so it would skip while the table
    // was still loading and quietly prove nothing.
    const row = page.getByRole('row', { name: /Ritika Bansal/ });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Record call' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Record the screening call');

    // Rejecting reveals the reason field, and submitting without one is refused
    // with the server's own message rather than a generic stand-in.
    await dialog.getByRole('radio', { name: /Reject/ }).check();
    await expect(dialog.getByLabel('Reason for rejecting')).toBeVisible();
    await dialog.getByRole('button', { name: 'Record outcome' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/reason/i);

    // Switching to proceed moves them into the interview pipeline.
    await dialog.getByRole('radio', { name: /proceed with an interview/ }).check();
    await dialog.getByRole('button', { name: 'Move to interview' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole('row', { name: /Ritika Bansal/ })).toContainText('Interviewing');
  });
});

test.describe('Interview Pipeline', () => {
  test('shows the four counts per position', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Interview Pipeline');

    const card = page.getByRole('button', { name: /Data Analytics Trainer/ });
    await expect(card).toContainText('To schedule');
    await expect(card).toContainText('Scheduled');
    await expect(card).toContainText('Conducted');
    await expect(card).toContainText('Missed');
  });

  test('the three tabs each show their own rounds', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Interview Pipeline');
    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();

    await expect(page.getByRole('tab', { name: /Scheduled/ })).toBeVisible();

    await page.getByRole('tab', { name: /Conducted/ }).click();
    await expect(page.getByRole('table')).toContainText('Selected');

    await page.getByRole('tab', { name: /Missed/ }).click();
    await expect(page.getByRole('button', { name: 'Reschedule' }).first()).toBeVisible();
  });

  test('times are shown in IST, because that is the only zone in play', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Interview Pipeline');
    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();

    // The "to be scheduled" table has no times yet — the booked one does.
    await expect(page.getByRole('table', { name: /already booked/i })).toContainText('IST');
  });

  test('rescheduling books a new round and keeps the missed one', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Interview Pipeline');
    await page.getByRole('button', { name: /Data Analytics Trainer/ }).click();
    await page.getByRole('tab', { name: /Missed/ }).click();

    const reschedule = page.getByRole('button', { name: 'Reschedule' }).first();
    await expect(reschedule).toBeVisible();
    await reschedule.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('The missed one stays on the record.');
    await dialog.getByRole('button', { name: 'Book new round' }).click();
    await expect(dialog).toBeHidden();

    // The replacement lands under Scheduled; the missed round is still listed.
    await page.getByRole('tab', { name: /Scheduled/ }).click();
    await expect(page.getByRole('table').last()).toContainText('Round 2');
  });
});

test.describe('Offer Letters', () => {
  test('lists a sent offer with its salary in rupees', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Offer Letters');

    const table = page.getByRole('table');
    await expect(table).toContainText('Divya Menon');
    await expect(table).toContainText('Sent');
    // Indian digit grouping, not 780,000.
    await expect(table).toContainText('7,80,000');
  });

  test('filters sent offers by how the candidate answered', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Offer Letters');

    await page.getByRole('button', { name: 'Awaiting a reply' }).click();
    await expect(page.getByRole('table')).toContainText('Divya Menon');

    await page.getByRole('button', { name: 'Accepted', exact: true }).click();
    await expect(page.getByText('Nothing here')).toBeVisible();
  });

  test('recording a reply explains what each answer will do', async ({ page }) => {
    await signIn(page, HR);
    await openOnboarding(page, 'Offer Letters');

    const record = page.getByRole('button', { name: 'Record reply' }).first();
    await expect(record).toBeVisible();
    await record.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('consumes a seat on the position');
    await expect(dialog).toContainText('keeps them in the talent pool');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('who can see Onboarding', () => {
  test('an interviewer is refused the whole section', async ({ page }) => {
    await signIn(page, INTERVIEWER);
    await page.goto('/onboarding');

    // Interviewers hold no positions.read capability (spec 15.6).
    await expect(page.getByRole('heading')).toContainText('Not available to your role');
  });

  test('a trainer has no Onboarding link at all', async ({ page }) => {
    await signIn(page, TRAINER);
    const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
    expect(nav).not.toContain('Onboarding');
  });
});
