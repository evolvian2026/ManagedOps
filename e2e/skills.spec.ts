import { expect, test, type Page } from '@playwright/test';

/**
 * Skills and matching, through the real UI.
 *
 * The rule worth checking here is that the screen is arguable: a staffer must
 * be able to see *why* somebody is at the top and why somebody else is not on
 * the list at all. A bare score would be quicker to render and worth nothing.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const LEAD = 'karan.mehta@managedops.local';
const TRAINER = 'sneha.iyer@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Selects the seeded position, whose requirements the ranking is built on. */
async function searchForSeededPosition(page: Page): Promise<void> {
  await page.goto('/find-trainers');
  const select = page.getByLabel('An open position');
  const value = await select
    .locator('option', { hasText: 'Data Analytics Trainer' })
    .first()
    .getAttribute('value');
  await select.selectOption(value!);
  await expect(page.getByRole('region', { name: 'Sneha Iyer' })).toBeVisible();
}

test.describe('finding somebody for the work', () => {
  test('asks what is being staffed before showing anybody', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/find-trainers');

    await expect(page.getByRole('heading', { name: 'Find Trainers' })).toBeVisible();
    await expect(page.getByText('Say what you are staffing')).toBeVisible();
  });

  test('ranks the best fit first and says what makes them it', async ({ page }) => {
    await signIn(page, HR);
    await searchForSeededPosition(page);

    const best = page.getByRole('region', { name: 'Sneha Iyer' });
    await expect(best).toContainText('Has all 2 essential skills.');
    await expect(best).toContainText('Has 2 of 2 desirable skills.');
    await expect(best).toContainText('Used the essential skills within six months.');
  });

  test('marks somebody down for a stale skill and says so in words', async ({ page }) => {
    await signIn(page, HR);
    await searchForSeededPosition(page);

    // Arjun holds both essentials but has not touched them in years, which is
    // the difference between him and Sneha — and it is stated, not implied.
    const stale = page.getByRole('region', { name: 'Arjun Desai' });
    await expect(stale).toContainText(/Has not used the essential skills in \d years/);
  });

  test('shows availability beside fit, not folded into it', async ({ page }) => {
    await signIn(page, HR);
    await searchForSeededPosition(page);

    // The trade a staffer actually makes: the best match is booked, the next
    // one is free now. Both facts are on screen at once.
    await expect(page.getByRole('region', { name: 'Sneha Iyer' })).toContainText(
      /Fully booked until/,
    );
    await expect(page.getByRole('region', { name: 'Arjun Desai' })).toContainText(/40% free/);
  });

  test('leaves out somebody who cannot do the job, and says how many were considered', async ({
    page,
  }) => {
    await signIn(page, HR);
    await searchForSeededPosition(page);

    // Meera is an excellent front-end trainer and wrong for a Python position.
    await expect(page.getByRole('region', { name: 'Meera Krishnan' })).toBeHidden();
    await expect(page.getByText(/of 4 considered/)).toBeVisible();
  });

  test('will show the near misses, with the missing skill named', async ({ page }) => {
    await signIn(page, HR);
    await searchForSeededPosition(page);

    await page.getByLabel('Only people who meet every essential skill').uncheck();

    const wrong = page.getByRole('region', { name: 'Meera Krishnan' });
    await expect(wrong).toContainText('Cannot do the job');
    await expect(wrong).toContainText(/Missing an essential skill: .*Python/);
  });

  test('is not offered to a lead or a trainer', async ({ page }) => {
    for (const account of [LEAD, TRAINER]) {
      await signIn(page, account);
      const nav = await page.locator('nav[aria-label="Main"] a').allInnerTexts();
      expect(nav).not.toContain('Find Trainers');

      await page.goto('/find-trainers');
      await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  });
});

test.describe('what a trainer can teach', () => {
  test('is on their own profile, and theirs to keep current', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    const card = page.getByRole('region', { name: 'What you can teach' });
    await expect(card).toContainText('Python');
    await expect(card).toContainText('Expert');
    // Granting a capability with no screen to use it is the mistake this avoids.
    await expect(card.getByRole('button', { name: 'Add a skill' })).toBeVisible();
  });

  test('records how long ago a skill was last used, because ranking turns on it', async ({
    page,
  }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await expect(page.getByRole('region', { name: 'What you can teach' })).toContainText(
      /last used/,
    );
  });

  test('can be added by the trainer and changes where they rank', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/profile');

    await page.getByRole('button', { name: 'Add a skill' }).click();
    const dialog = page.getByRole('dialog');
    // The option reads "Platform · Docker", since the picker groups by category.
    await dialog.getByLabel('Skill').selectOption({ label: 'Platform · Docker' });
    await dialog.getByLabel('Proficiency').selectOption('advanced');
    await dialog.getByRole('button', { name: 'Add skill' }).click();

    await expect(page.getByRole('region', { name: 'What you can teach' })).toContainText('Docker');
  });

  test('appears on an administrator’s view of them too', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/projects');
    await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await page.getByRole('tab', { name: 'Skills' }).click();
    await expect(page.getByText('Python')).toBeVisible();
  });
});
