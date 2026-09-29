import { expect, test, type Page } from '@playwright/test';
import { generate } from 'otplib';

/**
 * The two things a person can change about their own account: where we reach
 * them, and how they prove who they are.
 *
 * The MFA half signs in as the one seeded account that already has an
 * authenticator. It is deliberately not one of the accounts the rest of the
 * suite uses — a TOTP code is single-use inside its thirty-second window, so an
 * account signed into dozens of times a minute would collide with itself.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const TRAINER = 'sneha.iyer@managedops.local';
const HR = 'ananya.sharma@managedops.local';
const SUPER_ADMIN = 'anoop.dcrust@gmail.com';
/** The seed's demo secret, overridable there and here by the same variable. */
const SECURED_SECRET = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** Seeded with an authenticator already set up; the secret is printed by the seed. */
const SECURED = 'security.demo@managedops.local';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}

async function signedIn(page: Page, email: string): Promise<void> {
  await signIn(page, email);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/**
 * Puts the master switch where a test needs it, rather than assuming.
 *
 * These tests share one seeded account and the switch persists, so a test that
 * assumed "on" would pass or fail on whichever ran before it. Setting it is
 * also the real user action, so nothing is faked to get there.
 */
async function setPhoneMessages(page: Page, on: boolean): Promise<void> {
  const card = page.getByRole('region', { name: 'How we reach you' });
  const wanted = card.getByRole('button', { name: on ? 'Turn off' : 'Turn on' });
  const toClick = card.getByRole('button', { name: on ? 'Turn on' : 'Turn off' });

  // Waiting for either button first, because the card renders a loading state
  // until the preferences arrive: asking which one is showing before then finds
  // neither, and reads that as "already in the state I wanted".
  await expect(wanted.or(toClick)).toBeVisible();
  if ((await toClick.count()) > 0) await toClick.click();
  await expect(wanted).toBeVisible();
}

test.describe('how we reach you', () => {
  test('shows the number masked, and what would be sent there', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'How we reach you' });
    // Enough to check the number is right, not enough to read over a shoulder.
    await expect(card).toContainText('+91 ••••••1002');
    await expect(card).toContainText('When a leave request of yours is approved or rejected');
  });

  test('does not promise an administrator messages they will never get', async ({ page }) => {
    await signedIn(page, HR);
    await page.goto('/my/account');

    // Every template is addressed to a trainer about their own work. Listing
    // them to HR advertised a channel that would stay silent.
    const card = page.getByRole('region', { name: 'How we reach you' });
    await expect(card).toContainText('nothing is currently sent to your phone');
    await expect(card).not.toContainText('When a leave request of yours');
  });

  test('refuses a number nothing could send to, and says why', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    await page.getByRole('button', { name: 'Change number' }).click();
    await page.getByLabel('New number').fill('011 2345 6789');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('alert')).toContainText(/Indian mobile number/);
  });

  test('normalises a number typed with a country code and spaces', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    await page.getByRole('button', { name: 'Change number' }).click();
    await page.getByLabel('New number').fill('+91 98111 22233');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('region', { name: 'How we reach you' })).toContainText(
      '+91 ••••••2233',
    );
  });

  test('turns messages to a phone off without losing the number', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'How we reach you' });
    await setPhoneMessages(page, true);
    await card.getByRole('button', { name: 'Turn off' }).click();

    await expect(card).toContainText('You will still get everything in the app and by email');
    await expect(card).toContainText('+91 ••••••');
  });

  test('offers a switch per kind of message, not one for all of them', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');
    await setPhoneMessages(page, true);

    const card = page.getByRole('region', { name: 'How we reach you' });
    // The point of the change: somebody who does not want a text about every
    // expense claim no longer has to turn the whole channel off and lose the
    // document reminders with it.
    await expect(
      card.getByRole('checkbox', { name: 'When an expense claim of yours is decided' }),
    ).toBeChecked();
    await expect(
      card.getByRole('checkbox', { name: 'When a leave request of yours is approved or rejected' }),
    ).toBeChecked();
  });

  test('says which message is always sent, and offers no switch for it', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'How we reach you' });
    await expect(card).toContainText('Always sent');
    // It goes out when the account is created, so a switch could never have
    // taken effect. A control that does nothing is worse than none.
    await expect(card.getByRole('checkbox', { name: 'When your account is created' })).toHaveCount(
      0,
    );
  });

  test('turns one kind off and leaves the others alone', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');
    await setPhoneMessages(page, true);

    const card = page.getByRole('region', { name: 'How we reach you' });
    const claims = card.getByRole('checkbox', {
      name: 'When an expense claim of yours is decided',
    });
    // Clicked rather than unchecked: the switch is server-authoritative, so it
    // reads "off" once the choice is stored, not the instant it is tapped.
    // Deliberately not optimistic — a preference that shows a state it has not
    // saved is the one that gets discovered on the day a message does arrive.
    await claims.click();

    await expect(claims).not.toBeChecked();
    await expect(
      card.getByRole('checkbox', { name: 'When a leave request of yours is approved or rejected' }),
    ).toBeChecked();

    // Survives a reload, so it was stored rather than only shown.
    await page.reload();
    await expect(
      card.getByRole('checkbox', { name: 'When an expense claim of yours is decided' }),
    ).not.toBeChecked();
  });

  test('keeps the choices visible when the channel is off, rather than hiding them', async ({
    page,
  }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'How we reach you' });
    await setPhoneMessages(page, false);

    // Hiding them would leave somebody turning the channel back on with no
    // idea what they had chosen underneath it.
    await expect(card).toContainText('Your choices are kept for if you turn them back on');
    await expect(
      card.getByRole('checkbox', { name: 'When a leave request of yours is approved or rejected' }),
    ).toBeDisabled();
  });

  test('says plainly that these govern the phone and nothing else', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'How we reach you' });
    await expect(card).toContainText('These govern your phone only');
  });
});

test.describe('signing in with a second factor', () => {
  test('asks an administrator for a code instead of letting them in', async ({ page }) => {
    await signIn(page, SECURED);

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    // The point of the whole feature: a correct password is not a session.
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  });

  test('refuses a wrong code and stays on the step', async ({ page }) => {
    await signIn(page, SECURED);

    await page.getByLabel('Six-digit code').fill('000000');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('alert')).toContainText(/not right/i);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  });

  test('lets them in with the right code', async ({ page }) => {
    await signIn(page, SECURED);
    await page.getByLabel('Six-digit code').fill(await generate({ secret: SECURED_SECRET }));
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('leaves a trainer alone, who can only see themselves', async ({ page }) => {
    await signedIn(page, TRAINER);
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeHidden();
  });
});

test.describe('the security section', () => {
  test('tells an administrator why their role needs one', async ({ page }) => {
    await signedIn(page, HR);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'Signing in' });
    await expect(card).toContainText('open identity documents');
    await expect(card).toContainText('see what people are paid');
  });

  test('offers a trainer one without insisting', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    const card = page.getByRole('region', { name: 'Signing in' });
    await expect(card).toContainText('does not require one');
    await expect(card.getByRole('button', { name: 'Add an authenticator' })).toBeVisible();
  });

  test('offers a QR code and the same secret as text', async ({ page }) => {
    await signedIn(page, TRAINER);
    await page.goto('/my/account');

    await page.getByRole('button', { name: 'Add an authenticator' }).click();
    // A laptop cannot scan its own screen, so the secret is offered both ways.
    await expect(page.getByAltText('Scan this with your authenticator app')).toBeVisible();
    await expect(page.getByLabel('Code from the app')).toBeVisible();
  });
});

test.describe('resetting somebody’s authenticator', () => {
  test('is offered only for an account that has one', async ({ page }) => {
    // The Users screen is `users.manage`, which is a super admin's alone.
    await signedIn(page, SUPER_ADMIN);
    await page.goto('/users');

    const secured = page.getByRole('row', { name: /security.demo/ });
    await expect(secured).toContainText('Authenticator set up');
    await expect(secured.getByRole('button', { name: 'Reset authenticator' })).toBeVisible();

    const trainerRow = page.getByRole('row', { name: /sneha.iyer/ });
    await expect(trainerRow).toContainText('No authenticator');
    await expect(trainerRow.getByRole('button', { name: 'Reset authenticator' })).toBeHidden();
  });
});
