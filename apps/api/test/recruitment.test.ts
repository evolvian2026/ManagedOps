import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * The recruitment pipeline, end to end and against a real database.
 *
 * The through-line these tests protect is the one the specification is built
 * around: a candidate is a person, an application is that person applied to one
 * position, and every status change goes through a transition table.
 */
let harness: Harness;
let hr: Session;
let manager: Session;

/** Uploads are verified against object storage, which is not running in tests,
 *  so a confirmed file row is created directly for the resume requirement. */
async function seedConfirmedFile(uploaderId: string): Promise<string> {
  const id = newId();
  await harness.prisma.db.fileObject.create({
    data: {
      id,
      storageKey: `resumes/${id}/cv.pdf`,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12_345,
      uploadedById: uploaderId,
      confirmedAt: new Date(),
      scanStatus: 'skipped',
    },
  });
  return id;
}

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function futureDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function futureInstant(hoursAhead: number): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

async function createProject(): Promise<string> {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });

  const response = await harness
    .http()
    .post('/api/v1/projects')
    .set(auth(manager))
    .send({
      name: 'Spring Bootcamp',
      code: `SB-${Math.floor(Math.random() * 100000)}`,
      clientName: 'Horizon Institute',
      startDate: futureDate(7),
      managerId: managerUser!.id,
      hrId: hrUser!.id,
    })
    .expect(201);

  return response.body.id as string;
}

async function createPosition(projectId: string, headcount = 1): Promise<string> {
  const response = await harness
    .http()
    .post('/api/v1/positions')
    .set(auth(hr))
    .send({ projectId, title: 'Full Stack Trainer', headcount })
    .expect(201);
  return response.body.id as string;
}

async function createCandidate(positionId?: string) {
  const resumeFileId = await seedConfirmedFile(hr.user.id);
  const response = await harness
    .http()
    .post('/api/v1/candidates')
    .set(auth(hr))
    .send({
      name: 'Nikhil Joshi',
      email: `nikhil.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`,
      phone: '+919812345671',
      source: 'referral',
      resumeFileId,
      ...(positionId ? { positionId } : {}),
    })
    .expect(201);
  return response.body as { id: string; application: { id: string } | null };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  // Guarded: if beforeAll failed to boot the app, this would otherwise throw a
  // second, misleading error on top of the real one.
  await harness?.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
  const hrUser = await harness.seedUser({ role: 'hr' });
  const managerUser = await harness.seedUser({ role: 'manager' });
  hr = await harness.signIn(hrUser.email);
  manager = await harness.signIn(managerUser.email);
});

describe('projects and positions', () => {
  it('creates a project and opens a position on it', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);

    const board = await harness.http().get('/api/v1/positions').set(auth(hr)).expect(200);
    const position = board.body.data.find((row: { id: string }) => row.id === positionId);

    expect(position.applicants).toEqual({
      total: 0,
      applied: 0,
      interviewing: 0,
      offer: 0,
      hired: 0,
      closed: 0,
    });
  });

  it('refuses a project whose HR is not actually an HR account', async () => {
    const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });

    const response = await harness
      .http()
      .post('/api/v1/projects')
      .set(auth(manager))
      .send({
        name: 'Misrouted',
        code: 'MIS-1',
        clientName: 'Someone',
        startDate: futureDate(7),
        managerId: managerUser!.id,
        hrId: managerUser!.id,
      })
      .expect(422);

    // Getting this wrong would misroute reimbursements and leave escalations.
    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'hrId' }));
  });

  it('refuses a project that ends before it starts', async () => {
    const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
    const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });

    await harness
      .http()
      .post('/api/v1/projects')
      .set(auth(manager))
      .send({
        name: 'Backwards',
        code: 'BWD-1',
        clientName: 'Someone',
        startDate: futureDate(30),
        endDate: futureDate(7),
        managerId: managerUser!.id,
        hrId: hrUser!.id,
      })
      .expect(422);
  });

  it('rejects a duplicate project code', async () => {
    const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
    const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
    const body = {
      name: 'First',
      code: 'DUP-1',
      clientName: 'Someone',
      startDate: futureDate(7),
      managerId: managerUser!.id,
      hrId: hrUser!.id,
    };

    await harness.http().post('/api/v1/projects').set(auth(manager)).send(body).expect(201);
    const response = await harness
      .http()
      .post('/api/v1/projects')
      .set(auth(manager))
      .send({ ...body, name: 'Second' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'code' }));
  });

  it('closes a position and says how many people are still mid-pipeline', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    await createCandidate(positionId);

    const response = await harness
      .http()
      .post(`/api/v1/positions/${positionId}/close`)
      .set(auth(hr))
      .expect(200);

    // Closing a requisition must not silently lose someone mid-interview.
    expect(response.body.status).toBe('closed');
    expect(response.body.applicationsStillInPipeline).toBe(1);
  });

  it('refuses to apply anyone to a closed position', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    await harness.http().post(`/api/v1/positions/${positionId}/close`).set(auth(hr)).expect(200);

    const resumeFileId = await seedConfirmedFile(hr.user.id);
    const response = await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name: 'Too Late',
        email: 'too.late@example.com',
        phone: '+919812345699',
        resumeFileId,
        positionId,
      })
      .expect(409);

    expect(response.body.detail).toContain('not taking applications');
  });
});

describe('candidates', () => {
  it('requires a resume at intake', async () => {
    const response = await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({ name: 'No Resume', email: 'no.resume@example.com', phone: '+919812345672' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'resumeFileId' }));
  });

  it('refuses a resume reference that was never uploaded', async () => {
    await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name: 'Phantom File',
        email: 'phantom@example.com',
        phone: '+919812345673',
        resumeFileId: newId(),
      })
      .expect(404);
  });

  it('points at the existing record rather than creating a duplicate person', async () => {
    const first = await createCandidate();
    const candidate = await harness.prisma.db.candidate.findUnique({ where: { id: first.id } });
    const resumeFileId = await seedConfirmedFile(hr.user.id);

    const response = await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name: 'Nikhil Joshi Again',
        email: candidate!.email,
        phone: '+919812345674',
        resumeFileId,
      })
      .expect(422);

    expect(response.body.detail).toContain('already on file');
    expect(response.body.detail).toContain(first.id);
  });

  it('creates the candidate and their first application in one request', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    expect(candidate.application).not.toBeNull();
    expect(candidate.application!.id).toEqual(expect.any(String));
  });

  it('keeps one person, many applications — the whole point of the pool', async () => {
    const projectId = await createProject();
    const firstPosition = await createPosition(projectId);
    const secondPosition = await createPosition(projectId);
    const candidate = await createCandidate(firstPosition);

    // Close the first application, then apply them to another position.
    await harness
      .http()
      .post(`/api/v1/applications/${candidate.application!.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'not_available' })
      .expect(200);

    await harness
      .http()
      .post('/api/v1/applications')
      .set(auth(hr))
      .send({ candidateId: candidate.id, positionId: secondPosition })
      .expect(201);

    const detail = await harness
      .http()
      .get(`/api/v1/candidates/${candidate.id}`)
      .set(auth(hr))
      .expect(200);

    expect(detail.body.applications).toHaveLength(2);
  });

  it('refuses a second live application while one is still in flight', async () => {
    const projectId = await createProject();
    const firstPosition = await createPosition(projectId);
    const secondPosition = await createPosition(projectId);
    const candidate = await createCandidate(firstPosition);

    const response = await harness
      .http()
      .post('/api/v1/applications')
      .set(auth(hr))
      .send({ candidateId: candidate.id, positionId: secondPosition })
      .expect(409);

    // Two teams interviewing the same person without knowing is the failure here.
    expect(response.body.detail).toContain('already in the pipeline');
  });
});

describe('screening', () => {
  it('sends a proceed outcome into the interview stage', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    const response = await harness
      .http()
      .post(`/api/v1/applications/${candidate.application!.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'proceed', notes: 'Strong React background' })
      .expect(200);

    expect(response.body.status).toBe('interviewing');
    expect(response.body.screenedBy.id).toBe(hr.user.id);
  });

  it('leaves a not-available candidate pool eligible', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    await harness
      .http()
      .post(`/api/v1/applications/${candidate.application!.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'not_available' })
      .expect(200);

    const record = await harness.prisma.db.candidate.findUnique({ where: { id: candidate.id } });
    expect(record?.poolEligible).toBe(true);
    expect(record?.status).toBe('active');
  });

  it('demands a reason when rejecting, so the pool entry explains itself', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    const response = await harness
      .http()
      .post(`/api/v1/applications/${candidate.application!.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'reject' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'reason' }));
  });

  it('refuses to screen an application twice', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);
    const applicationId = candidate.application!.id;

    await harness
      .http()
      .post(`/api/v1/applications/${applicationId}/screen`)
      .set(auth(hr))
      .send({ outcome: 'proceed' })
      .expect(200);

    // interviewing -> not_available is not a declared transition.
    const response = await harness
      .http()
      .post(`/api/v1/applications/${applicationId}/screen`)
      .set(auth(hr))
      .send({ outcome: 'not_available' })
      .expect(409);

    expect(response.body.detail).toContain('interviewing');
  });
});

describe('interviews', () => {
  async function readyForInterview() {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);
    await harness
      .http()
      .post(`/api/v1/applications/${candidate.application!.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'proceed' })
      .expect(200);
    return { applicationId: candidate.application!.id, positionId, candidateId: candidate.id };
  }

  it('schedules an interview for a screened candidate', async () => {
    const { applicationId } = await readyForInterview();

    const response = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({
        applicationId,
        scheduledAt: futureInstant(48),
        meetingUrl: 'https://meet.example.com/abc-defg-hij',
      })
      .expect(201);

    expect(response.body.round).toBe(1);
    expect(response.body.status).toBe('scheduled');
  });

  it('refuses to schedule someone who has not been screened through', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    const response = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId: candidate.application!.id, scheduledAt: futureInstant(48) })
      .expect(409);

    expect(response.body.detail).toContain('Screen them through');
  });

  it('refuses a time in the past', async () => {
    const { applicationId } = await readyForInterview();

    const response = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: new Date(Date.now() - 3600_000).toISOString() })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'scheduledAt' }));
  });

  it('refuses a second live booking for the same application', async () => {
    const { applicationId } = await readyForInterview();
    await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    const response = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(72) })
      .expect(409);

    expect(response.body.detail).toContain('already has an interview booked');
  });

  it('refuses an interviewer who cannot conduct interviews', async () => {
    const { applicationId } = await readyForInterview();
    const trainer = await harness.seedUser({ role: 'trainer' });

    const response = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48), interviewerId: trainer.id })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'interviewerId' }));
  });

  it('moves a selected candidate to the offer stage', async () => {
    const { applicationId } = await readyForInterview();
    const created = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/interviews/${created.body.id}/outcome`)
      .set(auth(hr))
      .send({ outcome: 'selected', feedback: 'Clear communicator, strong fundamentals' })
      .expect(200);

    const application = await harness.prisma.db.application.findUnique({
      where: { id: applicationId },
    });
    expect(application?.status).toBe('offer_stage');
  });

  it('returns a rejected candidate to the pool with the feedback as the reason', async () => {
    const { applicationId, candidateId } = await readyForInterview();
    const created = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/interviews/${created.body.id}/outcome`)
      .set(auth(hr))
      .send({ outcome: 'rejected', feedback: 'Not enough hands-on teaching experience yet' })
      .expect(200);

    const [application, candidate] = await Promise.all([
      harness.prisma.db.application.findUnique({ where: { id: applicationId } }),
      harness.prisma.db.candidate.findUnique({ where: { id: candidateId } }),
    ]);

    expect(application?.status).toBe('rejected_interview');
    expect(application?.rejectionReason).toContain('teaching experience');
    expect(candidate?.poolEligible).toBe(true);
  });

  it('rescheduling creates a new round and keeps the missed one on record', async () => {
    const { applicationId } = await readyForInterview();
    const first = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/interviews/${first.body.id}/missed`)
      .set(auth(hr))
      .expect(200);

    const second = await harness
      .http()
      .post(`/api/v1/interviews/${first.body.id}/reschedule`)
      .set(auth(hr))
      .send({ scheduledAt: futureInstant(96) })
      .expect(201);

    expect(second.body.round).toBe(2);
    expect(second.body.previousInterviewId).toBe(first.body.id);

    // The missed round survives — that a candidate no-showed is a fact worth keeping.
    const original = await harness.prisma.db.interview.findUnique({
      where: { id: first.body.id },
    });
    expect(original?.status).toBe('missed');
  });

  it('refuses to reschedule the same round twice', async () => {
    const { applicationId } = await readyForInterview();
    const first = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/interviews/${first.body.id}/reschedule`)
      .set(auth(hr))
      .send({ scheduledAt: futureInstant(96) })
      .expect(201);

    const response = await harness
      .http()
      .post(`/api/v1/interviews/${first.body.id}/reschedule`)
      .set(auth(hr))
      .send({ scheduledAt: futureInstant(120) })
      .expect(409);

    expect(response.body.detail).toContain('already rescheduled');
  });

  it('counts to-be-scheduled from applications with no live round', async () => {
    const { positionId } = await readyForInterview();

    const before = await harness
      .http()
      .get('/api/v1/interviews/pipeline')
      .set(auth(hr))
      .expect(200);
    const card = before.body.data.find(
      (row: { position: { id: string } }) => row.position.id === positionId,
    );

    // Derived, not stored — so it cannot disagree with the interviews themselves.
    expect(card.toBeScheduled).toBe(1);
    expect(card.scheduled).toBe(0);
  });

  it('resolves the pipeline route before the :id route', async () => {
    // "pipeline" must never be parsed as an interview identifier.
    await harness.http().get('/api/v1/interviews/pipeline').set(auth(hr)).expect(200);
  });
});

describe('offers', () => {
  async function readyForOffer() {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);
    const applicationId = candidate.application!.id;

    await harness
      .http()
      .post(`/api/v1/applications/${applicationId}/screen`)
      .set(auth(hr))
      .send({ outcome: 'proceed' })
      .expect(200);

    const interview = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({ applicationId, scheduledAt: futureInstant(48) })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/interviews/${interview.body.id}/outcome`)
      .set(auth(hr))
      .send({ outcome: 'selected', feedback: 'Hire' })
      .expect(200);

    return { applicationId, positionId, candidateId: candidate.id };
  }

  it('drafts, sends and accepts an offer', async () => {
    const { applicationId, positionId, candidateId } = await readyForOffer();

    const draft = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 840000, joiningDate: futureDate(30) })
      .expect(201);

    expect(draft.body.version).toBe(1);
    expect(draft.body.status).toBe('draft');

    await harness
      .http()
      .post(`/api/v1/offers/${draft.body.id}/send`)
      .set(auth(hr))
      .send({})
      .expect(200);
    await harness
      .http()
      .post(`/api/v1/offers/${draft.body.id}/respond`)
      .set(auth(hr))
      .send({ response: 'accepted' })
      .expect(200);

    const [application, candidate, position] = await Promise.all([
      harness.prisma.db.application.findUnique({ where: { id: applicationId } }),
      harness.prisma.db.candidate.findUnique({ where: { id: candidateId } }),
      harness.prisma.db.position.findUnique({ where: { id: positionId } }),
    ]);

    expect(application?.status).toBe('hired');
    expect(candidate?.status).toBe('hired');
    expect(candidate?.poolEligible).toBe(false);
    // The seat is consumed, and a single-seat requisition fills itself.
    expect(position?.filledCount).toBe(1);
    expect(position?.status).toBe('filled');
  });

  it('refuses an offer before the candidate has been selected', async () => {
    const projectId = await createProject();
    const positionId = await createPosition(projectId);
    const candidate = await createCandidate(positionId);

    const response = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({
        applicationId: candidate.application!.id,
        salaryAnnual: 840000,
        joiningDate: futureDate(30),
      })
      .expect(409);

    expect(response.body.detail).toContain('follows a successful interview');
  });

  it('revises into a new version rather than overwriting the old one', async () => {
    const { applicationId } = await readyForOffer();
    const first = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 840000, joiningDate: futureDate(30) })
      .expect(201);
    await harness
      .http()
      .post(`/api/v1/offers/${first.body.id}/send`)
      .set(auth(hr))
      .send({})
      .expect(200);

    const second = await harness
      .http()
      .post(`/api/v1/offers/${first.body.id}/revise`)
      .set(auth(hr))
      .send({ salaryAnnual: 900000, joiningDate: futureDate(30) })
      .expect(201);

    expect(second.body.version).toBe(2);
    expect(second.body.status).toBe('draft');

    // Both versions survive; the negotiation stays legible afterwards.
    const detail = await harness
      .http()
      .get(`/api/v1/offers/${second.body.id}`)
      .set(auth(hr))
      .expect(200);
    expect(detail.body.history).toHaveLength(2);
    expect(detail.body.history.map((row: { version: number }) => row.version)).toEqual([2, 1]);
  });

  it('returns a declined candidate to the pool', async () => {
    const { applicationId, candidateId } = await readyForOffer();
    const offer = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 840000, joiningDate: futureDate(30) })
      .expect(201);
    await harness
      .http()
      .post(`/api/v1/offers/${offer.body.id}/send`)
      .set(auth(hr))
      .send({})
      .expect(200);

    await harness
      .http()
      .post(`/api/v1/offers/${offer.body.id}/respond`)
      .set(auth(hr))
      .send({ response: 'declined', notes: 'Took another role closer to home' })
      .expect(200);

    const [application, candidate] = await Promise.all([
      harness.prisma.db.application.findUnique({ where: { id: applicationId } }),
      harness.prisma.db.candidate.findUnique({ where: { id: candidateId } }),
    ]);

    expect(application?.status).toBe('offer_declined');
    expect(application?.rejectionReason).toContain('closer to home');
    expect(candidate?.poolEligible).toBe(true);
  });

  it('refuses to accept an offer that was never sent', async () => {
    const { applicationId } = await readyForOffer();
    const draft = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 840000, joiningDate: futureDate(30) })
      .expect(201);

    const response = await harness
      .http()
      .post(`/api/v1/offers/${draft.body.id}/respond`)
      .set(auth(hr))
      .send({ response: 'accepted' })
      .expect(409);

    expect(response.body.detail).toContain('draft');
  });

  it('refuses two open offers on one application', async () => {
    const { applicationId } = await readyForOffer();
    await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 840000, joiningDate: futureDate(30) })
      .expect(201);

    const response = await harness
      .http()
      .post('/api/v1/offers')
      .set(auth(hr))
      .send({ applicationId, salaryAnnual: 900000, joiningDate: futureDate(30) })
      .expect(409);

    expect(response.body.detail).toContain('Revise it');
  });
});
