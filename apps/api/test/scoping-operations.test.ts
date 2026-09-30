import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * Layer three of the permission model, across the domains that came later.
 *
 * `scoping.test.ts` attacks the recruitment side hard — interviews, projects,
 * positions, candidates, offers, applications — and includes the filter-override
 * cases. The operational side grew afterwards and was never given the same
 * treatment: the predicates are applied in every service, but nothing would have
 * caught a regression that removed one.
 *
 * Every test below asks the same question of a different resource: can a project
 * lead reach the other project's records, and can a trainer reach a colleague's?
 * A predicate that is quietly dropped makes exactly these go green-to-red, which
 * is the point of writing them.
 *
 * The shape is deliberately repetitive. Each domain gets its list, its fetch by
 * exact id, and — where the endpoint takes one — its attempt to widen the result
 * with a query parameter, because "the scope is a floor no filter can raise" is
 * the property that actually matters and it is per endpoint.
 */
let harness: Harness;

let hr: Session;
let leadA: Session;
let leadB: Session;
let trainerA: Session;
let trainerB: Session;

interface Side {
  projectId: string;
  trainerId: string;
  trainerUserId: string;
  assignmentId: string;
  attendanceId: string;
  leaveId: string;
  reimbursementId: string;
  assetIssueId: string;
  flagId: string;
  deboardingId: string;
  reviewId: string;
}

let a: Side;
let b: Side;

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function confirmedFile(uploaderId: string): Promise<string> {
  const id = newId();
  await harness.prisma.db.fileObject.create({
    data: {
      id,
      storageKey: `receipts/${id}/bill.pdf`,
      originalName: 'bill.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
      uploadedById: uploaderId,
      confirmedAt: new Date(),
      scanStatus: 'skipped',
    },
  });
  return id;
}

/**
 * One project with a lead, a trainer, and one of every operational record.
 *
 * Built through Prisma rather than through the endpoints that would normally
 * produce them: those paths have their own suites, and routing this fixture
 * through them would make a scoping regression look like a recruitment failure.
 */
async function buildSide(label: string, leadUserId: string, trainerUserId: string): Promise<Side> {
  const managerUser = await harness.prisma.db.user.findFirstOrThrow({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirstOrThrow({ where: { role: 'hr' } });

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: `Scoped Project ${label}`,
      code: `SC${label}-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: (await harness.seedClient(`Client ${label}`)).id,
      startDate: new Date(`${dayOffset(-30)}T00:00:00Z`),
      status: 'active',
      managerId: managerUser.id,
      hrId: hrUser.id,
      leadTrainerId: leadUserId,
      weeklyOffDays: [0],
    },
  });

  const makeTrainer = async (userId: string, role: 'lead' | 'trainer') => {
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId,
        employeeCode: `SC${label}-${role}-${Math.floor(Math.random() * 100000)}`,
        personalEmail: `${label}-${role}@example.com`,
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

  await makeTrainer(leadUserId, 'lead');
  const trainer = await makeTrainer(trainerUserId, 'trainer');

  const attendance = await harness.prisma.db.attendanceRecord.create({
    data: {
      id: newId(),
      assignmentId: trainer.assignmentId,
      workDate: new Date(`${dayOffset(-2)}T00:00:00Z`),
      status: 'present',
      source: 'punch',
    },
  });

  const leave = await harness.prisma.db.leaveRequest.create({
    data: {
      id: newId(),
      assignmentId: trainer.assignmentId,
      startDate: new Date(`${dayOffset(5)}T00:00:00Z`),
      endDate: new Date(`${dayOffset(5)}T00:00:00Z`),
      dayType: 'full',
      daysCount: 1,
      unpaidDays: 0,
      reason: `Leave on side ${label}`,
      status: 'submitted',
    },
  });

  const reimbursement = await harness.prisma.db.reimbursement.create({
    data: {
      id: newId(),
      trainerId: trainer.trainerId,
      assignmentId: trainer.assignmentId,
      category: 'travel',
      amount: 1200,
      description: `Travel on side ${label}`,
      proofFileId: await confirmedFile(trainerUserId),
      status: 'submitted',
    },
  });

  const asset = await harness.prisma.db.asset.create({
    data: {
      id: newId(),
      name: `Laptop ${label}`,
      category: 'hardware',
      serialNumber: `SC${label}-${Math.floor(Math.random() * 1_000_000)}`,
      status: 'issued',
    },
  });
  const assetIssue = await harness.prisma.db.assetIssue.create({
    data: {
      id: newId(),
      assetId: asset.id,
      assignmentId: trainer.assignmentId,
      issuedById: managerUser.id,
      issuedAt: new Date(),
      status: 'issued',
    },
  });

  const flag = await harness.prisma.db.flag.create({
    data: {
      id: newId(),
      assignmentId: trainer.assignmentId,
      severity: 'low',
      description: `Flag on side ${label}`,
      status: 'raised',
      raisedById: managerUser.id,
    },
  });

  const deboarding = await harness.prisma.db.deboarding.create({
    data: {
      id: newId(),
      assignmentId: trainer.assignmentId,
      initiatedById: managerUser.id,
      reason: 'contract_end',
      lastWorkingDay: new Date(`${dayOffset(20)}T00:00:00Z`),
      status: 'initiated',
    },
  });

  const review = await harness.prisma.db.trainerReview.create({
    data: {
      id: newId(),
      assignmentId: trainer.assignmentId,
      source: 'internal_observation',
      rating: 4,
      comment: `Review on side ${label}`,
      submittedById: managerUser.id,
      observedOn: new Date(`${dayOffset(-5)}T00:00:00Z`),
    },
  });

  return {
    projectId: project.id,
    trainerId: trainer.trainerId,
    trainerUserId,
    assignmentId: trainer.assignmentId,
    attendanceId: attendance.id,
    leaveId: leave.id,
    reimbursementId: reimbursement.id,
    assetIssueId: assetIssue.id,
    flagId: flag.id,
    deboardingId: deboarding.id,
    reviewId: review.id,
  };
}

beforeAll(async () => {
  harness = await createHarness();
  await resetDatabase(harness.prisma);

  const hrUser = await harness.seedUser({ role: 'hr' });
  await harness.seedUser({ role: 'manager' });
  const leadAUser = await harness.seedUser({ role: 'project_lead' });
  const leadBUser = await harness.seedUser({ role: 'project_lead' });
  const trainerAUser = await harness.seedUser({ role: 'trainer' });
  const trainerBUser = await harness.seedUser({ role: 'trainer' });

  hr = await harness.signIn(hrUser.email);

  // Built before the leads and trainers sign in: a scoped role carries its
  // project and trainer ids in the access token, so a token minted earlier
  // would hold an empty scope and every read below would see nothing — which
  // would make these tests pass for entirely the wrong reason.
  a = await buildSide('A', leadAUser.id, trainerAUser.id);
  b = await buildSide('B', leadBUser.id, trainerBUser.id);

  leadA = await harness.signIn(leadAUser.email);
  leadB = await harness.signIn(leadBUser.email);
  trainerA = await harness.signIn(trainerAUser.email);
  trainerB = await harness.signIn(trainerBUser.email);
});

afterAll(async () => {
  await harness?.close();
});

/** The list holds this caller's row and not the other side's. */
async function listIsScoped(session: Session, path: string, mine: string, theirs: string) {
  const response = await harness.http().get(path).set(auth(session)).expect(200);
  const rows = (response.body.data ?? response.body) as { id: string }[];
  const ids = rows.map((row) => row.id);
  expect(ids, `${path} did not return this caller's own row`).toContain(mine);
  expect(ids, `${path} leaked a row from the other project`).not.toContain(theirs);
}

describe('a project lead reaches their own project and no further', () => {
  it('sees their attendance and not the other project’s', async () => {
    await listIsScoped(leadA, '/api/v1/attendance?pageSize=100', a.attendanceId, b.attendanceId);
  });

  it('cannot widen attendance to the other project through ?projectId', async () => {
    // The scope is a floor: naming somebody else's project must return nothing,
    // never fall back to their own, and never honour the filter.
    const response = await harness
      .http()
      .get(`/api/v1/attendance?projectId=${b.projectId}&pageSize=100`)
      .set(auth(leadA))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('sees leave on their project and not the other’s', async () => {
    await listIsScoped(leadA, '/api/v1/leave-requests?pageSize=100', a.leaveId, b.leaveId);
  });

  it('cannot decide leave on the other project', async () => {
    await harness
      .http()
      .post(`/api/v1/leave-requests/${b.leaveId}/decide`)
      .set(auth(leadA))
      .send({ decision: 'approved' })
      .expect(404);
  });

  it('sees flags on their project and not the other’s', async () => {
    await listIsScoped(leadA, '/api/v1/flags?pageSize=100', a.flagId, b.flagId);
  });

  it('sees trainers on their project and not the other’s', async () => {
    await listIsScoped(leadA, '/api/v1/trainers?pageSize=100', a.trainerId, b.trainerId);
  });

  it('cannot fetch a trainer from the other project by exact id', async () => {
    // Invisible rather than forbidden: as far as this caller is concerned the
    // record does not exist, which is also what stops the 404/403 difference
    // confirming that it does.
    await harness.http().get(`/api/v1/trainers/${b.trainerId}`).set(auth(leadA)).expect(404);
  });

  it('scopes the other lead to their own side, the other way round', async () => {
    // Asserting the mirror image rules out a predicate that happens to match
    // whichever project was created first.
    await listIsScoped(leadB, '/api/v1/attendance?pageSize=100', b.attendanceId, a.attendanceId);
    await listIsScoped(leadB, '/api/v1/flags?pageSize=100', b.flagId, a.flagId);
  });
});

describe('a trainer reaches their own records and no colleague’s', () => {
  it('sees their own attendance only', async () => {
    await listIsScoped(trainerA, '/api/v1/attendance?pageSize=100', a.attendanceId, b.attendanceId);
  });

  it('sees their own leave only', async () => {
    await listIsScoped(trainerA, '/api/v1/leave-requests?pageSize=100', a.leaveId, b.leaveId);
  });

  it('sees their own claims only', async () => {
    await listIsScoped(
      trainerA,
      '/api/v1/reimbursements?pageSize=100',
      a.reimbursementId,
      b.reimbursementId,
    );
  });

  it('cannot reach a colleague’s claim by its exact id', async () => {
    await harness
      .http()
      .get(`/api/v1/reimbursements/${b.reimbursementId}`)
      .set(auth(trainerA))
      .expect(404);
  });

  it('cannot widen their claims to a colleague through ?trainerId', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/reimbursements?trainerId=${b.trainerId}&pageSize=100`)
      .set(auth(trainerA))
      .expect(200);
    const ids = (response.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain(b.reimbursementId);
  });

  it('sees the assets in their own hands and not the whole store cupboard', async () => {
    // The asset register is reached through what the caller holds, so this
    // asks the assets endpoint rather than a list of issues, which has none.
    const response = await harness
      .http()
      .get('/api/v1/assets?pageSize=100')
      .set(auth(trainerA))
      .expect(200);

    const text = JSON.stringify(response.body);
    expect(text).toContain('Laptop A');
    expect(text).not.toContain('Laptop B');
  });

  it('cannot return an asset issued to a colleague', async () => {
    // The only endpoint that takes an issue by id. A missing scope here would
    // let one trainer close out another's equipment.
    await harness
      .http()
      .post(`/api/v1/asset-issues/${b.assetIssueId}/return`)
      .set(auth(trainerA))
      .send({ returnNotes: 'Not mine to hand back.' })
      .expect((response) => {
        expect([403, 404]).toContain(response.status);
      });
  });

  it('reads their own review scores and not a colleague’s', async () => {
    const mine = await harness
      .http()
      .get(`/api/v1/trainers/${a.trainerId}/reviews`)
      .set(auth(trainerA))
      .expect(200);
    expect(JSON.stringify(mine.body)).not.toContain('Review on side B');

    // A colleague's feedback is not theirs to read at all, whatever it says.
    await harness
      .http()
      .get(`/api/v1/trainers/${b.trainerId}/reviews`)
      .set(auth(trainerA))
      .expect(404);
  });

  it('cannot see the other trainer at all', async () => {
    await harness.http().get(`/api/v1/trainers/${b.trainerId}`).set(auth(trainerA)).expect(404);
    await listIsScoped(trainerB, '/api/v1/leave-requests?pageSize=100', b.leaveId, a.leaveId);
  });
});

describe('an organisation-wide role sees both sides', () => {
  it('HR sees every trainer, every claim and every deboarding', async () => {
    const trainers = await harness
      .http()
      .get('/api/v1/trainers?pageSize=100')
      .set(auth(hr))
      .expect(200);
    const trainerIds = (trainers.body.data as { id: string }[]).map((row) => row.id);
    expect(trainerIds).toEqual(expect.arrayContaining([a.trainerId, b.trainerId]));

    const deboardings = await harness
      .http()
      .get('/api/v1/deboardings?pageSize=100')
      .set(auth(hr))
      .expect(200);
    const deboardingIds = (deboardings.body.data as { id: string }[]).map((row) => row.id);
    expect(deboardingIds).toEqual(expect.arrayContaining([a.deboardingId, b.deboardingId]));
  });

  it('proves the tests above are not passing because everything is empty', async () => {
    // The failure mode these guard against: a scope predicate that matches
    // nothing makes every "cannot see the other side" assertion pass while the
    // feature is entirely broken. If HR cannot see both sides either, the
    // fixture is wrong and the rest of this file proves nothing.
    const leave = await harness
      .http()
      .get('/api/v1/leave-requests?pageSize=100')
      .set(auth(hr))
      .expect(200);
    const ids = (leave.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([a.leaveId, b.leaveId]));
  });
});

describe('the client directory', () => {
  it('is scoped through the data layer like everything else', async () => {
    // Every role holding `clients.read` is unscoped today, so this passes by
    // returning everything. It is here because the service used to take the
    // caller and ignore them: the predicate is now applied, and a narrower role
    // granted the capability would be narrowed rather than silently shown all.
    const response = await harness
      .http()
      .get('/api/v1/clients?pageSize=100')
      .set(auth(hr))
      .expect(200);
    expect((response.body.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('is refused outright to a lead and a trainer', async () => {
    for (const session of [leadA, trainerA]) {
      await harness.http().get('/api/v1/clients').set(auth(session)).expect(403);
    }
  });
});
