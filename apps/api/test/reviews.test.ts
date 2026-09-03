import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * The evidence a re-hire decision rests on.
 *
 * Three things matter here and are checked nowhere else: that a review cannot
 * be quietly rewritten, that a trainer sees their own scores without the words
 * behind them, and that the summary actually reaches the two screens where the
 * decision gets made.
 */
let harness: Harness;
let manager: Session;
let hr: Session;
let lead: Session;
let trainer: Session;

let context: {
  projectId: string;
  assignmentId: string;
  trainerId: string;
  otherTrainerId: string;
  otherAssignmentId: string;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function buildWorld() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });
  const client = await harness.seedClient('Feedback Test Client');

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Feedback Test Project',
      code: `FB-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: client.id,
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      managerId: managerUser!.id,
      hrId: hrUser!.id,
      leadTrainerId: leadUser!.id,
    },
  });

  const makeTrainer = async (userId: string) => {
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId,
        employeeCode: `FB-${Math.floor(Math.random() * 1_000_000)}`,
        personalEmail: `fb-${Math.random()}@example.com`,
        phone: '+919812345678',
        status: 'active',
        salaryAnnual: 720_000,
      },
    });
    const assignment = await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: record.id,
        projectId: project.id,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        allocationPercent: 50,
      },
    });
    return { trainerId: record.id, assignmentId: assignment.id };
  };

  const subject = await makeTrainer(trainerUser!.id);
  const other = await makeTrainer(leadUser!.id);

  return {
    projectId: project.id,
    assignmentId: subject.assignmentId,
    trainerId: subject.trainerId,
    otherTrainerId: other.trainerId,
    otherAssignmentId: other.assignmentId,
  };
}

// Not async: the supertest object has to come back unwrapped so `.expect`
// still chains off it.
function record(session: Session, body: Record<string, unknown> = {}) {
  return harness
    .http()
    .post('/api/v1/reviews')
    .set(auth(session))
    .send({
      assignmentId: context.assignmentId,
      source: 'internal_observation',
      rating: 4,
      observedOn: daysAgo(10),
      ...body,
    });
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

describe('recording what delivery was like', () => {
  it('accepts a review from a manager, HR or the lead who watched it', async () => {
    for (const session of [manager, hr, lead]) {
      await record(session, { observedOn: daysAgo(Math.floor(Math.random() * 90) + 1) }).expect(
        201,
      );
    }
  });

  it('refuses one from the trainer it is about', async () => {
    // A plain trainer never gets this far — they hold no `reviews.write` and
    // the guard stops them. The case that needs the service's own check is a
    // project lead, who both writes reviews and has a trainer profile of their
    // own, and could otherwise rate themselves.
    const response = await harness
      .http()
      .post('/api/v1/reviews')
      .set(auth(lead))
      .send({
        assignmentId: context.otherAssignmentId,
        source: 'internal_observation',
        rating: 5,
        observedOn: daysAgo(5),
      })
      .expect(403);
    expect(response.body.detail).toMatch(/your own delivery/i);
  });

  it('refuses a plain trainer at the guard, before the service is reached', async () => {
    await record(trainer).expect(403);
  });

  it('insists a learner batch says how many learners it covers', async () => {
    // A batch summary with no headcount cannot be weighed against anything.
    await record(hr, { source: 'learner_batch', respondents: undefined }).expect(422);
    await record(hr, { source: 'learner_batch', respondents: 30 }).expect(201);
  });

  it('refuses a rating outside one to five', async () => {
    await record(hr, { rating: 0 }).expect(422);
    await record(hr, { rating: 6 }).expect(422);
  });

  it('refuses feedback about work that has not happened yet', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await record(hr, { observedOn: tomorrow }).expect(422);
  });

  it('refuses feedback from before they were on the project', async () => {
    const response = await record(hr, { observedOn: '2025-06-01' }).expect(409);
    expect(response.body.detail).toMatch(/only started on this project/);
  });
});

describe('a review cannot be rewritten', () => {
  it('offers no way to edit one at all', async () => {
    const created = await record(hr).expect(201);

    // A performance record anybody can quietly change is worth much less than
    // one they cannot, so there is deliberately no PATCH to find.
    await harness
      .http()
      .patch(`/api/v1/reviews/${created.body.id}`)
      .set(auth(manager))
      .send({ rating: 1 })
      .expect(404);
  });

  it('is withdrawn with a reason, and stays visible as withdrawn', async () => {
    const created = await record(hr, { rating: 1 }).expect(201);

    const retracted = await harness
      .http()
      .post(`/api/v1/reviews/${created.body.id}/retract`)
      .set(auth(manager))
      .send({ reason: 'Logged against the wrong trainer entirely.' })
      .expect(200);

    expect(retracted.body.retractedAt).not.toBeNull();
    expect(retracted.body.retractedReason).toMatch(/wrong trainer/);

    const listed = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/reviews`)
      .set(auth(hr))
      .expect(200);
    // Still listed: hiding it would make a withdrawal indistinguishable from a
    // review nobody ever wrote.
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.summary.retractedCount).toBe(1);
    expect(listed.body.summary.overall).toBeNull();
  });

  it('insists on a reason long enough to be one', async () => {
    const created = await record(hr).expect(201);
    await harness
      .http()
      .post(`/api/v1/reviews/${created.body.id}/retract`)
      .set(auth(manager))
      .send({ reason: 'nope' })
      .expect(422);
  });

  it('will not withdraw the same review twice', async () => {
    const created = await record(hr).expect(201);
    const withdraw = () =>
      harness
        .http()
        .post(`/api/v1/reviews/${created.body.id}/retract`)
        .set(auth(manager))
        .send({ reason: 'A perfectly good reason to withdraw it.' });

    await withdraw().expect(200);
    await withdraw().expect(409);
  });

  it('is not something HR or a lead may withdraw', async () => {
    const created = await record(hr).expect(201);
    for (const session of [hr, lead]) {
      await harness
        .http()
        .post(`/api/v1/reviews/${created.body.id}/retract`)
        .set(auth(session))
        .send({ reason: 'Trying it on, for the sake of the test.' })
        .expect(403);
    }
  });
});

describe('what a trainer sees of their own', () => {
  beforeEach(async () => {
    await record(hr, {
      source: 'learner_batch',
      respondents: 20,
      rating: 5,
      comment: 'A remark a cohort wrote expecting it to stay between them.',
      observedOn: daysAgo(20),
    }).expect(201);
    await record(manager, {
      source: 'client',
      rating: 4,
      comment: 'What the client actually said.',
      observedOn: daysAgo(10),
    }).expect(201);
  });

  it('gives them their scores, so feedback is something they can act on', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/reviews`)
      .set(auth(trainer))
      .expect(200);

    expect(response.body.summary.overall).toBe(4.5);
    expect(response.body.summary.bySource).toHaveLength(2);
    expect(response.body.data).toHaveLength(2);
  });

  it('withholds the comments and who wrote them', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/reviews`)
      .set(auth(trainer))
      .expect(200);

    for (const review of response.body.data) {
      // Absent, not nulled: a learner cohort writes under an expectation of
      // anonymity, and the field never leaves the server for this caller.
      expect(review).not.toHaveProperty('comment');
      expect(review).not.toHaveProperty('submittedBy');
    }
    expect(response.body.viewer.readsComments).toBe(false);
  });

  it('gives an administrator the words as well as the numbers', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/reviews`)
      .set(auth(hr))
      .expect(200);

    expect(response.body.viewer.readsComments).toBe(true);
    expect(response.body.data[0].comment).toBeTruthy();
    expect(response.body.data[0].submittedBy.name).toBeTruthy();
  });

  it('does not let a trainer read a colleague’s', async () => {
    await harness
      .http()
      .get(`/api/v1/trainers/${context.otherTrainerId}/reviews`)
      .set(auth(trainer))
      .expect(404);
  });

  it('withholds the comments from the list endpoint too, not only the detail', async () => {
    const response = await harness.http().get('/api/v1/reviews').set(auth(trainer)).expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    for (const review of response.body.data) {
      expect(review).not.toHaveProperty('comment');
    }
  });
});

describe('the loop back to the re-hire decision', () => {
  it('puts the summary on the deboarding, where the box is ticked', async () => {
    await record(hr, { rating: 5, observedOn: daysAgo(30) }).expect(201);

    const deboarding = await harness
      .http()
      .post('/api/v1/deboardings')
      .set(auth(hr))
      .send({
        assignmentId: context.assignmentId,
        lastWorkingDay: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
        reason: 'Moving on to another organisation entirely.',
      })
      .expect(201);

    const detail = await harness
      .http()
      .get(`/api/v1/deboardings/${deboarding.body.id}`)
      .set(auth(hr))
      .expect(200);

    expect(detail.body.quality.overall).toBe(5);
    expect(detail.body.quality.confident).toBe(false);
    expect(detail.body.quality.caveat).toMatch(/single review/);
  });

  it('puts it in the Talent Pool, beside people we might take back', async () => {
    await record(hr, {
      source: 'learner_batch',
      respondents: 30,
      rating: 4,
      observedOn: daysAgo(40),
    }).expect(201);

    // Take them all the way out, which is what puts them in the pool.
    await harness.prisma.db.trainer.update({
      where: { id: context.trainerId },
      data: { status: 'deboarded', rehireEligible: true },
    });
    await harness.prisma.db.assignment.update({
      where: { id: context.assignmentId },
      data: { status: 'ended', endDate: new Date() },
    });

    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const entry = pool.body.data.find((row: { id: string }) => row.id === context.trainerId);

    expect(entry.quality.overall).toBe(4);
    expect(entry.quality.respondentCount).toBe(30);
    expect(entry.quality.confident).toBe(true);
  });

  it('says a candidate who never delivered has nothing to be rated on', async () => {
    const pool = await harness.http().get('/api/v1/pool').set(auth(hr)).expect(200);
    const candidates = pool.body.data.filter(
      (row: { source: string }) => row.source === 'candidate',
    );
    for (const candidate of candidates) {
      // Different from a low score, and said differently.
      expect(candidate.quality).toBeNull();
    }
  });
});
