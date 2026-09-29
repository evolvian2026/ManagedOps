import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * The month's pay inputs, against a real database.
 *
 * The arithmetic is unit tested. What matters here is that the right facts
 * reach it — one row per person however many assignments they hold — and that
 * the register refuses to look final while anything is unresolved, because a
 * register that reads as settled is one somebody pays from.
 */
let harness: Harness;
let manager: Session;
let hr: Session;
let lead: Session;
let trainer: Session;

/** June 2026: 30 days, four Sundays, so 26 working days on a six-day week. */
const MONTH = '2026-06';
const WORKING_DAYS = 26;

let context: {
  projectId: string;
  otherProjectId: string;
  trainerId: string;
  assignmentId: string;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/**
 * Writes `count` working days of one status, skipping Sundays, and returns the
 * cursor so a second run continues where the first stopped. Restarting at a
 * guessed date collides with the unique index on (assignment, work date).
 */
async function recordDays(
  assignmentId: string,
  count: number,
  status = 'present',
  from = new Date('2026-06-01T00:00:00Z'),
) {
  let day = new Date(from);
  for (let written = 0; written < count; written += 1) {
    while (day.getUTCDay() === 0) day = new Date(day.getTime() + 86_400_000);
    await harness.prisma.db.attendanceRecord.create({
      data: { id: newId(), assignmentId, workDate: new Date(day), status: status as never },
    });
    day = new Date(day.getTime() + 86_400_000);
  }
  return day;
}

async function buildWorld() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });
  const client = await harness.seedClient('Payroll Test Client');

  const makeProject = (name: string) =>
    harness.prisma.db.project.create({
      data: {
        id: newId(),
        name,
        code: `PR-${Math.floor(Math.random() * 1_000_000)}`,
        clientId: client.id,
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        managerId: managerUser!.id,
        hrId: hrUser!.id,
        leadTrainerId: leadUser!.id,
        weeklyOffDays: [0],
      },
    });

  const project = await makeProject('Payroll Test Project');
  const otherProject = await makeProject('The Other Engagement');

  const trainerRecord = await harness.prisma.db.trainer.create({
    data: {
      id: newId(),
      userId: trainerUser!.id,
      employeeCode: `PR-${Date.now() % 1_000_000}`,
      personalEmail: 'payroll@example.com',
      phone: '+919812345678',
      status: 'active',
      salaryAnnual: 720_000,
      joiningDate: new Date('2026-01-01T00:00:00Z'),
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
      allocationPercent: 100,
    },
  });

  return {
    projectId: project.id,
    otherProjectId: otherProject.id,
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
  context = await buildWorld();
  lead = await harness.signIn(leadUser.email);
  trainer = await harness.signIn(trainerUser.email);
});

async function register(query = `month=${MONTH}`) {
  const response = await harness
    .http()
    .get(`/api/v1/payroll/register?${query}`)
    .set(auth(hr))
    .expect(200);
  return response.body;
}

describe('a month worked in full', () => {
  beforeEach(async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
  });

  it('pays the whole month and says the row is ready', async () => {
    const body = await register();
    const row = body.rows[0];

    expect(row.workingDaysInMonth).toBe(WORKING_DAYS);
    expect(row.payableDays).toBe(WORKING_DAYS);
    expect(row.monthlyGross).toBe(60_000);
    expect(row.earnedGross).toBe(60_000);
    expect(row.lopDeduction).toBe(0);
    expect(row.ready).toBe(true);
    expect(row.blockers).toEqual([]);
  });

  it('totals what it lists', async () => {
    const body = await register();
    expect(body.totals.people).toBe(1);
    expect(body.totals.ready).toBe(1);
    expect(body.totals.totalPayable).toBe(60_000);
  });

  it('adds a claim approved in the month, beside the salary rather than in it', async () => {
    const file = await harness.prisma.db.fileObject.create({
      data: {
        id: newId(),
        storageKey: `receipts/${newId()}.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    await harness.prisma.db.reimbursement.create({
      data: {
        id: newId(),
        trainerId: context.trainerId,
        assignmentId: context.assignmentId,
        category: 'travel',
        amount: 2_500,
        description: 'Site visit',
        proofFileId: file.id,
        status: 'approved',
        reviewedById: hr.user.id,
        reviewedAt: new Date('2026-06-15T00:00:00Z'),
      },
    });

    const row = (await register()).rows[0];
    expect(row.earnedGross).toBe(60_000);
    expect(row.reimbursements).toBe(2_500);
    expect(row.totalPayable).toBe(62_500);
  });

  it('leaves out a claim approved in a different month', async () => {
    const file = await harness.prisma.db.fileObject.create({
      data: {
        id: newId(),
        storageKey: `receipts/${newId()}.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    await harness.prisma.db.reimbursement.create({
      data: {
        id: newId(),
        trainerId: context.trainerId,
        assignmentId: context.assignmentId,
        category: 'travel',
        amount: 9_999,
        description: 'July, not June',
        proofFileId: file.id,
        status: 'approved',
        reviewedById: hr.user.id,
        reviewedAt: new Date('2026-07-15T00:00:00Z'),
      },
    });

    expect((await register()).rows[0].reimbursements).toBe(0);
  });
});

describe('a month with something missing', () => {
  it('refuses to look final when days are unrecorded', async () => {
    await recordDays(context.assignmentId, 20);

    const row = (await register()).rows[0];
    expect(row.ready).toBe(false);
    expect(row.blockers).toContain('6 working days with no attendance recorded.');
    // The pay is still stated: withholding it would only make the reason harder
    // to judge. What is withheld is the impression that it is settled.
    expect(row.earnedGross).toBeGreaterThan(0);
  });

  it('refuses while a correction is pending', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    const day = await harness.prisma.db.attendanceRecord.findFirstOrThrow({
      where: { assignmentId: context.assignmentId },
    });
    await harness.prisma.db.attendanceCorrection.create({
      data: {
        id: newId(),
        attendanceRecordId: day.id,
        requestedById: trainer.user.id,
        reason: 'Forgot to punch out',
        status: 'pending',
      },
    });

    const row = (await register()).rows[0];
    expect(row.ready).toBe(false);
    expect(row.blockers).toContain('1 attendance correction awaiting a decision.');
  });

  it('refuses while leave overlapping the month is undecided', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await harness.prisma.db.leaveRequest.create({
      data: {
        id: newId(),
        assignmentId: context.assignmentId,
        startDate: new Date('2026-06-10T00:00:00Z'),
        endDate: new Date('2026-06-11T00:00:00Z'),
        dayType: 'full',
        daysCount: 2,
        reason: 'A wedding',
        status: 'submitted',
      },
    });

    const row = (await register()).rows[0];
    expect(row.blockers).toContain('1 leave request still undecided.');
  });

  it('shows only what still needs doing when asked', async () => {
    await recordDays(context.assignmentId, 20);

    const body = await register(`month=${MONTH}&unresolvedOnly=true`);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].ready).toBe(false);
    // Totals follow the filter, so a filtered view adds up to what it lists.
    expect(body.totals.people).toBe(1);
    expect(body.totals.unresolved).toBe(1);
  });
});

describe('somebody on two engagements', () => {
  it('is paid for a day once, however many assignments claim it', async () => {
    // Split across two projects, so every date has two attendance records.
    await harness.prisma.db.assignment.update({
      where: { id: context.assignmentId },
      data: { allocationPercent: 60 },
    });
    const second = await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: context.trainerId,
        projectId: context.otherProjectId,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        allocationPercent: 40,
      },
    });

    await recordDays(context.assignmentId, WORKING_DAYS);
    await recordDays(second.id, WORKING_DAYS);

    const body = await register();
    expect(body.rows).toHaveLength(1);

    const row = body.rows[0];
    // Not 52. Paying twice is the mistake the per-date resolution prevents.
    expect(row.payableDays).toBe(WORKING_DAYS);
    expect(row.earnedGross).toBe(60_000);
    expect(row.projects).toHaveLength(2);
  });

  it('pays a day that either engagement says was worked', async () => {
    const second = await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: context.trainerId,
        projectId: context.otherProjectId,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        allocationPercent: 40,
      },
    });
    await harness.prisma.db.assignment.update({
      where: { id: context.assignmentId },
      data: { allocationPercent: 60 },
    });

    await recordDays(context.assignmentId, WORKING_DAYS, 'absent');
    await recordDays(second.id, WORKING_DAYS, 'present');

    const row = (await register()).rows[0];
    expect(row.lopDays).toBe(0);
    expect(row.payableDays).toBe(WORKING_DAYS);
  });
});

describe('unpaid days and leave', () => {
  it('docks absence and reports the deduction', async () => {
    // 24 days worked, then the month's last two absent: 24 of 26 paid.
    const next = await recordDays(context.assignmentId, 24);
    await recordDays(context.assignmentId, 2, 'absent', next);

    const row = (await register()).rows[0];
    expect(row.lopDays).toBe(2);
    expect(row.payableDays).toBe(24);
    expect(row.earnedGross).toBe(55_384.62);
    expect(row.lopDeduction).toBe(4_615.38);
  });

  it('pays approved leave in full and reports it as leave', async () => {
    const next = await recordDays(context.assignmentId, 24);
    await recordDays(context.assignmentId, 2, 'on_leave', next);

    const row = (await register()).rows[0];
    expect(row.leaveDays).toBe(2);
    expect(row.lopDays).toBe(0);
    expect(row.earnedGross).toBe(60_000);
  });
});

describe('who may read it', () => {
  it('is open to a manager and to HR, who run the month end', async () => {
    for (const session of [manager, hr]) {
      await harness.http().get('/api/v1/payroll/register').set(auth(session)).expect(200);
    }
  });

  it('is refused to a project lead and a trainer, because it carries every salary', async () => {
    for (const session of [lead, trainer]) {
      await harness.http().get('/api/v1/payroll/register').set(auth(session)).expect(403);
      await harness
        .http()
        .get('/api/v1/payroll/register/export.csv')
        .set(auth(session))
        .expect(403);
    }
  });

  it('refuses a month that is not one', async () => {
    await harness.http().get('/api/v1/payroll/register?month=2026-13').set(auth(hr)).expect(422);
  });

  it('exports a CSV whose numbers are numbers', async () => {
    await recordDays(context.assignmentId, 24);

    const response = await harness
      .http()
      // Two days are unrecorded, so this month only leaves with a decision.
      .get(`/api/v1/payroll/register/export.csv?month=${MONTH}&layout=full&force=true`)
      .set(auth(hr))
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/managedops-payroll-2026-06-full\.csv/);
    expect(response.text).toMatch(/earned_gross_inr/);
    // Unquoted and unprefixed, so a payroll system reads it as a figure.
    expect(response.text).toMatch(/,55384\.62,/);
    // The reason a row is not ready survives into the file.
    expect(response.text).toMatch(/no attendance recorded/);
  });
});

/**
 * Reads a named figure out of a one-row CSV.
 *
 * By header rather than by position, so a column added in the middle of a
 * layout does not silently start asserting about its neighbour. Splitting on
 * commas is safe for the figures: every quoted free-text field sits after
 * them, so nothing it contains can shift a numeric column's index.
 */
function numberReader(csv: string): (header: string) => number {
  const [headerLine, row] = csv.trim().split('\n');
  // The file opens with a byte order mark, for Excel.
  const headers = headerLine!.replace(/^\ufeff/, '').split(',');
  return (header) => {
    const index = headers.indexOf(header);
    if (index < 0) throw new Error(`No column named ${header} in: ${headers.join(', ')}`);
    return Number(row!.split(',')[index]);
  };
}

describe('handing the month to payroll', () => {
  async function exportMonth(query: string, expected = 200) {
    return harness
      .http()
      .get(`/api/v1/payroll/register/export.csv?month=${MONTH}&${query}`)
      .set(auth(hr))
      .expect(expected);
  }

  it('refuses a month that is not settled, and says what is holding it', async () => {
    await recordDays(context.assignmentId, 20);

    const response = await exportMonth('', 409);

    expect(response.body.detail).toMatch(/not ready to pay from/);
    expect(response.body.detail).toMatch(/no attendance recorded/);
    // Advice is not a control. Nothing is recorded, because nothing left.
    expect(await harness.prisma.db.payrollExport.count()).toBe(0);
  });

  it('sends it anyway when somebody asks for that, and records the decision', async () => {
    await recordDays(context.assignmentId, 20);
    await exportMonth('force=true');

    const [recorded] = await harness.prisma.db.payrollExport.findMany();
    expect(recorded!.forced).toBe(true);
    expect(recorded!.unresolvedRows).toBe(1);
  });

  it('sends a settled month without being asked twice', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    const response = await exportMonth('');

    expect(response.headers['content-disposition']).toMatch(/2026-06-days\.csv/);
    expect(await harness.prisma.db.payrollExport.count()).toBe(1);
  });

  it('defaults to the layout that carries days rather than money', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    const response = await exportMonth('');

    expect(response.text).toMatch(/loss_of_pay_days/);
    // Payroll holds the salary structure; our gross is not theirs to import.
    expect(response.text).not.toMatch(/_inr/);
  });

  it('carries the money only when that layout is chosen', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    const response = await exportMonth('layout=full');

    expect(response.text).toMatch(/earned_gross_inr/);
    expect(response.text).toMatch(/loss_of_pay_days/);
  });

  it('accounts for every working day, including the ones nobody recorded', async () => {
    // 20 of 22 recorded, all of them present. The proration docks the other
    // two all the same, so a file that reported no loss of pay and no gap
    // would be arithmetic payroll cannot reproduce or query.
    await recordDays(context.assignmentId, 20);
    const response = await exportMonth('layout=full&force=true');

    const cell = numberReader(response.text);

    expect(cell('working_days_in_month')).toBe(WORKING_DAYS);
    expect(cell('paid_days')).toBe(20);
    expect(cell('loss_of_pay_days')).toBe(0);
    expect(cell('unrecorded_days')).toBe(WORKING_DAYS - 20);
    // The money charges those days, which is exactly why the column is there.
    expect(cell('loss_of_pay_inr')).toBeGreaterThan(0);
  });

  it('sends the reason with the days layout too, because that is the one sent', async () => {
    await recordDays(context.assignmentId, 20);
    const response = await exportMonth('force=true');

    expect(response.text).not.toMatch(/_inr/);
    // A decision to send an unsettled month is worthless if it stays behind.
    expect(response.text).toMatch(/unrecorded_days/);
    expect(response.text).toMatch(/no attendance recorded/);
  });

  it('sends the whole month however the screen was filtered', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    // A file that silently holds a subset is the worst thing to hand payroll.
    const response = await exportMonth('unresolvedOnly=true');

    const dataLines = response.text.trim().split('\n').slice(1);
    expect(dataLines).toHaveLength(1);
  });

  it('records who sent it, and what went', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await exportMonth('layout=full');

    const [recorded] = await harness.prisma.db.payrollExport.findMany({
      include: { exportedBy: { select: { role: true } } },
    });
    expect(recorded!.month).toBe(MONTH);
    expect(recorded!.layout).toBe('full');
    expect(recorded!.rowCount).toBe(1);
    expect(recorded!.exportedBy.role).toBe('hr');
    expect(Number(recorded!.totalPayable)).toBeGreaterThan(0);
  });

  it('tells the register the month has been sent, and still matches', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await exportMonth('');

    const after = await register();
    expect(after.lastExport.rowCount).toBe(1);
    expect(after.lastExport.stillCurrent).toBe(true);
    expect(after.lastExport.forced).toBe(false);
  });

  it('says so once a figure has moved since it was sent', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await exportMonth('');

    // The case this exists for: the file payroll is holding quietly stops
    // being true, and without this nobody finds out until the next payday.
    const file = await harness.prisma.db.fileObject.create({
      data: {
        id: newId(),
        storageKey: `receipts/${newId()}.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    await harness.prisma.db.reimbursement.create({
      data: {
        id: newId(),
        trainerId: context.trainerId,
        assignmentId: context.assignmentId,
        category: 'travel',
        amount: 4000,
        description: 'A late claim',
        proofFileId: file.id,
        status: 'approved',
        reviewedById: hr.user.id,
        reviewedAt: new Date('2026-06-20T00:00:00Z'),
      },
    });

    const after = await register();
    expect(after.lastExport.stillCurrent).toBe(false);
  });

  it('does not call a month stale because somebody fixed a spelling', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await exportMonth('');

    const trainerRecord = await harness.prisma.db.trainer.findUniqueOrThrow({
      where: { id: context.trainerId },
      select: { userId: true },
    });
    await harness.prisma.db.user.update({
      where: { id: trainerRecord.userId },
      data: { name: 'A Corrected Name' },
    });

    const after = await register();
    expect(after.lastExport.stillCurrent).toBe(true);
  });

  it('has nothing to report before the month has been sent', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    expect((await register()).lastExport).toBeNull();
  });

  it('keeps every handoff, newest first', async () => {
    await recordDays(context.assignmentId, WORKING_DAYS);
    await exportMonth('');
    await exportMonth('layout=full');

    const response = await harness
      .http()
      .get(`/api/v1/payroll/exports?month=${MONTH}`)
      .set(auth(hr))
      .expect(200);

    expect(response.body.map((row: { layout: string }) => row.layout)).toEqual(['full', 'days']);
    expect(response.body[0].by).toBeTruthy();
  });

  it('offers the layouts, with what each one holds', async () => {
    const response = await harness
      .http()
      .get('/api/v1/payroll/export-layouts')
      .set(auth(hr))
      .expect(200);

    const days = response.body.find((row: { id: string }) => row.id === 'days');
    expect(days.columns).toContain('loss_of_pay_days');
    expect(days.description.length).toBeGreaterThan(20);
  });

  it('is not something a lead or a trainer can do', async () => {
    for (const session of [lead, trainer]) {
      await harness.http().get('/api/v1/payroll/exports').set(auth(session)).expect(403);
      await harness.http().get('/api/v1/payroll/export-layouts').set(auth(session)).expect(403);
    }
  });
});
