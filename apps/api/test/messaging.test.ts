import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { newId } from '../src/common/ids.js';

/**
 * Reaching somebody on their phone.
 *
 * These run over the log transport, which is not a stub that always says yes:
 * numbers in a reserved range fail, so the fallback from WhatsApp to SMS and
 * the recording of a failure are exercised by the same code that runs in
 * production rather than by a mock written to make the test pass.
 *
 * What is worth proving is mostly about restraint — that a message is *not*
 * sent to somebody who opted out, or to a number nobody has, and that neither
 * of those silently fails the decision that triggered it.
 */
let harness: Harness;
let notifications: NotificationsService;
let trainerSession: Session;

/** Fails on WhatsApp only, so SMS picks it up. */
const WHATSAPP_REFUSES = '+916000000012';
/** Fails on both. */
const BOTH_REFUSE = '+916000000112';
const GOOD_NUMBER = '+919812345678';

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

async function makeTrainerUser(options: {
  phone?: string | null;
  mobileNotifications?: boolean;
}): Promise<string> {
  const seeded = await harness.seedUser({ role: 'trainer' });
  await harness.prisma.db.user.update({
    where: { id: seeded.id },
    data: {
      phone: options.phone === undefined ? GOOD_NUMBER : options.phone,
      mobileNotifications: options.mobileNotifications ?? true,
    },
  });
  return seeded.id;
}

function deliveriesFor(userId: string) {
  return harness.prisma.db.messageDelivery.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}

beforeAll(async () => {
  harness = await createHarness();
  notifications = harness.app.get(NotificationsService);
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
});

afterAll(async () => {
  await harness.close();
});

describe('sending a message to a phone', () => {
  it('reaches a trainer on WhatsApp and does not also text them', async () => {
    const userId = await makeTrainerUser({});

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Your leave was approved',
      body: '12 Oct 2026.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha Iyer', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    const deliveries = await deliveriesFor(userId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.channel).toBe('whatsapp');
    expect(deliveries[0]!.status).toBe('sent');
    expect(deliveries[0]!.template).toBe('managedops_leave_decided');
    expect(deliveries[0]!.providerMessageId).toBeTruthy();
  });

  it('falls back to a text message when WhatsApp refuses', async () => {
    const userId = await makeTrainerUser({ phone: WHATSAPP_REFUSES });

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Your leave was approved',
      body: '12 Oct 2026.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha Iyer', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    // Both attempts are recorded, not just the one that worked. A channel that
    // keeps failing is a bill and an outage, and it is only visible if the
    // failures are kept.
    const deliveries = await deliveriesFor(userId);
    expect(deliveries.map((row) => [row.channel, row.status])).toEqual([
      ['whatsapp', 'failed'],
      ['sms', 'sent'],
    ]);
    expect(deliveries[0]!.error).toMatch(/rejected/);
  });

  it('records both failures rather than throwing when neither channel works', async () => {
    const userId = await makeTrainerUser({ phone: BOTH_REFUSE });

    await expect(
      notifications.notify({
        userIds: [userId],
        type: 'leave_decided',
        title: 'Your leave was approved',
        body: '12 Oct 2026.',
        mobile: {
          template: 'leave_decided',
          values: { name: 'Sneha Iyer', dates: '12 Oct 2026', outcome: 'approved' },
        },
      }),
    ).resolves.toBeUndefined();

    const deliveries = await deliveriesFor(userId);
    expect(deliveries.map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('still writes the in-app notification when the phone cannot be reached', async () => {
    // The decision happened. A provider outage must not be able to make it look
    // as though it did not.
    const userId = await makeTrainerUser({ phone: BOTH_REFUSE });

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Your leave was approved',
      body: '12 Oct 2026.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha Iyer', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    const inApp = await harness.prisma.db.notification.findMany({ where: { userId } });
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.title).toBe('Your leave was approved');
  });

  it('never stores a full mobile number in the delivery log', async () => {
    const userId = await makeTrainerUser({});

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Approved',
      body: '.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    const deliveries = await deliveriesFor(userId);
    expect(deliveries[0]!.toMasked).toBe('+91 ••••••5678');
    expect(deliveries[0]!.toMasked).not.toContain('9812');
  });
});

describe('when not to send', () => {
  it('skips somebody who has turned phone messages off, and says so', async () => {
    const userId = await makeTrainerUser({ mobileNotifications: false });

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Approved',
      body: '.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    const deliveries = await deliveriesFor(userId);
    // Recorded rather than passed over silently: "we chose not to" and "we
    // tried and could not" are different answers to the same question.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('skipped');
    expect(deliveries[0]!.error).toMatch(/opted out/i);
  });

  it('skips somebody with no number on file, and records a different reason', async () => {
    const userId = await makeTrainerUser({ phone: null });

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Approved',
      body: '.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    const deliveries = await deliveriesFor(userId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('skipped');
    // A number to collect, not a preference to respect — the two skips call for
    // different action, so they read differently.
    expect(deliveries[0]!.error).toMatch(/no usable mobile number/i);
  });

  it('sends nothing to a disabled account', async () => {
    const userId = await makeTrainerUser({});
    await harness.prisma.db.user.update({ where: { id: userId }, data: { status: 'disabled' } });

    await notifications.notify({
      userIds: [userId],
      type: 'leave_decided',
      title: 'Approved',
      body: '.',
      mobile: {
        template: 'leave_decided',
        values: { name: 'Sneha', dates: '12 Oct 2026', outcome: 'approved' },
      },
    });

    expect(await deliveriesFor(userId)).toHaveLength(0);
  });

  it('sends nothing when the notification carries no mobile intent', async () => {
    const userId = await makeTrainerUser({});

    await notifications.notify({
      userIds: [userId],
      type: 'flag_raised',
      title: 'A concern was raised',
      body: 'Repeated lateness.',
    });

    expect(await deliveriesFor(userId)).toHaveLength(0);
    expect(await harness.prisma.db.notification.count({ where: { userId } })).toBe(1);
  });
});

describe('the contact preferences endpoint', () => {
  beforeEach(async () => {
    const seeded = await harness.seedUser({ role: 'trainer' });
    await harness.prisma.db.user.update({
      where: { id: seeded.id },
      data: { phone: GOOD_NUMBER },
    });
    trainerSession = await harness.signIn(seeded.email);
  });

  it('shows the number masked, with what would be sent there', async () => {
    const response = await harness
      .http()
      .get('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .expect(200);

    expect(response.body.phoneMasked).toBe('+91 ••••••5678');
    expect(response.body.phone).toBe(GOOD_NUMBER);
    expect(response.body.mobileNotifications).toBe(true);
    expect(response.body.purposes.length).toBeGreaterThan(0);
  });

  it('normalises a number typed any of the ways people type one', async () => {
    const response = await harness
      .http()
      .patch('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .send({ phone: '098000-01002' })
      .expect(200);

    expect(response.body.phone).toBe('+919800001002');
  });

  it('refuses a number nothing could send to', async () => {
    const response = await harness
      .http()
      .patch('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .send({ phone: '011 2345 6789' })
      .expect(422);

    expect(JSON.stringify(response.body)).toMatch(/Indian mobile number/);
  });

  it('lets somebody remove their number entirely', async () => {
    const response = await harness
      .http()
      .patch('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .send({ phone: '' })
      .expect(200);

    expect(response.body.phone).toBeNull();
    expect(response.body.phoneMasked).toBeNull();
  });

  it('turns messages off without touching the number', async () => {
    const response = await harness
      .http()
      .patch('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .send({ mobileNotifications: false })
      .expect(200);

    expect(response.body.mobileNotifications).toBe(false);
    expect(response.body.phone).toBe(GOOD_NUMBER);
  });

  it('changes only the caller, never somebody else', async () => {
    const otherId = await makeTrainerUser({});
    await harness
      .http()
      .patch('/api/v1/notifications/preferences')
      .set(auth(trainerSession))
      .send({ mobileNotifications: false })
      .expect(200);

    const other = await harness.prisma.db.user.findUniqueOrThrow({ where: { id: otherId } });
    expect(other.mobileNotifications).toBe(true);
  });
});

describe('a decision a trainer is waiting on', () => {
  it('messages them when their leave is decided', async () => {
    // Driven through the real endpoint rather than the service, so the values
    // the template renders are the ones the decision actually produced.
    const world = await buildLeaveWorld();

    await harness
      .http()
      .post(`/api/v1/leave-requests/${world.leaveId}/decide`)
      .set(auth(world.approver))
      .send({ decision: 'approved' })
      .expect(200);

    const deliveries = await deliveriesFor(world.trainerUserId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.template).toBe('managedops_leave_decided');
    expect(deliveries[0]!.notificationType).toBe('leave_decided');
    expect(deliveries[0]!.entityId).toBe(world.leaveId);
  });
});

/** A project, an assignment and one submitted leave request to decide. */
async function buildLeaveWorld() {
  const managerSeed = await harness.seedUser({ role: 'manager' });
  const hrSeed = await harness.seedUser({ role: 'hr' });
  const trainerSeed = await harness.seedUser({ role: 'trainer' });
  await harness.prisma.db.user.update({
    where: { id: trainerSeed.id },
    data: { phone: GOOD_NUMBER },
  });
  const client = await harness.seedClient('Messaging Client');

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Messaging Project',
      code: `MSG-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: client.id,
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      managerId: managerSeed.id,
      hrId: hrSeed.id,
    },
  });

  const trainer = await harness.prisma.db.trainer.create({
    data: {
      id: newId(),
      userId: trainerSeed.id,
      employeeCode: `MSG-${Math.floor(Math.random() * 1_000_000)}`,
      personalEmail: `messaging-${Math.random()}@example.com`,
      phone: GOOD_NUMBER,
      status: 'active',
      joiningDate: new Date('2026-01-01T00:00:00Z'),
    },
  });

  const assignment = await harness.prisma.db.assignment.create({
    data: {
      id: newId(),
      trainerId: trainer.id,
      projectId: project.id,
      role: 'trainer',
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
    },
  });

  // A working day well ahead, so no weekend or holiday rule refuses it.
  const day = nextWorkingDay(30);
  const leave = await harness.prisma.db.leaveRequest.create({
    data: {
      id: newId(),
      assignmentId: assignment.id,
      startDate: new Date(`${day}T00:00:00Z`),
      endDate: new Date(`${day}T00:00:00Z`),
      dayType: 'full',
      daysCount: 1,
      unpaidDays: 0,
      reason: 'A family commitment',
      status: 'submitted',
    },
  });

  return {
    leaveId: leave.id,
    trainerUserId: trainerSeed.id,
    approver: await harness.signIn(managerSeed.email),
  };
}

/** Sunday is the weekly off, and leave on one is refused before it is decided. */
function nextWorkingDay(offset: number): string {
  const day = new Date(Date.now() + offset * 86_400_000);
  while (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
