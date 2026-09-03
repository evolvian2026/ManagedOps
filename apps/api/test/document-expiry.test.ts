import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { OnboardingJobs } from '../src/jobs/onboarding-jobs.js';
import { DocumentsService } from '../src/modules/workforce/documents.service.js';
import { newId } from '../src/common/ids.js';

/**
 * Documents that lapse.
 *
 * The state worth most of the attention here is the one an absent date makes
 * easy to get wrong: a police verification filed without an expiry is a gap to
 * chase, not a document that is valid forever, and every path has to agree
 * about that — the queue, the reminder job and the checklist alike.
 */
let harness: Harness;
let hr: Session;
let manager: Session;
let lead: Session;
let trainer: Session;

let context: { trainerId: string; otherTrainerId: string; projectId: string };

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function buildWorld() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });
  const trainerUser = await harness.prisma.db.user.findFirst({ where: { role: 'trainer' } });
  const client = await harness.seedClient('Expiry Test Client');

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'Expiry Test Project',
      code: `EX-${Math.floor(Math.random() * 1_000_000)}`,
      clientId: client.id,
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      managerId: managerUser!.id,
      hrId: hrUser!.id,
      leadTrainerId: leadUser!.id,
    },
  });

  const makeTrainer = async (userId: string, allocation: number) => {
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId,
        employeeCode: `EX-${Math.floor(Math.random() * 1_000_000)}`,
        personalEmail: `expiry-${Math.random()}@example.com`,
        phone: '+919812345678',
        status: 'active',
        onboardingHrId: hrUser!.id,
      },
    });
    await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: record.id,
        projectId: project.id,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        allocationPercent: allocation,
      },
    });
    return record.id;
  };

  return {
    projectId: project.id,
    trainerId: await makeTrainer(trainerUser!.id, 50),
    otherTrainerId: await makeTrainer(leadUser!.id, 50),
  };
}

/** Files a document straight to the database, with whatever expiry is wanted. */
async function file(
  trainerId: string,
  docType: 'police_verification' | 'medical_certificate' | 'aadhaar',
  expiresOn: string | null,
) {
  return harness.prisma.db.trainerDocument.create({
    data: {
      id: newId(),
      trainerId,
      docType,
      status: 'verified',
      expiresOn: expiresOn ? new Date(`${expiresOn}T00:00:00.000Z`) : null,
    },
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

async function queue(query = '') {
  const response = await harness
    .http()
    .get(`/api/v1/trainers/documents/expiring${query}`)
    .set(auth(hr))
    .expect(200);
  return response.body;
}

describe('the queue of what is lapsing', () => {
  it('lists an expired document, a soon one and an undated one', async () => {
    await file(context.trainerId, 'police_verification', inDays(-10));
    await file(context.trainerId, 'medical_certificate', inDays(12));
    await file(context.otherTrainerId, 'police_verification', null);

    const body = await queue();
    const states = body.data.map((row: { validity: { state: string } }) => row.validity.state);
    expect(states).toContain('expired');
    expect(states).toContain('expiring_soon');
    expect(states).toContain('missing_date');
  });

  it('leaves out a document with plenty of time on it', async () => {
    await file(context.trainerId, 'police_verification', inDays(300));
    const body = await queue();
    expect(body.meta.total).toBe(0);
  });

  it('leaves out a document type that cannot expire', async () => {
    // A degree certificate does not stop being true, and a date typed against
    // one is noise rather than a thing to chase.
    await file(context.trainerId, 'aadhaar', inDays(-100));
    const body = await queue();
    expect(body.meta.total).toBe(0);
  });

  it('filters to one state at a time', async () => {
    await file(context.trainerId, 'police_verification', inDays(-10));
    await file(context.trainerId, 'medical_certificate', inDays(12));
    await file(context.otherTrainerId, 'police_verification', null);

    expect((await queue('?state=expired')).meta.total).toBe(1);
    expect((await queue('?state=expiring_soon')).meta.total).toBe(1);
    expect((await queue('?state=missing_date')).meta.total).toBe(1);
  });

  it('puts the soonest first, and the undated last', async () => {
    await file(context.trainerId, 'medical_certificate', inDays(20));
    await file(context.trainerId, 'police_verification', inDays(-30));
    await file(context.otherTrainerId, 'police_verification', null);

    const body = await queue();
    expect(body.data[0].validity.state).toBe('expired');
    expect(body.data.at(-1).validity.state).toBe('missing_date');
  });

  it('shows a trainer only their own', async () => {
    await file(context.trainerId, 'police_verification', inDays(-10));
    await file(context.otherTrainerId, 'police_verification', inDays(-10));

    const response = await harness
      .http()
      .get('/api/v1/trainers/documents/expiring')
      .set(auth(trainer))
      .expect(200);

    expect(response.body.meta.total).toBe(1);
    expect(response.body.data[0].trainer.id).toBe(context.trainerId);
  });

  it('withholds the file id from a manager, who oversees but does not verify', async () => {
    await file(context.trainerId, 'police_verification', inDays(-10));
    const fileObject = await harness.prisma.db.fileObject.create({
      data: {
        id: newId(),
        storageKey: `identity/${newId()}.pdf`,
        originalName: 'pv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    await harness.prisma.db.trainerDocument.updateMany({
      where: { trainerId: context.trainerId, docType: 'police_verification' },
      data: { fileId: fileObject.id },
    });

    const asManager = await harness
      .http()
      .get('/api/v1/trainers/documents/expiring')
      .set(auth(manager))
      .expect(200);
    // The same rule the checklist follows: seeing that it lapsed is not the
    // same question as being allowed to open it.
    expect(asManager.body.data[0].hasFile).toBe(true);
    expect(asManager.body.data[0].fileId).toBeNull();

    const asHr = await queue();
    expect(asHr.data[0].fileId).toBe(fileObject.id);
  });
});

describe('filing a document that lapses', () => {
  /**
   * Split in two on purpose. The upload half must stay synchronous so the
   * supertest object comes back unwrapped and `.expect` still chains off it;
   * an `async` helper returns a Promise, which has no `.expect`.
   */
  async function newFileId(): Promise<string> {
    const fileObject = await harness.prisma.db.fileObject.create({
      data: {
        id: newId(),
        storageKey: `identity/${newId()}.pdf`,
        originalName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedById: hr.user.id,
        confirmedAt: new Date(),
        scanStatus: 'skipped',
      },
    });
    return fileObject.id;
  }

  function upload(fileId: string, body: Record<string, unknown>) {
    return harness
      .http()
      .post(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(hr))
      .send({ fileId, ...body });
  }

  it('insists on an expiry date', async () => {
    // Filed without one it is indistinguishable from a current document until
    // somebody reads the certificate — usually the client.
    const response = await upload(await newFileId(), { docType: 'police_verification' }).expect(
      422,
    );
    expect(response.body.errors.some((e: { path: string }) => e.path === 'expiresOn')).toBe(true);

    await upload(await newFileId(), {
      docType: 'police_verification',
      expiresOn: inDays(365),
    }).expect(201);
  });

  it('refuses an expiry date on a document that cannot have one', async () => {
    await upload(await newFileId(), {
      docType: 'aadhaar',
      lastFour: '1234',
      expiresOn: inDays(365),
    }).expect(422);
  });

  it('restarts the reminder clock when a document is replaced', async () => {
    const document = await file(context.trainerId, 'police_verification', inDays(-5));
    await harness.prisma.db.trainerDocument.update({
      where: { id: document.id },
      data: { expiryReminderStage: 2, status: 'pending' },
    });

    await upload(await newFileId(), {
      docType: 'police_verification',
      expiresOn: inDays(365),
    }).expect(201);

    const renewed = await harness.prisma.db.trainerDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    // Leaving the stage where it was would mean the replacement never got
    // chased when its own expiry came round.
    expect(renewed.expiryReminderStage).toBe(0);
    expect(renewed.expiresOn).not.toBeNull();
  });

  it('carries the expiry and what it means onto the checklist', async () => {
    await upload(await newFileId(), {
      docType: 'medical_certificate',
      expiresOn: inDays(10),
    }).expect(201);

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(hr))
      .expect(200);

    const row = response.body.data.find(
      (entry: { docType: string }) => entry.docType === 'medical_certificate',
    );
    expect(row.expiresOn).toBe(inDays(10));
    expect(row.validity.state).toBe('expiring_soon');
    expect(row.validity.message).toMatch(/Expires in 10 days/);
  });

  it('does not make a lapsing document mandatory for onboarding', async () => {
    // Ongoing compliance, not a gate on somebody's first day: a police
    // verification takes weeks to come back and would block every joiner.
    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(hr))
      .expect(200);

    expect(response.body.progress.missing).not.toContain('police verification');
  });
});

describe('the reminder job', () => {
  function jobs() {
    return harness.app.get(OnboardingJobs);
  }

  it('warns a month out and does not repeat itself', async () => {
    await file(context.trainerId, 'police_verification', inDays(20));

    expect(await jobs().sendExpiryReminders()).toBe(1);
    // A daily job that sent this every day would teach people to ignore it.
    expect(await jobs().sendExpiryReminders()).toBe(0);
  });

  it('warns again once it has actually lapsed', async () => {
    const document = await file(context.trainerId, 'police_verification', inDays(20));
    await jobs().sendExpiryReminders();

    await harness.prisma.db.trainerDocument.update({
      where: { id: document.id },
      data: { expiresOn: new Date(`${inDays(-1)}T00:00:00.000Z`) },
    });

    // Stage 2 is owed even though stage 1 already went out.
    expect(await jobs().sendExpiryReminders()).toBe(1);
    expect(await jobs().sendExpiryReminders()).toBe(0);
  });

  it('tells HR once it has lapsed, and not before', async () => {
    const hrUserId = await harness.prisma.db.trainer
      .findUniqueOrThrow({ where: { id: context.trainerId }, select: { onboardingHrId: true } })
      .then((row) => row.onboardingHrId!);

    const document = await file(context.trainerId, 'police_verification', inDays(20));
    await jobs().sendExpiryReminders();

    const early = await harness.prisma.db.notification.count({
      where: { userId: hrUserId, type: 'document_expiry_escalation' },
    });
    // Escalating a month early would train HR to ignore the one that matters.
    expect(early).toBe(0);

    await harness.prisma.db.trainerDocument.update({
      where: { id: document.id },
      data: { expiresOn: new Date(`${inDays(-1)}T00:00:00.000Z`) },
    });
    await jobs().sendExpiryReminders();

    const late = await harness.prisma.db.notification.count({
      where: { userId: hrUserId, type: 'document_expiry_escalation' },
    });
    expect(late).toBe(1);
  });

  it('leaves alone a document with plenty of time on it', async () => {
    await file(context.trainerId, 'police_verification', inDays(300));
    expect(await jobs().sendExpiryReminders()).toBe(0);
  });

  it('does not chase somebody who has left', async () => {
    await file(context.trainerId, 'police_verification', inDays(-5));
    await harness.prisma.db.trainer.update({
      where: { id: context.trainerId },
      data: { status: 'deboarded' },
    });
    expect(await jobs().sendExpiryReminders()).toBe(0);
  });

  it('chases a replacement in its own turn', async () => {
    const documents = harness.app.get(DocumentsService);
    const document = await file(context.trainerId, 'police_verification', inDays(-5));
    await jobs().sendExpiryReminders();

    // Renewed, then the new one nears its own expiry.
    await documents.markExpiryReminderSent(document.id, 0);
    await harness.prisma.db.trainerDocument.update({
      where: { id: document.id },
      data: { expiresOn: new Date(`${inDays(15)}T00:00:00.000Z`) },
    });

    expect(await jobs().sendExpiryReminders()).toBe(1);
  });
});

describe('who may read the queue', () => {
  it('is open to everyone who may read a trainer', async () => {
    await file(context.trainerId, 'police_verification', inDays(-1));
    for (const session of [manager, hr, lead, trainer]) {
      await harness
        .http()
        .get('/api/v1/trainers/documents/expiring')
        .set(auth(session))
        .expect(200);
    }
  });

  it('is not parsed as a trainer id', async () => {
    // "documents/expiring" sits before ":id" in the controller; getting that
    // wrong turns the whole queue into a 422 on a malformed uuid.
    const response = await harness
      .http()
      .get('/api/v1/trainers/documents/expiring')
      .set(auth(hr))
      .expect(200);
    expect(response.body).toHaveProperty('meta');
  });
});
