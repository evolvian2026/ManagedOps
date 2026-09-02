import { expect, test, type Page } from '@playwright/test';

/**
 * Delivery operations, driven through the real UI against seeded data.
 *
 * These follow the trainer's day and the approver's queue, because that is
 * where the phase's rules actually meet a person: a punch that succeeds without
 * a location, a day that stays visibly open until somebody decides on it, a
 * claim that HR can see and cannot approve.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const HR = 'ananya.sharma@managedops.local';
const MANAGER = 'priya.nair@managedops.local';
const LEAD = 'karan.mehta@managedops.local';
const TRAINER = 'meera.krishnan@managedops.local';
/** Seeded with a fortnight of attendance, an open correction and a claim. */
const SNEHA = 'sneha.iyer@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openMyWork(page: Page, tab: string): Promise<void> {
  await page.goto('/my/work');
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  await page.getByRole('tab', { name: tab }).click();
}

/**
 * The working days the seed wrote attendance for, newest first — the same rule
 * `recentWorkingDays` uses in `prisma/seed.ts`, restated here so these tests
 * know where the history actually is. A fortnight of it straddles a month
 * boundary for most of the month, and the attendance tab opens on today's.
 */
function seededWorkingDays(count: number): Date[] {
  const days: Date[] = [];
  for (let offset = 1; days.length < count; offset += 1) {
    const day = new Date(Date.now() - offset * 86_400_000);
    if (day.getUTCDay() !== 0) days.push(day);
  }
  return days;
}

/** Opens the attendance tab on the month holding the seeded correction. */
async function openSeededAttendanceMonth(page: Page): Promise<void> {
  await openMyWork(page, 'Attendance');
  await expect(page.getByRole('table')).toBeVisible();

  // The day left open is the second most recent working day (see the seed).
  const target = seededWorkingDays(2)[1]!.toISOString().slice(0, 7);
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (target !== thisMonth) {
    await page.getByRole('button', { name: '← Previous' }).click();
    await expect(page.getByRole('table')).toBeVisible();
  }
}

test.describe('the punch card', () => {
  test('offers one clear action and explains the day', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/work');

    const card = page.getByRole('button', { name: /Punch in|Punch out/ });
    await expect(card).toBeVisible();
    await expect(page.getByText(/Day starts 09:00 IST, 15 minutes grace/)).toBeVisible();
  });

  test('asks for consent before the first punch, and says location is optional', async ({
    page,
  }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/work');

    await page.getByRole('button', { name: 'Punch in' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/records the coordinates your browser reports/)).toBeVisible();
    // No geofence: the notice has to say so, because that is the actual rule.
    await expect(dialog.getByText(/your punch still succeeds/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
  });

  test('records a punch even when the browser never answers about location', async ({
    page,
    context,
  }) => {
    // No geolocation permission granted, and headless Chromium answers neither
    // callback. The punch must still go through, recorded without coordinates.
    await context.clearPermissions();
    await signIn(page, TRAINER);
    await page.goto('/my/work');

    await page.getByRole('button', { name: 'Punch in' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /I understand/ })
      .click();

    await expect(page.getByRole('button', { name: 'Punch out' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Punched in')).toBeVisible();
  });
});

test.describe('a trainer looking at their attendance', () => {
  test('accounts for every past day, weekly offs included', async ({ page }) => {
    await signIn(page, SNEHA);
    await openSeededAttendanceMonth(page);

    // Sundays are derived from the project calendar, never stored per trainer.
    await expect(page.getByText('Weekly off').first()).toBeVisible();
    await expect(page.getByText('from the project calendar').first()).toBeVisible();
  });

  test('shows the day left open as awaiting a decision', async ({ page }) => {
    await signIn(page, SNEHA);
    await openSeededAttendanceMonth(page);

    await expect(page.getByText('Correction pending').first()).toBeVisible();
    await expect(page.getByText('Awaiting a decision').first()).toBeVisible();
  });

  test('does not call today an absence before the day is over', async ({ page }) => {
    await signIn(page, SNEHA);
    await openMyWork(page, 'Attendance');
    await expect(page.getByRole('table')).toBeVisible();

    // Nobody has punched today, and the day is not over. Calling it an absence
    // would be a prediction; the nightly close is what decides.
    const today = new Date().toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    const row = page.getByRole('row').filter({ hasText: today });
    await expect(row).not.toContainText('Absent');
  });
});

test.describe('the daily log', () => {
  test('shows recorded sessions as locked', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Daily Log');

    await expect(page.getByRole('table')).toContainText('React component model and JSX');
    await expect(page.getByText('Locked').first()).toBeVisible();
  });

  test('records a new session and numbers it', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Daily Log');

    const topic = `Playwright session ${Date.now()}`;
    await page.getByLabel('Topic').fill(topic);
    await page.getByRole('button', { name: 'Save session' }).click();

    await expect(page.getByRole('table')).toContainText(topic, { timeout: 15_000 });
  });
});

test.describe('deliverables', () => {
  test('separates the syllabus from other duties and counts progress', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Deliverables');

    await expect(page.getByRole('heading', { name: 'Syllabus' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Other duties' })).toBeVisible();
    // Five syllabus items, theirs alone — a lead reads their whole project, but
    // the screen that says "my" asks for `mine=true`.
    await expect(page.getByText(/of 5 complete/)).toBeVisible();
  });

  test('shows a lead only their own, not their whole project', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Deliverables');

    // Sneha is on the same project and has the same five syllabus items. If the
    // screen were project-scoped this would read "of 10 complete".
    await expect(page.getByText(/of 10 complete/)).toBeHidden();
  });

  test('marks an item complete and lets it be reopened', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Deliverables');

    const item = page.getByRole('listitem').filter({ hasText: 'Weekly progress report' });
    await item.getByRole('button', { name: 'Mark complete' }).click();
    await expect(item.getByRole('button', { name: 'Reopen' })).toBeVisible({ timeout: 15_000 });

    await item.getByRole('button', { name: 'Reopen' }).click();
    await expect(item.getByRole('button', { name: 'Mark complete' })).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('resources', () => {
  test('lists what is in the trainer’s hands with its serial', async ({ page }) => {
    await signIn(page, LEAD);
    await openMyWork(page, 'Resources');

    await expect(page.getByRole('table')).toContainText('Dell Latitude 5440');
    await expect(page.getByRole('table')).toContainText('DL5440-0001');
  });
});

test.describe('leave', () => {
  test('shows the balance and says it belongs to the assignment', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/leave');

    await expect(page.getByRole('heading', { name: 'My Leave' })).toBeVisible();
    await expect(page.getByText('days remaining')).toBeVisible();
    await expect(page.getByText(/per assignment and does not carry over/)).toBeVisible();
  });

  test('warns that days beyond the balance would be unpaid, without blocking', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/my/leave');

    const from = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel('From').fill(from);
    await page.getByLabel('To').fill(to);
    await page.getByLabel('Reason').fill('Testing the overage warning.');

    await expect(page.getByText(/recorded as leave without pay/)).toBeVisible();
    // Still submittable — the approver decides, not the browser.
    await expect(page.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  test('a trainer sees only their own requests', async ({ page }) => {
    await signIn(page, SNEHA);
    await page.goto('/my/leave');

    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('Medical appointment');
    await expect(table).not.toContainText('Family wedding in Nashik');
  });
});

test.describe('reimbursements', () => {
  test('says proof is required before a claim can be assessed', async ({ page }) => {
    await signIn(page, SNEHA);
    await page.goto('/my/reimbursements');

    await expect(page.getByText(/a claim without proof cannot be assessed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit claim' })).toBeDisabled();
  });

  test('shows the trainer their own claim and where it stands', async ({ page }) => {
    await signIn(page, SNEHA);
    await page.goto('/my/reimbursements');

    const table = page.getByRole('table');
    await expect(table).toContainText('₹12,500');
    await expect(table).toContainText('Submitted');
  });
});

test.describe('the approvals queue', () => {
  test('gathers corrections, leave and claims for a manager', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/approvals');

    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Attendance/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Leave/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Claims/ })).toBeVisible();
  });

  test('shows the correction with both the recorded and the requested times', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/approvals');

    const table = page.getByRole('table');
    await expect(table).toContainText('Sneha Iyer');
    await expect(table).toContainText(/left without punching out/);

    // Real clock times, not a fixed slice off a formatted timestamp — that
    // turns "8:51 am" into "51 am" and reads as nonsense in the queue. Asserted
    // on the cell rather than the table, because the table's text runs the
    // cells together and "…2026in 08:51 am" has no word boundary to anchor to.
    const recorded = page.getByRole('cell').filter({ hasText: /^in .*out /s });
    await expect(recorded.first()).toContainText(/in \d{1,2}:\d{2}\s?(am|pm)/i);
    await expect(recorded.last()).toContainText(/out \d{1,2}:\d{2}\s?(am|pm)/i);
  });

  test('insists on a reason before a correction can be rejected', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/approvals');

    await page.getByRole('button', { name: 'Reject' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Reject correction' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('flags a claim above HR’s limit as needing a manager', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/approvals');
    await page.getByRole('tab', { name: /Claims/ }).click();

    await expect(page.getByText('Needs a manager')).toBeVisible();
    // The API refuses it too; disabling it here makes the refusal visible first.
    await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  test('lets a manager approve the same claim', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/approvals');
    await page.getByRole('tab', { name: /Claims/ }).click();

    await expect(page.getByText('Needs a manager')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  test('shows a project lead only the queues they decide', async ({ page }) => {
    await signIn(page, LEAD);
    await page.goto('/approvals');

    await expect(page.getByRole('tab', { name: /Leave/ })).toBeVisible();
    // A lead approves attendance and leave, never expense claims.
    await expect(page.getByRole('tab', { name: /Claims/ })).toBeHidden();
  });
});

test.describe('flags', () => {
  test('lists the open concern with its severity and who raised it', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/flags');

    const table = page.getByRole('table');
    await expect(table).toContainText('Arjun Desai');
    await expect(table).toContainText('Medium');
    await expect(table).toContainText('Karan Mehta');
  });

  test('requires both an action and a note to close one', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/flags');

    await page.getByRole('button', { name: 'Record outcome' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Action taken')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close this flag' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('is not reachable by the trainer it concerns', async ({ page }) => {
    await signIn(page, TRAINER);
    await page.goto('/flags');

    await expect(page.getByRole('heading', { name: 'Not available to your role' })).toBeVisible();
  });
});

test.describe('the trainer profile, operationally', () => {
  test('carries the operational tabs for an administrator', async ({ page }) => {
    await signIn(page, HR);
    await page.goto('/projects');
    await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByRole('tab', { name: 'Attendance' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Daily Log' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Claims' })).toBeVisible();

    await page.getByRole('tab', { name: 'Claims' }).click();
    await expect(page.getByRole('table')).toContainText('₹12,500');
  });

  test('shows a lead their team member’s attendance but not their claims', async ({ page }) => {
    await signIn(page, LEAD);
    await page.goto('/projects');
    await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();
    await page
      .getByRole('row', { name: /Sneha Iyer/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByRole('tab', { name: 'Attendance' })).toBeVisible();
    // reimbursements.approve is not a lead's, so the tab is simply absent.
    await expect(page.getByRole('tab', { name: 'Claims' })).toBeHidden();
  });
});

test.describe('the roster', () => {
  test('now shows today’s attendance rather than "not recorded"', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/projects');
    await page.getByRole('button', { name: /Full Stack Bootcamp/ }).click();

    // Phase 2 could only say "Not recorded"; phase 3 has the record to show.
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('table')).toContainText('MO-2026-0001');
  });
});
