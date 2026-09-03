import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toIstDateString } from '@managedops/shared';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';
import { AttendanceService } from '../src/modules/operations/attendance.service.js';
import { OperationsJobs } from '../src/jobs/operations-jobs.js';

/**
 * Delivery operations against a real database.
 *
 * The rules under test are the ones that decide whether a month of attendance
 * can be trusted: one punch pair per day enforced by an index rather than a
 * check, a day that stays open until somebody closes it, leave that writes the
 * days it covers, a serial that has to come back matching, and a spending limit
 * that a second endpoint cannot step around.
 */
let harness: Harness;
let hr: Session;
let manager: Session;
let lead: Session;
let trainer: Session;

/** Set up once and reused: the project, its people and their assignments. */
let context: {
  projectId: string;
  trainerId: string;
  trainerUserId: string;
  assignmentId: string;
  leadTrainerId: string;
  leadAssignmentId: string;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function dayOffset(days: number): string {
  return toIstDateString(new Date(Date.now() + days * 86_400_000));
}

async function confirmedFile(uploaderId: string): Promise<string> {
  const id = newId();
  await harness.prisma.db.fileObject.create({
    data: {
      id,
      storageKey: `proof/${id}/receipt.pdf`,
      originalName: 'receipt.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4096,
      uploadedById: uploaderId,
      confirmedAt: new Date(),
      scanStatus: 'skipped',
    },
  });
  return id;
}

/**
 * Builds a project with a lead and a trainer on it, directly through Prisma.
 *
 * The recruitment and onboarding paths that would normally produce these are
 * covered by their own suites; repeating them here would make every operations
 * test depend on two other modules staying green.
 */
async function buildProject() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Operations Test Project',
      code: `OPS-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: (await harness.seedClient()).id,
      startDate: new Date(`${dayOffset(-30)}T00:00:00Z`),
      status: 'active',
      managerId: managerUser!.id,
      hrId: hrUser!.id,
      leadTrainerId: leadUser!.id,
      workStartTime: '09:00',
      graceMinutes: 15,
      weeklyOffDays: [0],
    },
  });

  const makeTrainer = async (userId: string, code: string, role: 'lead' | 'trainer') => {
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId,
        employeeCode: code,
        personalEmail: `${code.toLowerCase()}@example.com`,
        phone: '+919812345678',
        status: 'active',
        salaryAnnual: 720000,
      },
    });
    const assignment = await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: record.id,
        projectId: project.id,
        role,
        startDate: new Date(`${dayOffset(-30)}T00:00:00Z`),
        status: 'active',
        leaveAllowanceDays: 3,
      },
    });
    return { trainerId: record.id, assignmentId: assignment.id };
  };

  const leadRecord = await makeTrainer(leadUser!.id, `OPS-L-${Date.now() % 100000}`, 'lead');
  const trainerRecord = await makeTrainer(
    trainerUser!.id,
    `OPS-T-${Date.now() % 100000}`,
    'trainer',
  );

  return {
    projectId: project.id,
    trainerId: trainerRecord.trainerId,
    trainerUserId: trainerUser!.id,
    assignmentId: trainerRecord.assignmentId,
    leadTrainerId: leadRecord.trainerId,
    leadAssignmentId: leadRecord.assignmentId,
  };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
  const hrUser = await harness.seedUser({ role: 'hr' });
  const managerUser = await harness.seedUser({ role: 'manager' });
  const leadUser = await harness.seedUser({ role: 'project_lead' });
  const trainerUser = await harness.seedUser({ role: 'trainer' });

  hr = await harness.signIn(hrUser.email);
  manager = await harness.signIn(managerUser.email);

  context = await buildProject();

  // Signed in after the trainer profiles exist, so the tokens carry them.
  lead = await harness.signIn(leadUser.email);
  trainer = await harness.signIn(trainerUser.email);
});

/* -------------------------------------------------------------- attendance */

describe('punching in and out', () => {
  it('records a punch-in without being told which assignment', async () => {
    const response = await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({ lat: 18.52043, lng: 73.856743, locationConsent: true })
      .expect(201);

    expect(response.body.assignment.id).toBe(context.assignmentId);
    expect(['present', 'late']).toContain(response.body.status);
    expect(response.body.locationStatus).toBe('captured');
  });

  it('succeeds without a location and says so, rather than refusing the punch', async () => {
    const response = await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    expect(response.body.locationStatus).toBe('unavailable');
    expect(response.body.punchInAt).toBeTruthy();
  });

  it('refuses half a location, because half a position is not a position', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({ lat: 18.52043 })
      .expect(422);
  });

  it('refuses a second punch-in on the same day', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    const second = await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(409);

    expect(second.body.detail).toMatch(/already punched in|punched in at/i);
  });

  it('is impossible to create two records for one day even past the check', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    // Straight at the database, bypassing every service-level guard: the unique
    // index is what actually holds this invariant.
    await expect(
      harness.prisma.db.attendanceRecord.create({
        data: {
          id: newId(),
          assignmentId: context.assignmentId,
          workDate: new Date(`${dayOffset(0)}T00:00:00Z`),
          status: 'present',
        },
      }),
    ).rejects.toThrow();
  });

  it('will not punch out before punching in', async () => {
    const response = await harness
      .http()
      .post('/api/v1/attendance/punch-out')
      .set(auth(trainer))
      .send({})
      .expect(409);

    expect(response.body.detail).toMatch(/not punched in/i);
  });

  it('closes the day on punch-out', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);
    const out = await harness
      .http()
      .post('/api/v1/attendance/punch-out')
      .set(auth(trainer))
      .send({})
      .expect(200);

    expect(out.body.punchOutAt).toBeTruthy();
    expect(['present', 'late']).toContain(out.body.status);
  });

  it('tells the trainer which action is available and why', async () => {
    const before = await harness
      .http()
      .get('/api/v1/attendance/today')
      .set(auth(trainer))
      .expect(200);
    expect(before.body.action).toBe('punch_in');

    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    const after = await harness
      .http()
      .get('/api/v1/attendance/today')
      .set(auth(trainer))
      .expect(200);
    expect(after.body.action).toBe('punch_out');
  });

  it('refuses a punch from an account with no trainer profile', async () => {
    // HR does not hold attendance.punch at all, so the guard turns it away
    // before the service has to explain itself.
    await harness.http().post('/api/v1/attendance/punch-in').set(auth(hr)).send({}).expect(403);
  });
});

describe('the nightly close', () => {
  it('leaves an open day as missing_punch_out and writes an absence for nobody', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    const jobs = harness.app.get(OperationsJobs);
    await jobs.closeAttendanceDay();

    const open = await harness.prisma.db.attendanceRecord.findFirst({
      where: { assignmentId: context.assignmentId },
    });
    expect(open?.status).toBe('missing_punch_out');

    // The lead never punched, so they are absent for the day.
    const leadDay = await harness.prisma.db.attendanceRecord.findFirst({
      where: { assignmentId: context.leadAssignmentId },
    });
    expect(leadDay?.status).toBe('absent');
    expect(leadDay?.source).toBe('system');
  });

  it('can be run twice without changing what it already decided', async () => {
    const attendance = harness.app.get(AttendanceService);
    const first = await attendance.closeDay(dayOffset(0));
    const second = await attendance.closeDay(dayOffset(0));

    expect(first.absent).toBeGreaterThan(0);
    expect(second.absent).toBe(0);
    expect(second.missingPunchOut).toBe(0);
  });
});

describe('attendance corrections', () => {
  async function openDayWithCorrection() {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);
    await harness.app.get(AttendanceService).closeDay(dayOffset(0));

    const record = await harness.prisma.db.attendanceRecord.findFirstOrThrow({
      where: { assignmentId: context.assignmentId },
    });

    const correction = await harness
      .http()
      .post(`/api/v1/attendance/${record.id}/corrections`)
      .set(auth(trainer))
      .send({
        requestedPunchOut: new Date().toISOString(),
        reason: 'Session over-ran and I left without punching out.',
      })
      .expect(201);

    return { recordId: record.id, correctionId: correction.body.id as string };
  }

  it('marks the day as awaiting a decision', async () => {
    const { recordId } = await openDayWithCorrection();
    const record = await harness.prisma.db.attendanceRecord.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(record.status).toBe('correction_pending');
  });

  it('refuses a second open request for the same day', async () => {
    const { recordId } = await openDayWithCorrection();
    await harness
      .http()
      .post(`/api/v1/attendance/${recordId}/corrections`)
      .set(auth(trainer))
      .send({ requestedPunchOut: new Date().toISOString(), reason: 'Asking again, just in case.' })
      .expect(409);
  });

  it('refuses a correction on somebody else’s day', async () => {
    const { recordId } = await openDayWithCorrection();
    await harness
      .http()
      .post(`/api/v1/attendance/${recordId}/corrections`)
      .set(auth(lead))
      .send({ requestedPunchOut: new Date().toISOString(), reason: 'Not my attendance record.' })
      .expect(403);
  });

  it('rewrites the day when approved and marks it corrected, not present', async () => {
    const { recordId, correctionId } = await openDayWithCorrection();

    await harness
      .http()
      .post(`/api/v1/attendance/corrections/${correctionId}/decide`)
      .set(auth(lead))
      .send({ decision: 'approved' })
      .expect(200);

    const record = await harness.prisma.db.attendanceRecord.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(record.status).toBe('corrected');
    expect(record.punchOutAt).not.toBeNull();
    expect(record.source).toBe('correction');
  });

  it('puts the day back the way it was when rejected', async () => {
    const { recordId, correctionId } = await openDayWithCorrection();

    await harness
      .http()
      .post(`/api/v1/attendance/corrections/${correctionId}/decide`)
      .set(auth(lead))
      .send({ decision: 'rejected', reviewNote: 'No record of the session over-running.' })
      .expect(200);

    const record = await harness.prisma.db.attendanceRecord.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(record.status).toBe('missing_punch_out');
    expect(record.punchOutAt).toBeNull();
  });

  it('insists on a reason when rejecting', async () => {
    const { correctionId } = await openDayWithCorrection();
    await harness
      .http()
      .post(`/api/v1/attendance/corrections/${correctionId}/decide`)
      .set(auth(lead))
      .send({ decision: 'rejected' })
      .expect(422);
  });
});

describe('the attendance calendar', () => {
  it('accounts for every date, deriving weekly offs rather than storing them', async () => {
    await harness
      .http()
      .post('/api/v1/attendance/punch-in')
      .set(auth(trainer))
      .send({})
      .expect(201);

    const month = dayOffset(0).slice(0, 7);
    const response = await harness
      .http()
      .get(`/api/v1/attendance/calendar?month=${month}`)
      .set(auth(trainer))
      .expect(200);

    const days = response.body.days as { workDate: string; status: string; derived: boolean }[];
    expect(days.length).toBeGreaterThanOrEqual(28);

    const sundays = days.filter((day) => new Date(`${day.workDate}T00:00:00Z`).getUTCDay() === 0);
    expect(sundays.length).toBeGreaterThan(0);
    for (const sunday of sundays) {
      expect(sunday.status).toBe('weekly_off');
      // Derived, not written: no row exists for it.
      expect(sunday.derived).toBe(true);
    }

    const today = days.find((day) => day.workDate === dayOffset(0));
    expect(today?.derived).toBe(false);
  });

  it('does not call today an absence before the day has closed', async () => {
    const month = dayOffset(0).slice(0, 7);
    const response = await harness
      .http()
      .get(`/api/v1/attendance/calendar?month=${month}`)
      .set(auth(trainer))
      .expect(200);

    const today = (response.body.days as { workDate: string; status: string }[]).find(
      (day) => day.workDate === dayOffset(0),
    );
    // Nobody has punched, but the day is not over — the nightly close decides.
    expect(today?.status).not.toBe('absent');
  });

  it('does not call a future working day absent', async () => {
    const month = dayOffset(0).slice(0, 7);
    const response = await harness
      .http()
      .get(`/api/v1/attendance/calendar?month=${month}`)
      .set(auth(trainer))
      .expect(200);

    const days = response.body.days as { workDate: string; status: string }[];
    for (const day of days.filter((entry) => entry.workDate > dayOffset(0))) {
      expect(day.status).not.toBe('absent');
    }
  });
});

/* ------------------------------------------------------------------- leave */

describe('leave', () => {
  it('counts working days and leaves the balance intact until it is spent', async () => {
    const balance = await harness
      .http()
      .get('/api/v1/leave-requests/balance')
      .set(auth(trainer))
      .expect(200);
    expect(balance.body.allowance).toBe(3);
    expect(balance.body.remaining).toBe(3);

    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({
        startDate: nextMonday(1),
        endDate: nextMonday(2),
        reason: 'Family commitment out of town.',
      })
      .expect(201);

    expect(Number(request.body.daysCount)).toBe(2);
    expect(request.body.balance.remaining).toBe(3);
    expect(request.body.balance.unpaid).toBe(0);
  });

  it('accepts a request over the balance and prices the overage as unpaid', async () => {
    const response = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({
        startDate: nextMonday(1),
        endDate: nextMonday(5),
        reason: 'Extended family obligation abroad.',
      })
      .expect(201);

    expect(Number(response.body.daysCount)).toBe(5);
    expect(Number(response.body.unpaidDays)).toBe(2);
  });

  it('refuses a range that is entirely non-working', async () => {
    const sunday = nextSunday();
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: sunday, endDate: sunday, reason: 'Trying to take a Sunday off.' })
      .expect(409);
  });

  it('refuses a second request overlapping a live one', async () => {
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(2), reason: 'First request.' })
      .expect(201);

    const clash = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(2), endDate: nextMonday(3), reason: 'Overlapping request.' })
      .expect(409);

    expect(clash.body.detail).toMatch(/already have/i);
  });

  it('writes the attendance days when approved', async () => {
    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(2), reason: 'Two days away.' })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/decide`)
      .set(auth(lead))
      .send({ decision: 'approved' })
      .expect(200);

    const days = await harness.prisma.db.attendanceRecord.findMany({
      where: { assignmentId: context.assignmentId, source: 'leave' },
      orderBy: { workDate: 'asc' },
    });
    expect(days).toHaveLength(2);
    expect(days.every((day) => day.status === 'on_leave')).toBe(true);
  });

  it('records the overage days as leave without pay, spending the paid days first', async () => {
    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(5), reason: 'Five working days.' })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/decide`)
      .set(auth(lead))
      .send({ decision: 'approved' })
      .expect(200);

    const days = await harness.prisma.db.attendanceRecord.findMany({
      where: { assignmentId: context.assignmentId, source: 'leave' },
      orderBy: { workDate: 'asc' },
    });
    expect(days.map((day) => day.status)).toEqual([
      'on_leave',
      'on_leave',
      'on_leave',
      'leave_without_pay',
      'leave_without_pay',
    ]);
  });

  it('will not let a lead approve their own request', async () => {
    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(lead))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'My own day off.' })
      .expect(201);

    const response = await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/decide`)
      .set(auth(lead))
      .send({ decision: 'approved' })
      .expect(403);

    expect(response.body.detail).toMatch(/your own/i);
  });

  it('escalates a request nobody decided, and does not escalate a fresh one', async () => {
    const stale = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'Waiting on a decision.' })
      .expect(201);

    // Age it past the escalation window rather than waiting a day for it.
    await harness.prisma.db.leaveRequest.update({
      where: { id: stale.body.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const escalated = await harness.app.get(OperationsJobs).escalateStaleLeave();
    expect(escalated).toBe(1);

    const after = await harness.prisma.db.leaveRequest.findUniqueOrThrow({
      where: { id: stale.body.id },
    });
    expect(after.status).toBe('escalated');
    expect(after.escalatedAt).not.toBeNull();

    expect(await harness.app.get(OperationsJobs).escalateStaleLeave()).toBe(0);
  });

  it('lets the manager decide once it has escalated', async () => {
    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'One day.' })
      .expect(201);

    await harness.prisma.db.leaveRequest.update({
      where: { id: request.body.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await harness.app.get(OperationsJobs).escalateStaleLeave();

    await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/decide`)
      .set(auth(manager))
      .send({ decision: 'approved' })
      .expect(200);
  });

  it('frees the days again when an approved leave is cancelled', async () => {
    const request = await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'Might not need it.' })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/decide`)
      .set(auth(lead))
      .send({ decision: 'approved' })
      .expect(200);

    await harness
      .http()
      .post(`/api/v1/leave-requests/${request.body.id}/cancel`)
      .set(auth(trainer))
      .send({})
      .expect(200);

    const days = await harness.prisma.db.attendanceRecord.count({
      where: { assignmentId: context.assignmentId, source: 'leave' },
    });
    expect(days).toBe(0);

    const balance = await harness
      .http()
      .get('/api/v1/leave-requests/balance')
      .set(auth(trainer))
      .expect(200);
    expect(balance.body.remaining).toBe(3);
  });

  it('shows an approver the queue and a trainer only their own requests', async () => {
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'Trainer request.' })
      .expect(201);
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(lead))
      .send({ startDate: nextMonday(2), endDate: nextMonday(2), reason: 'Lead request.' })
      .expect(201);

    const asHr = await harness.http().get('/api/v1/leave-requests').set(auth(hr)).expect(200);
    expect(asHr.body.meta.total).toBe(2);

    const asTrainer = await harness
      .http()
      .get('/api/v1/leave-requests')
      .set(auth(trainer))
      .expect(200);
    expect(asTrainer.body.meta.total).toBe(1);
    expect(asTrainer.body.data[0].reason).toBe('Trainer request.');
  });
});

/* --------------------------------------------------------------- daily log */

describe('the daily log', () => {
  it('numbers sessions itself and locks each one on submission', async () => {
    const first = await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'React component model', hours: 3 })
      .expect(201);
    const second = await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'Hooks in practice', hours: 2.5 })
      .expect(201);

    expect(first.body.sessionNo).toBe(1);
    expect(second.body.sessionNo).toBe(2);
    expect(second.body.locked).toBe(true);
  });

  it('refuses to log a day that has not happened', async () => {
    await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(2), topic: 'Tomorrow’s session', hours: 3 })
      .expect(409);
  });

  it('refuses an implausible day', async () => {
    await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'Morning block', hours: 8 })
      .expect(201);

    const response = await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'Evening block', hours: 8 })
      .expect(409);

    expect(response.body.detail).toMatch(/16 hours/);
  });

  it('cannot be edited until an administrator unlocks it', async () => {
    const log = await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'Routing', hours: 3 })
      .expect(201);

    await harness
      .http()
      .patch(`/api/v1/daily-logs/${log.body.id}`)
      .set(auth(trainer))
      .send({ topic: 'Routing and data loading' })
      .expect(409);

    await harness
      .http()
      .post(`/api/v1/daily-logs/${log.body.id}/unlock`)
      .set(auth(manager))
      .send({ reason: 'Trainer recorded the wrong topic.' })
      .expect(200);

    const edited = await harness
      .http()
      .patch(`/api/v1/daily-logs/${log.body.id}`)
      .set(auth(trainer))
      .send({ topic: 'Routing and data loading' })
      .expect(200);

    expect(edited.body.topic).toBe('Routing and data loading');
    // One unlock buys one correction.
    expect(edited.body.locked).toBe(true);
  });

  it('will not let a trainer unlock their own session', async () => {
    const log = await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'Testing', hours: 3 })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/daily-logs/${log.body.id}/unlock`)
      .set(auth(trainer))
      .send({ reason: 'I would like to change this.' })
      .expect(403);
  });
});

/* ------------------------------------------------------------ deliverables */

describe('deliverables', () => {
  it('records who completed an item and when, and keeps the first time', async () => {
    const created = await harness
      .http()
      .post('/api/v1/deliverables')
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId, title: 'Module one materials' })
      .expect(201);

    const completed = await harness
      .http()
      .patch(`/api/v1/deliverables/${created.body.id}`)
      .set(auth(trainer))
      .send({ status: 'completed' })
      .expect(200);
    expect(completed.body.completedAt).toBeTruthy();

    const edited = await harness
      .http()
      .patch(`/api/v1/deliverables/${created.body.id}`)
      .set(auth(trainer))
      .send({ description: 'Slides and lab sheet.' })
      .expect(200);

    expect(edited.body.completedAt).toBe(completed.body.completedAt);
  });

  it('clears the completion time when an item is reopened', async () => {
    const created = await harness
      .http()
      .post('/api/v1/deliverables')
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId, title: 'Module two materials' })
      .expect(201);

    await harness
      .http()
      .patch(`/api/v1/deliverables/${created.body.id}`)
      .set(auth(trainer))
      .send({ status: 'completed' })
      .expect(200);

    const reopened = await harness
      .http()
      .patch(`/api/v1/deliverables/${created.body.id}`)
      .set(auth(trainer))
      .send({ status: 'in_progress' })
      .expect(200);

    expect(reopened.body.completedAt).toBeNull();
  });

  it('will not attach an upload that never finished', async () => {
    const created = await harness
      .http()
      .post('/api/v1/deliverables')
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId, title: 'Module three materials' })
      .expect(201);

    const unconfirmed = newId();
    await harness.prisma.db.fileObject.create({
      data: {
        id: unconfirmed,
        storageKey: `deliverables/${unconfirmed}/draft.pdf`,
        originalName: 'draft.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: context.trainerUserId,
      },
    });

    await harness
      .http()
      .patch(`/api/v1/deliverables/${created.body.id}`)
      .set(auth(trainer))
      .send({ fileId: unconfirmed })
      .expect(422);
  });
});

/* ------------------------------------------------------------------ assets */

describe('assets', () => {
  async function registerLaptop(serial: string) {
    const response = await harness
      .http()
      .post('/api/v1/assets')
      .set(auth(manager))
      .send({ name: 'Dell Latitude 5440', category: 'hardware', serialNumber: serial })
      .expect(201);
    return response.body.id as string;
  }

  it('insists on a serial for hardware and allows none for a digital resource', async () => {
    await harness
      .http()
      .post('/api/v1/assets')
      .set(auth(manager))
      .send({ name: 'Laptop with no serial', category: 'hardware' })
      .expect(422);

    await harness
      .http()
      .post('/api/v1/assets')
      .set(auth(manager))
      .send({ name: 'Work email account', category: 'digital' })
      .expect(201);
  });

  it('refuses to register the same serial twice', async () => {
    await registerLaptop('DUP-0001');
    await harness
      .http()
      .post('/api/v1/assets')
      .set(auth(manager))
      .send({ name: 'Another laptop', category: 'hardware', serialNumber: 'DUP-0001' })
      .expect(409);
  });

  it('refuses to issue an asset that is already out', async () => {
    const assetId = await registerLaptop('ISS-0001');
    await harness
      .http()
      .post(`/api/v1/assets/${assetId}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/assets/${assetId}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.leadAssignmentId })
      .expect(409);
  });

  it('refuses a return whose serial does not match the one issued', async () => {
    const assetId = await registerLaptop('RET-0001');
    const issued = await harness
      .http()
      .post(`/api/v1/assets/${assetId}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId, issueSerial: 'RET-0001' })
      .expect(201);

    const mismatch = await harness
      .http()
      .post(`/api/v1/asset-issues/${issued.body.id}/return`)
      .set(auth(manager))
      .send({ condition: 'returned', returnSerial: 'RET-9999' })
      .expect(409);
    expect(mismatch.body.detail).toMatch(/RET-0001/);

    await harness
      .http()
      .post(`/api/v1/asset-issues/${issued.body.id}/return`)
      .set(auth(manager))
      .send({ condition: 'returned', returnSerial: 'RET-0001' })
      .expect(200);

    const asset = await harness.prisma.db.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe('available');
  });

  it('does not put a lost asset back on the shelf', async () => {
    const assetId = await registerLaptop('LOST-0001');
    const issued = await harness
      .http()
      .post(`/api/v1/assets/${assetId}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/asset-issues/${issued.body.id}/return`)
      .set(auth(manager))
      .send({ condition: 'lost', returnNotes: 'Left on a train; police report filed.' })
      .expect(200);

    const asset = await harness.prisma.db.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe('lost');
  });

  it('shows a trainer only what is in their own hands', async () => {
    const mine = await registerLaptop('MINE-0001');
    const theirs = await registerLaptop('THEIRS-0001');
    await harness
      .http()
      .post(`/api/v1/assets/${mine}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.assignmentId })
      .expect(201);
    await harness
      .http()
      .post(`/api/v1/assets/${theirs}/issue`)
      .set(auth(manager))
      .send({ assignmentId: context.leadAssignmentId })
      .expect(201);

    const response = await harness.http().get('/api/v1/assets').set(auth(trainer)).expect(200);
    const serials = (response.body.data as { serialNumber: string }[]).map(
      (asset) => asset.serialNumber,
    );
    expect(serials).toContain('MINE-0001');
    expect(serials).not.toContain('THEIRS-0001');
  });
});

/* ---------------------------------------------------------- reimbursements */

describe('reimbursements', () => {
  async function submit(amount: number) {
    const response = await harness
      .http()
      .post('/api/v1/reimbursements')
      .set(auth(trainer))
      .send({
        category: 'travel',
        amount,
        description: 'Airfare to the client campus for induction week.',
        proofFileId: await confirmedFile(context.trainerUserId),
      })
      .expect(201);
    return response.body.id as string;
  }

  it('requires proof that actually finished uploading', async () => {
    const unconfirmed = newId();
    await harness.prisma.db.fileObject.create({
      data: {
        id: unconfirmed,
        storageKey: `proof/${unconfirmed}/receipt.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: context.trainerUserId,
      },
    });

    await harness
      .http()
      .post('/api/v1/reimbursements')
      .set(auth(trainer))
      .send({
        category: 'travel',
        amount: 500,
        description: 'A claim with an unfinished upload.',
        proofFileId: unconfirmed,
      })
      .expect(422);
  });

  it('lets HR approve a claim inside their limit', async () => {
    const id = await submit(4500);
    await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/decide`)
      .set(auth(hr))
      .send({ decision: 'approved' })
      .expect(200);
  });

  it('refuses to let HR approve above the limit, and lets a manager', async () => {
    const id = await submit(12500);

    const refused = await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/decide`)
      .set(auth(hr))
      .send({ decision: 'approved' })
      .expect(403);
    expect(refused.body.detail).toMatch(/Manager/);

    await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/decide`)
      .set(auth(manager))
      .send({ decision: 'approved' })
      .expect(200);
  });

  it('lets HR reject a high-value claim, since only approval is limited', async () => {
    const id = await submit(12500);
    await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/decide`)
      .set(auth(hr))
      .send({ decision: 'rejected', reviewNote: 'No approval was sought before travelling.' })
      .expect(200);
  });

  it('will not mark an undecided claim as paid', async () => {
    const id = await submit(2000);
    await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/mark-paid`)
      .set(auth(hr))
      .send({})
      .expect(409);
  });

  it('records the payment reference once the money moves', async () => {
    const id = await submit(2000);
    await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/decide`)
      .set(auth(hr))
      .send({ decision: 'approved' })
      .expect(200);

    const paid = await harness
      .http()
      .post(`/api/v1/reimbursements/${id}/mark-paid`)
      .set(auth(hr))
      .send({ reference: 'NEFT-88213' })
      .expect(200);

    expect(paid.body.status).toBe('reimbursed');
    expect(paid.body.paymentReference).toBe('NEFT-88213');
  });

  it('shows a trainer only their own claims', async () => {
    await submit(1000);
    const response = await harness
      .http()
      .get('/api/v1/reimbursements')
      .set(auth(trainer))
      .expect(200);
    expect(response.body.meta.total).toBe(1);
  });
});

/* ------------------------------------------------------------------- flags */

describe('flags', () => {
  async function raise() {
    const response = await harness
      .http()
      .post('/api/v1/flags')
      .set(auth(lead))
      .send({
        assignmentId: context.assignmentId,
        severity: 'medium',
        description: 'Arrived late to three sessions this fortnight with no notice.',
      })
      .expect(201);
    return response.body.id as string;
  }

  it('notifies the project’s manager and HR without anyone choosing them', async () => {
    const id = await raise();
    const notified = await harness.prisma.db.notification.findMany({
      where: { entityType: 'Flag', entityId: id },
      select: { userId: true },
    });
    expect(notified).toHaveLength(2);
  });

  it('will not let someone raise a flag against themselves', async () => {
    await harness
      .http()
      .post('/api/v1/flags')
      .set(auth(lead))
      .send({
        assignmentId: context.leadAssignmentId,
        description: 'A concern about my own performance, apparently.',
      })
      .expect(403);
  });

  it('closes with the action taken recorded', async () => {
    const id = await raise();
    const resolved = await harness
      .http()
      .post(`/api/v1/flags/${id}/resolve`)
      .set(auth(manager))
      .send({ actionTaken: 'warning', resolutionNote: 'Spoken to; verbal warning recorded.' })
      .expect(200);

    expect(resolved.body.status).toBe('closed');
    expect(resolved.body.actionTaken).toBe('warning');
    expect(resolved.body.resolvedBy.id).toBeTruthy();
  });

  it('refuses to close a flag twice', async () => {
    const id = await raise();
    await harness
      .http()
      .post(`/api/v1/flags/${id}/resolve`)
      .set(auth(manager))
      .send({ actionTaken: 'none', resolutionNote: 'Reviewed; no action needed.' })
      .expect(200);

    await harness
      .http()
      .post(`/api/v1/flags/${id}/resolve`)
      .set(auth(manager))
      .send({ actionTaken: 'warning', resolutionNote: 'Changing my mind after the fact.' })
      .expect(409);
  });

  it('is not readable by the trainer it concerns', async () => {
    await raise();
    await harness.http().get('/api/v1/flags').set(auth(trainer)).expect(403);
  });

  it('lets a lead see the flags on their project', async () => {
    await raise();
    const response = await harness.http().get('/api/v1/flags').set(auth(lead)).expect(200);
    expect(response.body.meta.total).toBe(1);
  });
});

/* ------------------------------------------------- the "mine" narrowing */

/**
 * A Project Lead reads their whole project, which is right for oversight and
 * wrong for the screen labelled "My …". These check that `mine=true` narrows to
 * the caller's own records and that it can only ever narrow — an admin cannot
 * use it to reach past their scope, and a caller with no trainer profile gets
 * nothing rather than everything.
 */
describe('mine=true', () => {
  beforeEach(async () => {
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({ startDate: nextMonday(1), endDate: nextMonday(1), reason: 'The trainer’s day off.' })
      .expect(201);
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(lead))
      .send({ startDate: nextMonday(2), endDate: nextMonday(2), reason: 'The lead’s own day off.' })
      .expect(201);

    await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(trainer))
      .send({ workDate: dayOffset(0), topic: 'A session the trainer taught', hours: 3 })
      .expect(201);
    await harness
      .http()
      .post('/api/v1/daily-logs')
      .set(auth(lead))
      .send({ workDate: dayOffset(0), topic: 'A session the lead taught', hours: 3 })
      .expect(201);

    for (const assignmentId of [context.assignmentId, context.leadAssignmentId]) {
      await harness
        .http()
        .post('/api/v1/deliverables')
        .set(auth(manager))
        .send({ assignmentId, title: `Materials for ${assignmentId.slice(0, 8)}` })
        .expect(201);
    }
  });

  it('gives a lead their whole project by default', async () => {
    const leave = await harness.http().get('/api/v1/leave-requests').set(auth(lead)).expect(200);
    expect(leave.body.meta.total).toBe(2);

    const logs = await harness.http().get('/api/v1/daily-logs').set(auth(lead)).expect(200);
    expect(logs.body.meta.total).toBe(2);

    const deliverables = await harness
      .http()
      .get('/api/v1/deliverables')
      .set(auth(lead))
      .expect(200);
    expect(deliverables.body.meta.total).toBe(2);
  });

  it('narrows a lead to their own records', async () => {
    const leave = await harness
      .http()
      .get('/api/v1/leave-requests?mine=true')
      .set(auth(lead))
      .expect(200);
    expect(leave.body.meta.total).toBe(1);
    expect(leave.body.data[0].reason).toBe('The lead’s own day off.');

    const logs = await harness
      .http()
      .get('/api/v1/daily-logs?mine=true')
      .set(auth(lead))
      .expect(200);
    expect(logs.body.meta.total).toBe(1);
    expect(logs.body.data[0].topic).toBe('A session the lead taught');

    const deliverables = await harness
      .http()
      .get('/api/v1/deliverables?mine=true')
      .set(auth(lead))
      .expect(200);
    expect(deliverables.body.meta.total).toBe(1);
    expect(deliverables.body.data[0].assignment.id).toBe(context.leadAssignmentId);
  });

  it('never widens a scope that was already narrower', async () => {
    const withFlag = await harness
      .http()
      .get('/api/v1/leave-requests?mine=true')
      .set(auth(trainer))
      .expect(200);
    const without = await harness
      .http()
      .get('/api/v1/leave-requests')
      .set(auth(trainer))
      .expect(200);

    expect(withFlag.body.meta.total).toBe(1);
    expect(without.body.meta.total).toBe(1);
  });

  it('returns nothing for a caller who has no trainer profile', async () => {
    // HR reads everything; asking for "mine" when they own no records is empty,
    // not everything.
    const response = await harness
      .http()
      .get('/api/v1/leave-requests?mine=true')
      .set(auth(hr))
      .expect(200);
    expect(response.body.meta.total).toBe(0);
  });
});

/* ----------------------------------------------------------------- helpers */

/** The nth working day from tomorrow, skipping Sundays. */
function nextMonday(offset: number): string {
  let found = 0;
  for (let days = 1; days < 40; days += 1) {
    const candidate = new Date(Date.now() + days * 86_400_000);
    if (candidate.getUTCDay() === 0) continue;
    found += 1;
    if (found === offset) return toIstDateString(candidate);
  }
  throw new Error('No working day found');
}

function nextSunday(): string {
  for (let days = 1; days < 14; days += 1) {
    const candidate = new Date(Date.now() + days * 86_400_000);
    if (candidate.getUTCDay() === 0) return toIstDateString(candidate);
  }
  throw new Error('No Sunday found');
}
