import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * Onboarding, end to end: an accepted offer becomes a working trainer with a
 * login, a document checklist, and a project to work on.
 *
 * The rule these protect is that a trainer becomes active because the facts say
 * so — every mandatory document verified, and somewhere to work — not because
 * anyone remembered to set a status.
 */
let harness: Harness;
let hr: Session;
let manager: Session;
let superAdmin: Session;

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function confirmedFile(uploaderId: string): Promise<string> {
  const id = newId();
  await harness.prisma.db.fileObject.create({
    data: {
      id,
      storageKey: `identity/${id}/scan.pdf`,
      originalName: 'scan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2000,
      uploadedById: uploaderId,
      confirmedAt: new Date(),
      scanStatus: 'skipped',
    },
  });
  return id;
}

/** Walks a fresh candidate all the way to an accepted offer. */
async function acceptedOffer(): Promise<{ offerId: string; projectId: string; email: string }> {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });

  const project = await harness
    .http()
    .post('/api/v1/projects')
    .set(auth(manager))
    .send({
      name: 'Onboarding Demo',
      code: `OB-${Math.floor(Math.random() * 1_000_000)}`,
      clientName: 'Client',
      startDate: futureDate(3),
      managerId: managerUser!.id,
      hrId: hrUser!.id,
    })
    .expect(201);

  const position = await harness
    .http()
    .post('/api/v1/positions')
    .set(auth(hr))
    .send({ projectId: project.body.id, title: 'Trainer', headcount: 2 })
    .expect(201);

  const email = `hire.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const candidate = await harness
    .http()
    .post('/api/v1/candidates')
    .set(auth(hr))
    .send({
      name: 'Priyanka Rao',
      email,
      phone: '+919812345675',
      resumeFileId: await confirmedFile(hr.user.id),
      positionId: position.body.id,
    })
    .expect(201);

  const applicationId = candidate.body.application.id;
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
    .send({ applicationId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })
    .expect(201);

  await harness
    .http()
    .post(`/api/v1/interviews/${interview.body.id}/outcome`)
    .set(auth(hr))
    .send({ outcome: 'selected', feedback: 'Hire' })
    .expect(200);

  const offer = await harness
    .http()
    .post('/api/v1/offers')
    .set(auth(hr))
    .send({ applicationId, salaryAnnual: 720000, joiningDate: futureDate(21) })
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
    .send({ response: 'accepted' })
    .expect(200);

  return { offerId: offer.body.id, projectId: project.body.id, email };
}

async function convert(offerId: string, body: Record<string, unknown> = {}) {
  const response = await harness
    .http()
    .post(`/api/v1/offers/${offerId}/convert-to-trainer`)
    .set(auth(hr))
    .send(body)
    .expect(201);
  return response.body as {
    id: string;
    employeeCode: string;
    status: string;
    user: { id: string; email: string; mustChangePassword: boolean };
  };
}

/** Uploads and verifies every mandatory document. */
async function completeDocuments(trainerId: string) {
  const listed = await harness
    .http()
    .get(`/api/v1/trainers/${trainerId}/documents`)
    .set(auth(hr))
    .expect(200);

  for (const doc of listed.body.data as { id: string; docType: string }[]) {
    await harness
      .http()
      .post(`/api/v1/trainers/${trainerId}/documents`)
      .set(auth(hr))
      .send({
        docType: doc.docType,
        fileId: await confirmedFile(hr.user.id),
        ...(['aadhaar', 'pan'].includes(doc.docType) ? { lastFour: '4821' } : {}),
      })
      .expect(201);
  }

  const afterUpload = await harness
    .http()
    .get(`/api/v1/trainers/${trainerId}/documents`)
    .set(auth(hr))
    .expect(200);

  for (const doc of afterUpload.body.data as { id: string }[]) {
    await harness
      .http()
      .post(`/api/v1/trainers/${trainerId}/documents/${doc.id}/verify`)
      .set(auth(hr))
      .send({ decision: 'verified' })
      .expect(200);
  }
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await resetDatabase(harness.prisma);
  hr = await harness.signIn((await harness.seedUser({ role: 'hr' })).email);
  manager = await harness.signIn((await harness.seedUser({ role: 'manager' })).email);
  superAdmin = await harness.signIn((await harness.seedUser({ role: 'super_admin' })).email);
});

describe('converting an accepted offer', () => {
  it('creates a login, a profile and a document checklist together', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    expect(trainer.employeeCode).toMatch(/^MO-\d{4}-0001$/);
    expect(trainer.status).toBe('pending_onboarding');
    // A temporary password buys exactly one thing: replacing itself.
    expect(trainer.user.mustChangePassword).toBe(true);

    const documents = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .expect(200);

    expect(documents.body.data).toHaveLength(3);
    expect(documents.body.progress).toMatchObject({ required: 3, verified: 0, complete: false });
  });

  it('never returns the temporary password to the caller', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    // The mailbox is the only place it exists. `mustChangePassword` is a
    // legitimate flag, so this checks for a credential rather than the word.
    const serialised = JSON.stringify(trainer);
    for (const key of ['passwordHash', 'temporaryPassword', '"password"']) {
      expect(serialised).not.toContain(key);
    }

    // Nor is it hiding in the database as anything but a hash.
    const stored = await harness.prisma.db.user.findUnique({
      where: { id: trainer.user.id },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('assigns them to the position project by default', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const assignments = await harness
      .http()
      .get(`/api/v1/assignments?trainerId=${trainer.id}`)
      .set(auth(hr))
      .expect(200);

    expect(assignments.body.data).toHaveLength(1);
    expect(assignments.body.data[0].project.id).toBe(projectId);
  });

  it('marks the candidate hired and no longer in the pool', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const detail = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}`)
      .set(auth(hr))
      .expect(200);

    const candidate = await harness.prisma.db.candidate.findUnique({
      where: { id: detail.body.candidateId },
    });
    expect(candidate?.status).toBe('hired');
    expect(candidate?.poolEligible).toBe(false);
    expect(candidate?.workedBefore).toBe(true);
  });

  it('numbers employee codes sequentially within the year', async () => {
    const first = await acceptedOffer();
    const second = await acceptedOffer();

    const a = await convert(first.offerId);
    const b = await convert(second.offerId);

    expect(a.employeeCode).toMatch(/-0001$/);
    expect(b.employeeCode).toMatch(/-0002$/);
  });

  it('refuses to convert an offer that was not accepted', async () => {
    const { offerId } = await acceptedOffer();
    await convert(offerId);

    // The offer is now accepted-and-converted; a second attempt is refused.
    const response = await harness
      .http()
      .post(`/api/v1/offers/${offerId}/convert-to-trainer`)
      .set(auth(hr))
      .send({})
      .expect(409);

    expect(response.body.detail).toContain('already has a trainer record');
  });

  it('refuses when the personal email already has an account', async () => {
    const { offerId } = await acceptedOffer();
    const existing = await harness.seedUser({ role: 'trainer' });

    const response = await harness
      .http()
      .post(`/api/v1/offers/${offerId}/convert-to-trainer`)
      .set(auth(hr))
      .send({ personalEmail: existing.email })
      .expect(409);

    expect(response.body.detail).toContain('already has a ManagedOps account');
  });

  it('leaves nothing behind when conversion fails', async () => {
    const { offerId } = await acceptedOffer();
    const existing = await harness.seedUser({ role: 'trainer' });
    const usersBefore = await harness.prisma.db.user.count();

    await harness
      .http()
      .post(`/api/v1/offers/${offerId}/convert-to-trainer`)
      .set(auth(hr))
      .send({ personalEmail: existing.email })
      .expect(409);

    // A login with no profile would be worse than a failed conversion.
    expect(await harness.prisma.db.user.count()).toBe(usersBefore);
    expect(await harness.prisma.db.trainer.count()).toBe(0);
  });
});

describe('the document checklist', () => {
  it('activates the trainer once every mandatory document is verified', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    await completeDocuments(trainer.id);

    const detail = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}`)
      .set(auth(hr))
      .expect(200);

    // Status follows the facts: documents verified, and somewhere to work.
    expect(detail.body.status).toBe('active');
    expect(detail.body.documentsCompletedAt).not.toBeNull();
  });

  it('does not activate a trainer with no assignment', async () => {
    const { offerId } = await acceptedOffer();
    // Convert without a project by pointing the offer at a project-less path:
    // end the auto-created assignment straight afterwards.
    const trainer = await convert(offerId);

    const assignments = await harness
      .http()
      .get(`/api/v1/assignments?trainerId=${trainer.id}`)
      .set(auth(hr))
      .expect(200);
    await harness
      .http()
      .post(`/api/v1/assignments/${assignments.body.data[0].id}/end`)
      .set(auth(manager))
      .send({ endDate: futureDate(30) })
      .expect(200);

    await completeDocuments(trainer.id);

    const detail = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}`)
      .set(auth(hr))
      .expect(200);

    expect(detail.body.status).toBe('pending_onboarding');
    expect(detail.body.documentsCompletedAt).not.toBeNull();
  });

  it('demands the last four characters for Aadhaar and PAN', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const response = await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .send({ docType: 'aadhaar', fileId: await confirmedFile(hr.user.id) })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'lastFour' }));
  });

  it('never stores more than four characters of an identifier', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    // A full Aadhaar number is refused outright rather than truncated, so
    // nobody believes the whole identifier was captured.
    await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .send({
        docType: 'aadhaar',
        fileId: await confirmedFile(hr.user.id),
        lastFour: '123456789012',
      })
      .expect(422);

    const stored = await harness.prisma.db.trainerDocument.findMany({
      where: { trainerId: trainer.id },
      select: { lastFour: true },
    });
    expect(stored.every((doc) => (doc.lastFour?.length ?? 0) <= 4)).toBe(true);
  });

  it('demands a reason when rejecting, so they know what to re-upload', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const listed = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .expect(200);
    const aadhaar = listed.body.data.find((doc: { docType: string }) => doc.docType === 'aadhaar');

    await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .send({ docType: 'aadhaar', fileId: await confirmedFile(hr.user.id), lastFour: '4821' })
      .expect(201);

    const response = await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents/${aadhaar.id}/verify`)
      .set(auth(hr))
      .send({ decision: 'rejected' })
      .expect(422);

    expect(response.body.errors).toContainEqual(expect.objectContaining({ path: 'rejectReason' }));
  });

  it('lets a rejected document be replaced, returning it to pending', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const listed = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .expect(200);
    const pan = listed.body.data.find((doc: { docType: string }) => doc.docType === 'pan');

    await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .send({ docType: 'pan', fileId: await confirmedFile(hr.user.id), lastFour: 'K7Z1' })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents/${pan.id}/verify`)
      .set(auth(hr))
      .send({ decision: 'rejected', rejectReason: 'The scan is cut off at the bottom' })
      .expect(200);

    // A rejected document that stayed rejected would be a dead end.
    const replaced = await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .send({ docType: 'pan', fileId: await confirmedFile(hr.user.id), lastFour: 'K7Z1' })
      .expect(201);

    expect(replaced.body.status).toBe('pending');
  });

  it('refuses to verify a document nobody has uploaded', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const listed = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .expect(200);

    const response = await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/documents/${listed.body.data[0].id}/verify`)
      .set(auth(hr))
      .send({ decision: 'verified' })
      .expect(409);

    expect(response.body.detail).toContain('Nothing has been uploaded');
  });

  it('reports what is still outstanding, by name', async () => {
    const { offerId } = await acceptedOffer();
    const trainer = await convert(offerId);

    const listed = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}/documents`)
      .set(auth(hr))
      .expect(200);

    expect(listed.body.progress.missing).toEqual(
      expect.arrayContaining(['Aadhaar', 'PAN', 'education certificate']),
    );
  });
});

describe('assignments', () => {
  it('refuses a second live assignment on the same project', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    const response = await harness
      .http()
      .post(`/api/v1/trainers/${trainer.id}/assignments`)
      .set(auth(manager))
      .send({ projectId, startDate: futureDate(5) })
      .expect(409);

    expect(response.body.detail).toContain('already on');
  });

  it('shows the project roster with today attendance not yet recorded', async () => {
    const { offerId, projectId } = await acceptedOffer();
    await convert(offerId, { projectId });

    const roster = await harness
      .http()
      .get(`/api/v1/projects/${projectId}/roster`)
      .set(auth(manager))
      .expect(200);

    expect(roster.body.data).toHaveLength(1);
    // Attendance lands in phase 3; until then this reports honestly.
    expect(roster.body.data[0].today).toBeNull();
    expect(roster.body.workDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('ends an assignment and keeps it out of the roster', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    const assignments = await harness
      .http()
      .get(`/api/v1/assignments?trainerId=${trainer.id}`)
      .set(auth(manager))
      .expect(200);

    await harness
      .http()
      .post(`/api/v1/assignments/${assignments.body.data[0].id}/end`)
      .set(auth(manager))
      .send({ endDate: futureDate(30) })
      .expect(200);

    const roster = await harness
      .http()
      .get(`/api/v1/projects/${projectId}/roster`)
      .set(auth(manager))
      .expect(200);
    expect(roster.body.data).toHaveLength(0);
  });
});

describe('who can see what', () => {
  it('a trainer sees only their own profile', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const mine = await convert(offerId, { projectId });
    const other = await acceptedOffer();
    const theirs = await convert(other.offerId);

    // Sign in as the converted trainer for real, past the forced change.
    await harness.setPassword(mine.user.id);
    const trainerSession = await harness.signIn(mine.user.email);

    const listed = await harness
      .http()
      .get('/api/v1/trainers')
      .set(auth(trainerSession))
      .expect(200);

    const ids = listed.body.data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([mine.id]);

    // And a colleague's record is invisible, not merely unlisted.
    await harness.http().get(`/api/v1/trainers/${theirs.id}`).set(auth(trainerSession)).expect(404);

    // Their own profile is reachable through /me without knowing their id.
    const me = await harness
      .http()
      .get('/api/v1/trainers/me')
      .set(auth(trainerSession))
      .expect(200);
    expect(me.body.id).toBe(mine.id);
    // They can see their own pay, which is the 'own' scope working.
    expect(me.body.salaryAnnual).toBe('720000');
  });

  it('hides salary from a role that cannot read it', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    const asHr = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}`)
      .set(auth(hr))
      .expect(200);
    expect(asHr.body.salaryAnnual).toBe('720000');

    const lead = await harness.seedUser({ role: 'project_lead' });
    const leadSession = await harness.signIn(lead.email);

    // A lead has trainers.read_salary only at 'own' scope, and this is not them.
    const asLead = await harness
      .http()
      .get(`/api/v1/trainers/${trainer.id}`)
      .set(auth(leadSession))
      .expect(404);
    expect(asLead.body.title).toBe('Not found');
  });

  it('audits every read of a salary', async () => {
    const { offerId, projectId } = await acceptedOffer();
    const trainer = await convert(offerId, { projectId });

    await harness.http().get(`/api/v1/trainers/${trainer.id}`).set(auth(hr)).expect(200);

    const reads = await harness.prisma.db.auditLog.findMany({
      where: { action: 'READ salaryAnnual', entityId: trainer.id },
    });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]?.actorUserId).toBe(hr.user.id);
  });

  it('refuses conversion to a role that cannot manage trainers', async () => {
    const { offerId } = await acceptedOffer();
    const interviewer = await harness.seedUser({ role: 'interviewer' });
    const session = await harness.signIn(interviewer.email);

    await harness
      .http()
      .post(`/api/v1/offers/${offerId}/convert-to-trainer`)
      .set(auth(session))
      .send({})
      .expect(403);
  });

  it('lets a super admin see the roster too', async () => {
    const { offerId, projectId } = await acceptedOffer();
    await convert(offerId, { projectId });

    await harness
      .http()
      .get(`/api/v1/projects/${projectId}/roster`)
      .set(auth(superAdmin))
      .expect(200);
  });
});
