import { expect, test, type Page } from '@playwright/test';

/**
 * The feedback loop, through the real UI.
 *
 * Two things are worth proving here: that the evidence actually lands beside
 * the re-hire decision rather than in a tab nobody opens, and that a trainer
 * reading their own gets the scores without the words.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';
const ARJUN = 'arjun.desai@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openFeedbackFor(page: Page, name: RegExp): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
  await page.getByRole('row', { name }).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Feedback' }).click();
}

test.describe('feedback about a trainer', () => {
  test('summarises what has been said, and where it came from', async ({ page }) => {
    await signIn(page, HR);
    await openFeedbackFor(page, /Sneha Iyer/);

    const card = page.getByRole('region', { name: 'How they are rated' });
    await expect(card).toContainText('4.5');
    await expect(card).toContainText('Client');
    await expect(card).toContainText('Learner batch');
    await expect(card).toContainText('24 people');
  });

  test('refuses to treat a thin record as a verdict', async ({ page }) => {
    await signIn(page, HR);
    await openFeedbackFor(page, /Arjun Desai/);

    // One live review after a withdrawal. The number is shown; what is withheld
    // is the impression that it settles anything.
    await expect(page.getByText('Not enough to go on')).toBeVisible();
    await expect(page.getByText(/anecdote rather than a pattern/)).toBeVisible();
  });

  test('shows a withdrawn review as withdrawn, with the reason', async ({ page }) => {
    await signIn(page, HR);
    await openFeedbackFor(page, /Arjun Desai/);

    // Hiding it would make a withdrawal indistinguishable from a review nobody
    // ever wrote, which is the thing the record exists to prevent.
    await expect(page.getByText('Withdrawn').first()).toBeVisible();
    await expect(page.getByText(/Logged against the wrong trainer/)).toBeVisible();
    await expect(page.getByText(/1 withdrawn and excluded/)).toBeVisible();
  });

  test('records a new review, which cannot then be edited', async ({ page }) => {
    await signIn(page, MANAGER);
    // Meera has no seeded feedback, so this test writes without moving a figure
    // another test asserts on — and it exercises the first-review path.
    await openFeedbackFor(page, /Meera Krishnan/);

    await page.getByRole('button', { name: 'Record feedback' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('It cannot be edited afterwards');

    await dialog.getByLabel('Engagement').selectOption({ index: 1 });
    await dialog.getByLabel('Where it came from').selectOption('client');
    await dialog.getByLabel('Overall').selectOption('3');
    await dialog.getByLabel('Comment').fill('Slipped a little this term.');
    await dialog.getByRole('button', { name: 'Record it' }).click();

    await expect(page.getByText('Slipped a little this term.')).toBeVisible();
    // No edit anywhere on the row: a correction is a new review.
    const row = page.locator('li').filter({ hasText: 'Slipped a little this term.' });
    await expect(row.getByRole('button', { name: 'Edit' })).toBeHidden();
    await expect(row.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  });

  test('insists a learner batch says how many learners it covers', async ({ page }) => {
    await signIn(page, MANAGER);
    await openFeedbackFor(page, /Sneha Iyer/);

    await page.getByRole('button', { name: 'Record feedback' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Engagement').selectOption({ index: 1 });
    await dialog.getByLabel('Where it came from').selectOption('learner_batch');

    await expect(dialog.getByLabel('How many learners')).toBeVisible();
    // Blocked before submitting rather than refused after.
    await expect(dialog.getByRole('button', { name: 'Record it' })).toBeDisabled();
  });

  test('offers HR no way to withdraw one, because that is a manager’s call', async ({ page }) => {
    await signIn(page, HR);
    await openFeedbackFor(page, /Sneha Iyer/);

    await expect(page.getByRole('button', { name: 'Record feedback' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Withdraw' })).toBeHidden();
  });
});

test.describe('a trainer reading their own', () => {
  test('gets their scores and their breakdown', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    const card = page.getByRole('region', { name: 'How you are rated' });
    await expect(card).toContainText('4.5');
    await expect(card).toContainText('Learner batch');
  });

  test('does not get the comments or who wrote them', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await expect(page.getByText('Individual comments stay with whoever wrote them')).toBeVisible();
    // The seeded remark exists and must not reach this page.
    await expect(page.getByText('Best module of the term.')).toBeHidden();
    await expect(page.getByText(/recorded by/)).toBeHidden();
  });

  test('cannot record feedback about themselves', async ({ page }) => {
    await signIn(page, ARJUN);
    await page.goto('/my/profile');

    await expect(page.getByRole('button', { name: 'Record feedback' })).toBeHidden();
  });
});

test.describe('the loop back to the re-hire decision', () => {
  test('puts the rating in the Talent Pool, beside people we might take back', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    const row = page.getByRole('row', { name: /Rohit Varma/ });
    await expect(row).toContainText('4.33');
    await expect(row).toContainText('40 people');
  });

  test('says a candidate who never delivered has nothing to be rated on', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/pool');

    // Different from a low score, and said differently.
    await expect(page.getByRole('row', { name: /Priyanka Rane/ })).toContainText('Not rated');
  });

  test('shows the evidence on the deboarding, next to the box that decides it', async ({
    page,
  }) => {
    await signIn(page, HR);
    await page.goto('/deboarding');
    await page.getByRole('tab', { name: 'All history' }).click();
    await page
      .getByRole('row', { name: /Rohit Varma/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByText('How they were rated')).toBeVisible();
    await expect(page.getByText('Eligible for re-hire')).toBeVisible();
  });
});
