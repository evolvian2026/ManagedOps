import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toIstDateString } from '@managedops/shared';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * The commercial side, end to end against a real database.
 *
 * Two things are worth proving here and nowhere else: that a rate is only ever
 * visible to somebody who may see money, and that the margin a report claims is
 * the one the seeded facts actually add up to. The arithmetic itself is unit
 * tested; what these check is that the right facts reach it.
 */
let harness: Harness;
let manager: Session;
let hr: Session;
let lead: Session;
let trainer: Session;

let context: {
  clientId: string;
  projectId: string;
  trainerId: string;
  assignmentId: string;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/** A fixed, fully-worked window so the expected numbers are arithmetic, not luck. */
const PERIOD = { from: '2026-06-01', to: '2026-06-30' };

/** June 2026 has 30 days and four Sundays, so 26 working days on a six-day week. */
const WORKING_DAYS_IN_JUNE = 26;

async function buildEngagement(options: {
  dayRate: number | null;
  salaryAnnual: number;
  presentDays: number;
  absentDays?: number;
}) {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });

  const client = await harness.prisma.db.client.create({
    data: {
      id: newId(),
      name: 'Northwind Polytechnic',
      code: `NW-${Math.floor(Math.random() * 1_000_000)}`,
      defaultDayRate: 4000,
    },
  });

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Commercial Test Project',
      code: `CT-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: client.id,
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      managerId: managerUser!.id,
      hrId: hrUser!.id,
      leadTrainerId: leadUser!.id,
      weeklyOffDays: [0],
    },
  });

  const trainerRecord = await harness.prisma.db.trainer.create({
    data: {
      id: newId(),
      userId: trainerUser!.id,
      employeeCode: `CT-${Date.now() % 1_000_000}`,
      personalEmail: 'commercial@example.com',
      phone: '+919812345678',
      status: 'active',
      salaryAnnual: options.salaryAnnual,
    },
  });

  const assignment = await harness.prisma.db.assignment.create({
    data: {
      id: newId(),
      trainerId: trainerRecord.id,
      projectId: project.id,
      role: 'trainer',
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      billRatePerDay: options.dayRate,
    },
  });

  // Working days only, walked forward from the 1st and skipping Sundays, so the
  // statuses land where the calendar says work happens.
  const statuses = [
    ...Array.from({ length: options.presentDays }, () => 'present' as const),
    ...Array.from({ length: options.absentDays ?? 0 }, () => 'absent' as const),
  ];
  let day = new Date('2026-06-01T00:00:00Z');
  for (const status of statuses) {
    while (day.getUTCDay() === 0) day = new Date(day.getTime() + 86_400_000);
    await harness.prisma.db.attendanceRecord.create({
      data: { id: newId(), assignmentId: assignment.id, workDate: new Date(day), status },
    });
    day = new Date(day.getTime() + 86_400_000);
  }

  return {
    clientId: client.id,
    projectId: project.id,
    trainerId: trainerRecord.id,
    assignmentId: assignment.id,
  };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
  const managerUser = await harness.seedUser({ role: 'manager' });
  const hrUser = await harness.seedUser({ role: 'hr' });
  const leadUser = await harness.seedUser({ role: 'project_lead' });
  const trainerUser = await harness.seedUser({ role: 'trainer' });

  manager = await harness.signIn(managerUser.email);
  hr = await harness.signIn(hrUser.email);

  context = await buildEngagement({ dayRate: 5000, salaryAnnual: 720_000, presentDays: 26 });

  lead = await harness.signIn(leadUser.email);
  trainer = await harness.signIn(trainerUser.email);
});

/* ----------------------------------------------------------------- clients */

describe('the client directory', () => {
  it('lists clients with the projects currently running for them', async () => {
    const response = await harness.http().get('/api/v1/clients').set(auth(manager)).expect(200);

    const row = response.body.data.find((entry: { id: string }) => entry.id === context.clientId);
    expect(row.name).toBe('Northwind Polytechnic');
    expect(row._count.projects).toBe(1);
  });

  it('shows the contract rate to a manager', async () => {
    const response = await harness.http().get('/api/v1/clients').set(auth(manager)).expect(200);
    const row = response.body.data.find((entry: { id: string }) => entry.id === context.clientId);
    expect(Number(row.defaultDayRate)).toBe(4000);
  });

  it('withholds the rate from HR, who staff against the directory but do not price it', async () => {
    const response = await harness.http().get('/api/v1/clients').set(auth(hr)).expect(200);
    const row = response.body.data.find((entry: { id: string }) => entry.id === context.clientId);

    expect(row.name).toBe('Northwind Polytechnic');
    // Absent, not null: the field never leaves the database for this caller.
    expect(row).not.toHaveProperty('defaultDayRate');
  });

  it('withholds it on the detail page too, not only in the list', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/clients/${context.clientId}`)
      .set(auth(hr))
      .expect(200);
    expect(response.body).not.toHaveProperty('defaultDayRate');
  });

  it('is not readable by a project lead or a trainer at all', async () => {
    await harness.http().get('/api/v1/clients').set(auth(lead)).expect(403);
    await harness.http().get('/api/v1/clients').set(auth(trainer)).expect(403);
  });

  it('refuses a duplicate client code with a field error', async () => {
    const body = { name: 'Another', code: 'DUPE-1' };
    await harness.http().post('/api/v1/clients').set(auth(manager)).send(body).expect(201);

    const response = await harness
      .http()
      .post('/api/v1/clients')
      .set(auth(manager))
      .send({ ...body, name: 'Different name, same code' })
      .expect(422);
    expect(response.body.errors[0].path).toBe('code');
  });

  it('will not let HR create one, because commerce is not theirs', async () => {
    await harness
      .http()
      .post('/api/v1/clients')
      .set(auth(hr))
      .send({ name: 'Nope', code: 'NOPE-1' })
      .expect(403);
  });

  it('refuses to deactivate a client we are still delivering for', async () => {
    const response = await harness
      .http()
      .patch(`/api/v1/clients/${context.clientId}`)
      .set(auth(manager))
      .send({ status: 'inactive' })
      .expect(409);

    expect(response.body.detail).toMatch(/still has 1 active project/);
  });

  it('refuses to delete a client whose work is on record', async () => {
    const response = await harness
      .http()
      .delete(`/api/v1/clients/${context.clientId}`)
      .set(auth(manager))
      .expect(409);
    expect(response.body.detail).toMatch(/history must be kept/);
  });

  it('validates a GSTIN rather than storing whatever was typed', async () => {
    await harness
      .http()
      .post('/api/v1/clients')
      .set(auth(manager))
      .send({ name: 'Bad Tax Id', code: 'BAD-1', gstin: 'NOT-A-GSTIN' })
      .expect(422);
  });
});

/* ----------------------------------------------------------------- margins */

describe('the margin report', () => {
  it('adds up to exactly what the seeded facts say', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/billing/margin?from=${PERIOD.from}&to=${PERIOD.to}`)
      .set(auth(manager))
      .expect(200);

    const row = response.body.rows[0];
    // 26 days at ₹5,000 against a twelfth of ₹7,20,000 for a month worked whole.
    expect(row.billableDays).toBe(WORKING_DAYS_IN_JUNE);
    expect(row.revenue).toBe(130_000);
    expect(row.salaryCost).toBe(60_000);
    expect(row.margin).toBe(70_000);
  });

  it('charges half a month to an assignment that only delivered half of one', async () => {
    await resetDatabase(harness.prisma);
    const managerUser = await harness.seedUser({ role: 'manager' });
    await harness.seedUser({ role: 'hr' });
    await harness.seedUser({ role: 'project_lead' });
    await harness.seedUser({ role: 'trainer' });
    manager = await harness.signIn(managerUser.email);
    await buildEngagement({ dayRate: 5000, salaryAnnual: 720_000, presentDays: 13 });

    const response = await harness
      .http()
      .get(`/api/v1/billing/margin?from=${PERIOD.from}&to=${PERIOD.to}`)
      .set(auth(manager))
      .expect(200);

    // The denominator is the month, not the assignment: 13 of June's 26 working
    // days is half the month's salary, however long the assignment ran.
    expect(response.body.rows[0].salaryCost).toBe(30_000);
    expect(response.body.rows[0].revenue).toBe(65_000);
  });

  it('reports work with no agreed rate as unbilled rather than a loss', async () => {
    await resetDatabase(harness.prisma);
    const managerUser = await harness.seedUser({ role: 'manager' });
    await harness.seedUser({ role: 'hr' });
    await harness.seedUser({ role: 'project_lead' });
    await harness.seedUser({ role: 'trainer' });
    manager = await harness.signIn(managerUser.email);
    await buildEngagement({ dayRate: null, salaryAnnual: 720_000, presentDays: 26 });

    const response = await harness
      .http()
      .get(`/api/v1/billing/margin?from=${PERIOD.from}&to=${PERIOD.to}`)
      .set(auth(manager))
      .expect(200);

    const row = response.body.rows[0];
    expect(row.unbilled).toBe(true);
    expect(row.unbilledAssignments).toBe(1);
    expect(row.revenue).toBe(0);
    // The cost is real and still stated; the percentage is withheld because
    // dividing by no revenue would invent a number that means nothing.
    expect(row.salaryCost).toBe(60_000);
    expect(row.marginPercent).toBeNull();
  });

  it('groups the same money by project, trainer or client and totals the same', async () => {
    const totals = await Promise.all(
      ['project', 'trainer', 'client'].map(async (groupBy) => {
        const response = await harness
          .http()
          .get(`/api/v1/billing/margin?from=${PERIOD.from}&to=${PERIOD.to}&groupBy=${groupBy}`)
          .set(auth(manager))
          .expect(200);
        return response.body.totals.margin;
      }),
    );

    // Every grouping is a roll-up of the same per-assignment figures, so a
    // difference between them would mean one of the groupings is inventing money.
    expect(new Set(totals).size).toBe(1);
  });

  it('defaults to the current month when no period is given', async () => {
    const response = await harness
      .http()
      .get('/api/v1/billing/margin')
      .set(auth(manager))
      .expect(200);

    const today = toIstDateString(new Date());
    expect(response.body.from.slice(0, 7)).toBe(today.slice(0, 7));
    expect(response.body.to.slice(0, 7)).toBe(today.slice(0, 7));
  });

  it('refuses a period that ends before it starts', async () => {
    await harness
      .http()
      .get('/api/v1/billing/margin?from=2026-06-30&to=2026-06-01')
      .set(auth(manager))
      .expect(422);
  });

  it('is not readable by HR, a lead or a trainer', async () => {
    for (const session of [hr, lead, trainer]) {
      await harness.http().get('/api/v1/billing/margin').set(auth(session)).expect(403);
    }
  });

  it('exports the same figures as a CSV whose numbers are numbers', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/billing/margin/export.csv?from=${PERIOD.from}&to=${PERIOD.to}`)
      .set(auth(manager))
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.text).toMatch(/margin_inr/);
    // Unquoted and unprefixed, so the column adds up in a spreadsheet.
    expect(response.text).toMatch(/,70000,/);
  });
});

/* -------------------------------------------------------------------- rates */

describe('the rate on an assignment', () => {
  it('is inherited from the client contract when HR staffs a project', async () => {
    // A second project for the same client, because the trainer already holds a
    // live assignment on the first and a duplicate is refused by design.
    const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
    const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
    const second = await harness.prisma.db.project.create({
      data: {
        id: newId(),
        name: 'Second Engagement',
        code: `CT2-${Math.floor(Math.random() * 1_000_000)}`,
        clientId: context.clientId,
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        managerId: managerUser!.id,
        hrId: hrUser!.id,
      },
    });

    // Staffed by HR, who holds no billing capability at all: the rate has to
    // arrive from the contract, because they are given no way to type one.
    //
    // Part time, because the trainer already holds a full-time posting on the
    // first project and nobody is in two places at once — splitting them across
    // two engagements is the only way this second assignment can exist.
    await harness
      .http()
      .post(`/api/v1/trainers/${context.trainerId}/assignments`)
      .set(auth(hr))
      .send({
        projectId: second.id,
        role: 'trainer',
        startDate: '2026-07-01',
        leaveAllowanceDays: 3,
        allocationPercent: 40,
      })
      .expect(201);

    const created = await harness.prisma.db.assignment.findFirstOrThrow({
      where: { trainerId: context.trainerId, projectId: second.id },
    });
    expect(Number(created.billRatePerDay)).toBe(4000);
  });

  it('is not returned to HR even on the assignment they just created', async () => {
    const response = await harness.http().get('/api/v1/assignments').set(auth(hr)).expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    for (const row of response.body.data) {
      expect(row).not.toHaveProperty('billRatePerDay');
    }
  });

  it('is settable by a manager and refused to HR', async () => {
    await harness
      .http()
      .patch(`/api/v1/assignments/${context.assignmentId}/bill-rate`)
      .set(auth(manager))
      .send({ billRatePerDay: 7000 })
      .expect(200);

    await harness
      .http()
      .patch(`/api/v1/assignments/${context.assignmentId}/bill-rate`)
      .set(auth(hr))
      .send({ billRatePerDay: 9999 })
      .expect(403);

    const assignment = await harness.prisma.db.assignment.findUniqueOrThrow({
      where: { id: context.assignmentId },
    });
    expect(Number(assignment.billRatePerDay)).toBe(7000);
  });

  it('accepts null, because "not billed" is a real answer', async () => {
    await harness
      .http()
      .patch(`/api/v1/assignments/${context.assignmentId}/bill-rate`)
      .set(auth(manager))
      .send({ billRatePerDay: null })
      .expect(200);

    const assignment = await harness.prisma.db.assignment.findUniqueOrThrow({
      where: { id: context.assignmentId },
    });
    expect(assignment.billRatePerDay).toBeNull();
  });

  it('refuses a rate that is really an annual figure', async () => {
    await harness
      .http()
      .patch(`/api/v1/assignments/${context.assignmentId}/bill-rate`)
      .set(auth(manager))
      .send({ billRatePerDay: 9_000_000 })
      .expect(422);
  });

  it('never reaches a trainer or a lead listing their own assignments', async () => {
    for (const session of [trainer, lead]) {
      const response = await harness
        .http()
        .get('/api/v1/assignments')
        .set(auth(session))
        .expect(200);

      for (const row of response.body.data) {
        expect(row).not.toHaveProperty('billRatePerDay');
      }
    }
  });
});
