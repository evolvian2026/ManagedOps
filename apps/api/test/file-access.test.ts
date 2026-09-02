import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * Who may open a stored file.
 *
 * This suite exists because of a real hole: `GET /files/:id/download-url`
 * authorised nothing beyond "is signed in", and the document checklist handed
 * every file id to anybody who could read the trainer's row. A Project Lead —
 * deliberately denied `trainers.read_documents` — could therefore read a
 * colleague's Aadhaar scan by using an id the API had just given them.
 *
 * Both halves are covered here: the ids are no longer handed out, and the
 * download endpoint refuses even when an id is known.
 */
let harness: Harness;
let hr: Session;
let manager: Session;
let lead: Session;
let trainer: Session;
let interviewer: Session;

let context: {
  trainerId: string;
  trainerUserId: string;
  leadTrainerId: string;
  assignmentId: string;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

async function storedFile(options: {
  uploadedById: string;
  ownerType?: string;
  ownerId?: string;
}): Promise<string> {
  const id = newId();
  await harness.prisma.db.fileObject.create({
    data: {
      id,
      storageKey: `secure/${id}/scan.pdf`,
      originalName: 'scan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      uploadedById: options.uploadedById,
      ownerType: options.ownerType ?? null,
      ownerId: options.ownerId ?? null,
      confirmedAt: new Date(),
      scanStatus: 'skipped',
    },
  });
  return id;
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
  const interviewerUser = await harness.seedUser({ role: 'interviewer' });

  hr = await harness.signIn(hrUser.email);
  manager = await harness.signIn(managerUser.email);
  interviewer = await harness.signIn(interviewerUser.email);

  const project = await harness.prisma.db.project.create({
    data: {
      id: newId(),
      name: 'File Access Project',
      code: `FA-${Math.floor(Math.random() * 1_000_000)}`,
      clientName: 'Client',
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: 'active',
      managerId: managerUser.id,
      hrId: hrUser.id,
      leadTrainerId: leadUser.id,
    },
  });

  const make = async (userId: string, code: string, role: 'lead' | 'trainer') => {
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId,
        employeeCode: code,
        personalEmail: `${code.toLowerCase()}@example.com`,
        phone: '+919812345678',
        status: 'active',
      },
    });
    const assignment = await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: record.id,
        projectId: project.id,
        role,
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
      },
    });
    return { trainerId: record.id, assignmentId: assignment.id };
  };

  const leadRecord = await make(leadUser.id, `FA-L-${Date.now() % 100000}`, 'lead');
  const trainerRecord = await make(trainerUser.id, `FA-T-${Date.now() % 100000}`, 'trainer');

  context = {
    trainerId: trainerRecord.trainerId,
    trainerUserId: trainerUser.id,
    leadTrainerId: leadRecord.trainerId,
    assignmentId: trainerRecord.assignmentId,
  };

  lead = await harness.signIn(leadUser.email);
  trainer = await harness.signIn(trainerUser.email);
});

/** Uploads an Aadhaar for the plain trainer and returns the document row. */
async function uploadAadhaar() {
  const fileId = await storedFile({ uploadedById: context.trainerUserId });
  await harness
    .http()
    .post(`/api/v1/trainers/${context.trainerId}/documents`)
    .set(auth(trainer))
    .send({ docType: 'aadhaar', fileId, lastFour: '4821' })
    .expect(201);
  return fileId;
}

describe('the document checklist', () => {
  it('gives the trainer their own file id', async () => {
    await uploadAadhaar();

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(trainer))
      .expect(200);

    const aadhaar = (response.body.data as { docType: string; fileId: string | null }[]).find(
      (row) => row.docType === 'aadhaar',
    );
    expect(aadhaar?.fileId).not.toBeNull();
  });

  it('gives HR the file id, because verifying it means opening it', async () => {
    await uploadAadhaar();

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(hr))
      .expect(200);

    const aadhaar = (response.body.data as { docType: string; fileId: string | null }[]).find(
      (row) => row.docType === 'aadhaar',
    );
    expect(aadhaar?.fileId).not.toBeNull();
  });

  it('withholds the file id from a lead while still saying a document exists', async () => {
    await uploadAadhaar();

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(lead))
      .expect(200);

    const aadhaar = (
      response.body.data as { docType: string; fileId: string | null; hasFile: boolean }[]
    ).find((row) => row.docType === 'aadhaar');

    // They can see the checklist is progressing; they cannot open the scan.
    expect(aadhaar?.hasFile).toBe(true);
    expect(aadhaar?.fileId).toBeNull();
  });

  it('withholds it from a manager too, who oversees but does not verify', async () => {
    await uploadAadhaar();

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.trainerId}/documents`)
      .set(auth(manager))
      .expect(200);

    const aadhaar = (
      response.body.data as { docType: string; fileId: string | null; hasFile: boolean }[]
    ).find((row) => row.docType === 'aadhaar');
    expect(aadhaar?.hasFile).toBe(true);
    expect(aadhaar?.fileId).toBeNull();
  });
});

describe('downloading a file', () => {
  it('refuses a lead who has somehow learned the id', async () => {
    const fileId = await uploadAadhaar();

    // An unguessable id is not authorisation, so the endpoint checks anyway.
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(lead)).expect(403);
  });

  it('refuses an interviewer entirely', async () => {
    const fileId = await uploadAadhaar();
    await harness
      .http()
      .get(`/api/v1/files/${fileId}/download-url`)
      .set(auth(interviewer))
      .expect(403);
  });

  it('lets the trainer open their own document', async () => {
    const fileId = await uploadAadhaar();
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(trainer)).expect(200);
  });

  it('lets HR open it, and records that they did', async () => {
    const fileId = await uploadAadhaar();
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(hr)).expect(200);

    const audited = await harness.prisma.db.auditLog.findFirst({
      where: { action: 'FILE_DOWNLOADED', actorUserId: hr.user.id },
    });
    expect(audited).not.toBeNull();
  });

  it('refuses one trainer another trainer’s document', async () => {
    const otherUser = await harness.seedUser({ role: 'trainer' });
    const other = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId: otherUser.id,
        employeeCode: `FA-O-${Date.now() % 100000}`,
        personalEmail: otherUser.email,
        phone: '+919812345679',
        status: 'active',
      },
    });
    const otherSession = await harness.signIn(otherUser.email);

    const fileId = await storedFile({
      uploadedById: context.trainerUserId,
      ownerType: 'Trainer',
      ownerId: context.trainerId,
    });

    await harness
      .http()
      .get(`/api/v1/files/${fileId}/download-url`)
      .set(auth(otherSession))
      .expect(403);

    expect(other.id).not.toBe(context.trainerId);
  });

  it('lets whoever uploaded it read it back, before it is attached to anything', async () => {
    const fileId = await storedFile({ uploadedById: hr.user.id });
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(hr)).expect(200);

    // Nobody else, though — an unattached file has no record to reason about.
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(manager)).expect(403);
  });

  it('refuses an owner type nothing has taught it to authorise', async () => {
    const fileId = await storedFile({
      uploadedById: context.trainerUserId,
      ownerType: 'SomethingNew',
      ownerId: newId(),
    });

    // A new attachment kind has to say who may read it; the default is no.
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).set(auth(hr)).expect(403);
  });

  it('still refuses an anonymous caller', async () => {
    const fileId = await uploadAadhaar();
    await harness.http().get(`/api/v1/files/${fileId}/download-url`).expect(401);
  });
});

describe('a reimbursement receipt', () => {
  async function submitClaim() {
    const proofFileId = await storedFile({ uploadedById: context.trainerUserId });
    const claim = await harness
      .http()
      .post('/api/v1/reimbursements')
      .set(auth(trainer))
      .send({
        category: 'travel',
        amount: 2400,
        description: 'Cab to the client campus.',
        proofFileId,
      })
      .expect(201);
    return { proofFileId, claimId: claim.body.id as string };
  }

  it('is readable by the claimant and by an approver', async () => {
    const { proofFileId } = await submitClaim();

    await harness
      .http()
      .get(`/api/v1/files/${proofFileId}/download-url`)
      .set(auth(trainer))
      .expect(200);
    await harness.http().get(`/api/v1/files/${proofFileId}/download-url`).set(auth(hr)).expect(200);
  });

  it('is not readable by a lead, who does not approve claims', async () => {
    const { proofFileId } = await submitClaim();
    await harness
      .http()
      .get(`/api/v1/files/${proofFileId}/download-url`)
      .set(auth(lead))
      .expect(403);
  });
});
