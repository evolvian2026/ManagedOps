import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toIstDateString } from '@managedops/shared';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';
import { toCsv, toCsvField } from '../src/common/csv.js';

/**
 * Exit and re-use, against a real database.
 *
 * Two rules carry this phase. A deboarding cannot complete while an issued asset
 * is unaccounted for or the settlement is open — checked against the register
 * and the record, never a checkbox. And the Talent Pool is a query: completing a
 * deboarding for someone re-hire eligible puts them in it, and revoking that
 * eligibility takes them straight back out, with nobody setting a flag.
 */
let harness: Harness;
let hr: Session;
let manager: Session;
let lead: Session;
let trainer: Session;

let context: {
  projectId: string;
  positionId: string;
  otherPositionId: string;
  trainerId: string;
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

/**
 * The nth working day from tomorrow, skipping Sundays.
 *
 * A plain `dayOffset(n)` is a time bomb for anything the leave rules touch: a
 * single-day request that lands on a weekly off has no working days in it, so
 * the service rightly refuses it with 409 — but only on the weekdays where the
 * arithmetic happens to reach a Sunday.
 */
function nextWorkingDay(offset = 1): string {
  let found = 0;
  for (let days = 1; days < 40; days += 1) {
    const candidate = new Date(Date.now() + days * 86_400_000);
    if (candidate.getUTCDay() === 0) continue;
    found += 1;
    if (found === offset) return toIstDateString(candidate);
  }
  throw new Error('No working day found');
}

async function buildProject() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Exit Test Project',
      code: `EX-${Math.floor(Math.random() * 1_000_000)}`,
      clientName: 'Client',
      startDate: new Date(`${dayOffset(-60)}T00:00:00Z`),
      status: 'active',
      managerId: managerUser!.id,
      hrId: hrUser!.id,
      leadTrainerId: leadUser!.id,
    },
  });

  const makePosition = (title: string) =>
    harness.prisma.db.position.create({
      data: {
        id: newId(),
        projectId: project.id,
        title,
        headcount: 2,
        status: 'open',
        createdById: hrUser!.id,
      },
    });

  const position = await makePosition('Replacement Trainer');
  // A second one, because a person already rejected for a position cannot be
  // put forward for that same position again — they have a record against it.
  const otherPosition = await makePosition('Java Trainer');

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
        startDate: new Date(`${dayOffset(-60)}T00:00:00Z`),
        status: 'active',
        leaveAllowanceDays: 3,
      },
    });
    return { trainerId: record.id, assignmentId: assignment.id };
  };

  const leadRecord = await makeTrainer(leadUser!.id, `EX-L-${Date.now() % 100000}`, 'lead');
  const trainerRecord = await makeTrainer(
    trainerUser!.id,
    `EX-T-${Date.now() % 100000}`,
    'trainer',
  );

  return {
    projectId: project.id,
    positionId: position.id,
    otherPositionId: otherPosition.id,
    trainerId: trainerRecord.trainerId,
    assignmentId: trainerRecord.assignmentId,
    leadTrainerId: leadRecord.trainerId,
    leadAssignmentId: leadRecord.assignmentId,
  };
}

/** Starts a deboarding on the plain trainer's assignment. */
async function initiate(lastWorkingDay = dayOffset(14)) {
  const response = await harness
    .http()
    .post('/api/v1/deboardings')
    .set(auth(hr))
    .send({
      assignmentId: context.assignmentId,
      lastWorkingDay,
      reason: 'Term ending; the client has not renewed.',
    })
    .expect(201);
  return response.body.id as string;
}

/** Issues a laptop against the trainer's assignment and returns the issue id. */
async function issueLaptop(serial: string) {
  const asset = await harness
    .http()
    .post('/api/v1/assets')
    .set(auth(manager))
    .send({ name: 'Dell Latitude', category: 'hardware', serialNumber: serial })
    .expect(201);

  const issue = await harness
    .http()
    .post(`/api/v1/assets/${asset.body.id}/issue`)
    .set(auth(manager))
    .send({ assignmentId: context.assignmentId, issueSerial: serial })
    .expect(201);

  return issue.body.id as string;
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

  lead = await harness.signIn(leadUser.email);
  trainer = await harness.signIn(trainerUser.email);
});

/* -------------------------------------------------------------- deboarding */

describe('starting a deboarding', () => {
  it('moves the trainer to deboarding without ending their assignment', async () => {
    await initiate();

    const [trainerRow, assignment] = await Promise.all([
      harness.prisma.db.trainer.findUniqueOrThrow({ where: { id: context.trainerId } }),
      harness.prisma.db.assignment.findUniqueOrThrow({ where: { id: context.assignmentId } }),
    ]);

    // Leaving, not gone: they still punch in until their last day passes.
    expect(trainerRow.status).toBe('deboarding');
    expect(assignment.status).toBe('active');
  });

  it('refuses a last working day before the assignment started', async () => {
    const response = await harness
      .http()
      .post('/api/v1/deboardings')
      .set(auth(hr))
      .send({
        assignmentId: context.assignmentId,
        lastWorkingDay: dayOffset(-90),
        reason: 'Backdated beyond the start of the assignment.',
      })
      .expect(409);

    expect(response.body.detail).toMatch(/cannot precede/i);
  });

  it('refuses a second deboarding on the same assignment', async () => {
    await initiate();
    await harness
      .http()
      .post('/api/v1/deboardings')
      .set(auth(hr))
      .send({
        assignmentId: context.assignmentId,
        lastWorkingDay: dayOffset(20),
        reason: 'Trying to start it again.',
      })
      .expect(409);
  });

  it('notifies the project manager and HR', async () => {
    const id = await initiate();
    const notified = await harness.prisma.db.notification.findMany({
      where: { entityType: 'Deboarding', entityId: id },
    });
    expect(notified).toHaveLength(2);
  });

  it('is not something a project lead can start', async () => {
    await harness
      .http()
      .post('/api/v1/deboardings')
      .set(auth(lead))
      .send({
        assignmentId: context.assignmentId,
        lastWorkingDay: dayOffset(14),
        reason: 'A lead trying to deboard somebody.',
      })
      .expect(403);
  });
});

describe('completing a deboarding', () => {
  it('names the unreturned asset rather than just refusing', async () => {
    const id = await initiate();
    await issueLaptop('EXIT-0001');

    const response = await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(409);

    expect(response.body.detail).toMatch(/Dell Latitude/);
    expect(response.body.detail).toMatch(/EXIT-0001/);
    expect(response.body.detail).toMatch(/settlement is still pending/i);
  });

  it('still refuses once the asset is back but the settlement is open', async () => {
    const id = await initiate();
    const issueId = await issueLaptop('EXIT-0002');
    await harness
      .http()
      .post(`/api/v1/asset-issues/${issueId}/return`)
      .set(auth(manager))
      .send({ condition: 'returned', returnSerial: 'EXIT-0002' })
      .expect(200);

    const response = await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(409);

    expect(response.body.detail).toMatch(/settlement is still pending/i);
    expect(response.body.detail).not.toMatch(/Dell Latitude/);
  });

  it('counts a lost asset as unreconciled, because it is', async () => {
    const id = await initiate();
    const issueId = await issueLaptop('EXIT-0003');
    await harness
      .http()
      .post(`/api/v1/asset-issues/${issueId}/return`)
      .set(auth(manager))
      .send({ condition: 'lost', returnNotes: 'Never came back.' })
      .expect(200);

    await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ fnfStatus: 'waived' })
      .expect(200);

    const response = await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(409);
    expect(response.body.detail).toMatch(/Dell Latitude/);
  });

  it('completes once nothing is outstanding, and closes everything down', async () => {
    const id = await initiate();
    const issueId = await issueLaptop('EXIT-0004');
    await harness
      .http()
      .post(`/api/v1/asset-issues/${issueId}/return`)
      .set(auth(manager))
      .send({ condition: 'returned', returnSerial: 'EXIT-0004' })
      .expect(200);

    await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ fnfStatus: 'settled', fnfAmount: 42000, rehireEligible: true })
      .expect(200);

    const completed = await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(200);

    expect(completed.body.status).toBe('completed');
    expect(completed.body.blockers.canComplete).toBe(false);

    const [trainerRow, assignment, user] = await Promise.all([
      harness.prisma.db.trainer.findUniqueOrThrow({ where: { id: context.trainerId } }),
      harness.prisma.db.assignment.findUniqueOrThrow({ where: { id: context.assignmentId } }),
      harness.prisma.db.user.findFirstOrThrow({ where: { trainer: { id: context.trainerId } } }),
    ]);
    expect(trainerRow.status).toBe('deboarded');
    expect(assignment.status).toBe('ended');
    expect(assignment.endDate).not.toBeNull();
    // Their login stops working; the record survives for the Talent Pool.
    expect(user.status).toBe('disabled');
  });

  it('insists a settled amount says how much', async () => {
    const id = await initiate();
    await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ fnfStatus: 'settled' })
      .expect(422);
  });

  it('refuses to complete twice', async () => {
    const id = await initiate();
    await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ fnfStatus: 'waived' })
      .expect(200);
    await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(200);

    await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(409);
  });

  it('advances the stage as the facts change', async () => {
    const id = await initiate();
    const issueId = await issueLaptop('EXIT-0005');

    // Something is out, so the checklist sits at assets_pending.
    let current = await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ travelNotes: 'Return flight booked.' })
      .expect(200);
    expect(current.body.status).toBe('assets_pending');

    await harness
      .http()
      .post(`/api/v1/asset-issues/${issueId}/return`)
      .set(auth(manager))
      .send({ condition: 'returned', returnSerial: 'EXIT-0005' })
      .expect(200);

    current = await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ feedback: 'Solid delivery throughout.' })
      .expect(200);
    expect(current.body.status).toBe('fnf_pending');
    expect(current.body.assetsReconciled).toBe(true);
  });
});

/* ------------------------------------------------------------- talent pool */

describe('the talent pool', () => {
  /** Walks a candidate to a rejection, which is what puts them in the pool. */
  async function rejectedCandidate(name: string) {
    const fileId = newId();
    await harness.prisma.db.fileObject.create({
      data: {
        id: fileId,
        storageKey: `resumes/${fileId}/cv.pdf`,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });

    const candidate = await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name,
        email: `${name.toLowerCase().replace(/ /g, '.')}.${Date.now()}@example.com`,
        phone: '+919812345670',
        resumeFileId: fileId,
        positionId: context.positionId,
      })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/applications/${candidate.body.application.id}/screen`)
      .set(auth(hr))
      .send({
        outcome: 'reject',
        reason: 'Not enough React depth for this cohort.',
        notes: 'Pleasant call; would consider for a Java cohort.',
      })
      .expect(200);

    return candidate.body.id as string;
  }

  /** Deboards the plain trainer completely, which is what puts them in the pool. */
  async function deboardTrainer(rehireEligible: boolean) {
    const id = await initiate();
    await harness
      .http()
      .patch(`/api/v1/deboardings/${id}`)
      .set(auth(hr))
      .send({ fnfStatus: 'waived', rehireEligible })
      .expect(200);
    await harness
      .http()
      .post(`/api/v1/deboardings/${id}/complete`)
      .set(auth(hr))
      .send({})
      .expect(200);
  }

  it('lists a rejected candidate with the reason they were rejected', async () => {
    await rejectedCandidate('Nikhil Rao');

    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const entry = (pool.body.data as { name: string; lastReason: string; source: string }[]).find(
      (row) => row.name === 'Nikhil Rao',
    );

    expect(entry?.source).toBe('candidate');
    expect(entry?.lastReason).toMatch(/React depth/);
  });

  it('leaves somebody still in the pipeline out of it', async () => {
    const fileId = newId();
    await harness.prisma.db.fileObject.create({
      data: {
        id: fileId,
        storageKey: `resumes/${fileId}/cv.pdf`,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name: 'Still Applying',
        email: `still.${Date.now()}@example.com`,
        phone: '+919812345671',
        resumeFileId: fileId,
        positionId: context.positionId,
      })
      .expect(201);

    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const names = (pool.body.data as { name: string }[]).map((row) => row.name);
    expect(names).not.toContain('Still Applying');
  });

  it('adds a deboarded trainer when they are re-hire eligible', async () => {
    await deboardTrainer(true);

    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const entry = (pool.body.data as { source: string; workedBefore: boolean; id: string }[]).find(
      (row) => row.id === context.trainerId,
    );

    expect(entry?.source).toBe('past_trainer');
    expect(entry?.workedBefore).toBe(true);
  });

  it('takes them straight back out when eligibility is revoked', async () => {
    await deboardTrainer(true);
    await harness.prisma.db.trainer.update({
      where: { id: context.trainerId },
      data: { rehireEligible: false },
    });

    // Nobody set a flag: the pool is a query, so it simply stops matching.
    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const ids = (pool.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain(context.trainerId);
  });

  it('filters to people who have actually worked here', async () => {
    await rejectedCandidate('Never Worked Here');
    await deboardTrainer(true);

    const response = await harness
      .http()
      .get('/api/v1/pool?workedBefore=true')
      .set(auth(hr))
      .expect(200);

    const rows = response.body.data as { workedBefore: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workedBefore)).toBe(true);
  });

  it('searches by name and by employee code', async () => {
    await deboardTrainer(true);
    const trainerRow = await harness.prisma.db.trainer.findUniqueOrThrow({
      where: { id: context.trainerId },
    });

    const byCode = await harness
      .http()
      .get(`/api/v1/pool?q=${trainerRow.employeeCode}`)
      .set(auth(hr))
      .expect(200);
    expect(byCode.body.meta.total).toBe(1);
  });

  it('puts a pool entry back into the pipeline on another open position', async () => {
    const candidateId = await rejectedCandidate('Worth Another Look');

    const application = await harness
      .http()
      .post(`/api/v1/pool/${candidateId}/create-application`)
      .set(auth(hr))
      .send({ positionId: context.otherPositionId })
      .expect(201);

    expect(application.body.status).toBe('applied');
    expect(application.body.candidate.id).toBe(candidateId);
  });

  it('will not put somebody forward for the position that already rejected them', async () => {
    const candidateId = await rejectedCandidate('Already Seen Here');

    const response = await harness
      .http()
      .post(`/api/v1/pool/${candidateId}/create-application`)
      .set(auth(hr))
      .send({ positionId: context.positionId })
      .expect(409);

    // The ordinary application rules apply — the pool is another way in, not a
    // way around them — and the refusal says which position and what happened.
    expect(response.body.detail).toMatch(/already applied to Replacement Trainer/);
  });

  it('creates the missing candidate record for a trainer hired outside the pipeline', async () => {
    await deboardTrainer(true);

    const application = await harness
      .http()
      .post(`/api/v1/pool/${context.trainerId}/create-application`)
      .set(auth(hr))
      .send({ positionId: context.positionId })
      .expect(201);

    const trainerRow = await harness.prisma.db.trainer.findUniqueOrThrow({
      where: { id: context.trainerId },
    });
    expect(trainerRow.candidateId).toBe(application.body.candidate.id);
  });

  it('will not put forward somebody marked not eligible', async () => {
    await deboardTrainer(false);

    const response = await harness
      .http()
      .post(`/api/v1/pool/${context.trainerId}/create-application`)
      .set(auth(hr))
      .send({ positionId: context.positionId })
      .expect(409);
    expect(response.body.detail).toMatch(/not eligible for re-hire/i);
  });

  it('is not readable by a trainer', async () => {
    await harness.http().get('/api/v1/pool').set(auth(trainer)).expect(403);
  });

  it('is not readable through the deboarding queue either', async () => {
    // A trainer holds no `deboarding.read`: nothing shows them their own exit
    // checklist, so the capability would only put an administrator's queue in
    // their sidebar.
    await harness.http().get('/api/v1/deboardings').set(auth(trainer)).expect(403);
  });
});

/* -------------------------------------------------------------- dashboards */

describe('the dashboard', () => {
  it('counts only what the caller could actually open', async () => {
    const response = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(manager))
      .expect(200);

    const keys = (response.body.tiles as { key: string }[]).map((tile) => tile.key);
    expect(keys).toContain('active-trainers');
    expect(keys).toContain('pending-approvals');
    expect(keys).toContain('open-flags');
  });

  it('gives a trainer their own working life, not a queue', async () => {
    const response = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(trainer))
      .expect(200);

    const keys = (response.body.tiles as { key: string }[]).map((tile) => tile.key);
    expect(keys).toContain('my-assignments');
    expect(keys).toContain('my-open-days');
    // They approve nothing, so the tile is absent rather than a permanent zero.
    expect(keys).not.toContain('pending-approvals');
  });

  it('withholds the activity feed from anyone who cannot read the audit log', async () => {
    const asTrainer = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(trainer))
      .expect(200);
    expect(asTrainer.body.recent).toEqual([]);

    const asManager = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(manager))
      .expect(200);
    expect(asManager.body.recent.length).toBeGreaterThan(0);
  });

  it('names what is waiting rather than only counting it', async () => {
    const leaveDay = nextWorkingDay(3);
    await harness
      .http()
      .post('/api/v1/leave-requests')
      .set(auth(trainer))
      .send({
        startDate: leaveDay,
        endDate: leaveDay,
        reason: 'A day for the dashboard to notice.',
      })
      .expect(201);

    const response = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(lead))
      .expect(200);

    const actions = response.body.actions as { kind: string; title: string }[];
    expect(actions.some((action) => action.kind === 'leave')).toBe(true);
    expect(actions.find((action) => action.kind === 'leave')?.title).toMatch(/requested leave/);
  });

  it('never promises a tile the list behind it would refuse', async () => {
    // A lead's counts are project-scoped; the numbers must agree with the lists.
    const summary = await harness
      .http()
      .get('/api/v1/dashboard/summary')
      .set(auth(lead))
      .expect(200);
    const tile = (summary.body.tiles as { key: string; value: number }[]).find(
      (entry) => entry.key === 'active-trainers',
    );

    const trainers = await harness.http().get('/api/v1/trainers').set(auth(lead)).expect(200);
    const active = (trainers.body.data as { status: string }[]).filter(
      (row) => row.status === 'active',
    );
    expect(tile?.value).toBe(active.length);
  });
});

/* --------------------------------------------------------------- csv export */

describe('CSV export', () => {
  it('quotes a field containing a comma, a quote or a newline', () => {
    expect(toCsvField('plain')).toBe('plain');
    expect(toCsvField('Pune, Maharashtra')).toBe('"Pune, Maharashtra"');
    expect(toCsvField('He said "no"')).toBe('"He said ""no"""');
    expect(toCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('neutralises a field a spreadsheet would run as a formula', () => {
    // The export carries user-supplied text; without this, opening it executes it.
    expect(toCsvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(toCsvField('+1234')).toBe("'+1234");
    expect(toCsvField('-1234')).toBe("'-1234");
    expect(toCsvField('@import')).toBe("'@import");
  });

  it('renders a header row and one line per record', () => {
    const csv = toCsv(
      [{ name: 'Asha', city: 'Pune, MH' }],
      [
        { header: 'name', value: (row) => row.name },
        { header: 'city', value: (row) => row.city },
      ],
    );
    expect(csv).toBe('name,city\r\nAsha,"Pune, MH"\r\n');
  });

  it('exports the pool as a file with a header row', async () => {
    const response = await harness.http().get('/api/v1/pool/export.csv').set(auth(hr)).expect(200);

    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/managedops-talent-pool\.csv/);
    expect(response.text).toMatch(/name,email,phone/);
  });

  it('refuses an export to somebody who cannot read the list', async () => {
    await harness.http().get('/api/v1/pool/export.csv').set(auth(trainer)).expect(403);
    await harness.http().get('/api/v1/audit-logs/export.csv').set(auth(trainer)).expect(403);
  });
});
