import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * Layer three of the permission model: which *rows* a caller may see.
 *
 * A guard has already decided they may call the endpoint. These tests prove the
 * data layer then narrows the result to their scope — an interviewer sees the
 * interviews they are named on and nothing else, a project lead sees their own
 * project and nothing else. Hiding a link in the UI is not a control; this is.
 */
let harness: Harness;

let hr: Session;
let manager: Session;
let interviewerA: Session;
let interviewerB: Session;
let leadA: Session;
let leadB: Session;

interface Fixture {
  projectAId: string;
  projectBId: string;
  positionAId: string;
  positionBId: string;
  interviewAId: string;
  interviewBId: string;
  candidateAId: string;
  candidateBId: string;
}

let fixture: Fixture;

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
      storageKey: `resumes/${id}/cv.pdf`,
      originalName: 'cv.pdf',
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
 * Two parallel projects, each with its own lead, position, candidate and an
 * interview assigned to a different interviewer. Everything below asks whether
 * one side can see the other.
 */
async function buildTwoProjects(leadAUserId: string, leadBUserId: string): Promise<Fixture> {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });

  const makeProject = async (code: string, leadUserId: string) => {
    const response = await harness
      .http()
      .post('/api/v1/projects')
      .set(auth(manager))
      .send({
        name: `Project ${code}`,
        code,
        clientName: 'Client',
        startDate: futureDate(7),
        managerId: managerUser!.id,
        hrId: hrUser!.id,
        leadTrainerId: leadUserId,
      })
      .expect(201);
    return response.body.id as string;
  };

  const makePosition = async (projectId: string) => {
    const response = await harness
      .http()
      .post('/api/v1/positions')
      .set(auth(hr))
      .send({ projectId, title: 'Trainer', headcount: 1 })
      .expect(201);
    return response.body.id as string;
  };

  const makeInterview = async (positionId: string, interviewerId: string, suffix: string) => {
    const resumeFileId = await confirmedFile(hr.user.id);
    const candidate = await harness
      .http()
      .post('/api/v1/candidates')
      .set(auth(hr))
      .send({
        name: `Candidate ${suffix}`,
        email: `candidate.${suffix}.${Date.now()}@example.com`,
        phone: '+919812345671',
        resumeFileId,
        positionId,
      })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/applications/${candidate.body.application.id}/screen`)
      .set(auth(hr))
      .send({ outcome: 'proceed' })
      .expect(200);

    const interview = await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(hr))
      .send({
        applicationId: candidate.body.application.id,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId,
      })
      .expect(201);

    return { interviewId: interview.body.id as string, candidateId: candidate.body.id as string };
  };

  const projectAId = await makeProject('SCOPE-A', leadAUserId);
  const projectBId = await makeProject('SCOPE-B', leadBUserId);
  const positionAId = await makePosition(projectAId);
  const positionBId = await makePosition(projectBId);
  const a = await makeInterview(positionAId, interviewerA.user.id, 'a');
  const b = await makeInterview(positionBId, interviewerB.user.id, 'b');

  return {
    projectAId,
    projectBId,
    positionAId,
    positionBId,
    interviewAId: a.interviewId,
    interviewBId: b.interviewId,
    candidateAId: a.candidateId,
    candidateBId: b.candidateId,
  };
}

beforeAll(async () => {
  harness = await createHarness();
  await resetDatabase(harness.prisma);

  const hrUser = await harness.seedUser({ role: 'hr' });
  const managerUser = await harness.seedUser({ role: 'manager' });
  const interviewerAUser = await harness.seedUser({ role: 'interviewer' });
  const interviewerBUser = await harness.seedUser({ role: 'interviewer' });
  const leadAUser = await harness.seedUser({ role: 'project_lead' });
  const leadBUser = await harness.seedUser({ role: 'project_lead' });

  hr = await harness.signIn(hrUser.email);
  manager = await harness.signIn(managerUser.email);
  interviewerA = await harness.signIn(interviewerAUser.email);
  interviewerB = await harness.signIn(interviewerBUser.email);

  // The projects are built first, naming each lead, because a project_lead's
  // scope travels in their access token — signing in earlier would issue a
  // token with an empty ledProjectIds and every scoped read would see nothing.
  fixture = await buildTwoProjects(leadAUser.id, leadBUser.id);

  leadA = await harness.signIn(leadAUser.email);
  leadB = await harness.signIn(leadBUser.email);
});

afterAll(async () => {
  // Guarded: if beforeAll failed to boot the app, this would otherwise throw a
  // second, misleading error on top of the real one.
  await harness?.close();
});

describe('an interviewer sees only what they were assigned', () => {
  it('lists their own interview and no one else', async () => {
    const response = await harness
      .http()
      .get('/api/v1/interviews')
      .set(auth(interviewerA))
      .expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(fixture.interviewAId);
    expect(ids).not.toContain(fixture.interviewBId);
  });

  it('cannot fetch a colleague interview even by its exact id', async () => {
    // The scope predicate makes it invisible, so this is a 404, not a 403 —
    // the record does not exist as far as this caller is concerned.
    await harness
      .http()
      .get(`/api/v1/interviews/${fixture.interviewBId}`)
      .set(auth(interviewerB))
      .expect(200);

    await harness
      .http()
      .get(`/api/v1/interviews/${fixture.interviewBId}`)
      .set(auth(interviewerA))
      .expect(404);
  });

  it('sees only the candidate behind their own interview', async () => {
    const response = await harness
      .http()
      .get('/api/v1/candidates')
      .set(auth(interviewerA))
      .expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(fixture.candidateAId);
    expect(ids).not.toContain(fixture.candidateBId);
  });

  it('cannot reach offers at all — they carry salary', async () => {
    await harness.http().get('/api/v1/offers').set(auth(interviewerA)).expect(403);
  });

  it('cannot reach projects or positions', async () => {
    await harness.http().get('/api/v1/projects').set(auth(interviewerA)).expect(403);
    await harness.http().get('/api/v1/positions').set(auth(interviewerA)).expect(403);
  });

  it('cannot schedule an interview, only record what happened at one', async () => {
    await harness
      .http()
      .post('/api/v1/interviews')
      .set(auth(interviewerA))
      .send({
        applicationId: newId(),
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(403);
  });

  it('can record the outcome of their own interview', async () => {
    const response = await harness
      .http()
      .post(`/api/v1/interviews/${fixture.interviewAId}/outcome`)
      .set(auth(interviewerA))
      .send({ outcome: 'selected', feedback: 'Strong candidate' })
      .expect(200);

    expect(response.body.outcome).toBe('selected');
  });

  it('cannot record the outcome of an interview assigned to someone else', async () => {
    await harness
      .http()
      .post(`/api/v1/interviews/${fixture.interviewBId}/outcome`)
      .set(auth(interviewerA))
      .send({ outcome: 'selected', feedback: 'Not mine to judge' })
      .expect(404);
  });
});

describe('a project lead sees only their own project', () => {
  it('lists their project and not the other one', async () => {
    const response = await harness.http().get('/api/v1/projects').set(auth(leadA)).expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([fixture.projectAId]);
  });

  it('cannot fetch the other project by id', async () => {
    await harness.http().get(`/api/v1/projects/${fixture.projectAId}`).set(auth(leadA)).expect(200);
    await harness.http().get(`/api/v1/projects/${fixture.projectBId}`).set(auth(leadA)).expect(404);
  });

  it('scopes the other lead to their own project, the other way round', async () => {
    // Asserting only lead A would pass just as happily against a scope that
    // always returned project A. The symmetric case is what makes the pair
    // mean anything.
    const response = await harness.http().get('/api/v1/projects').set(auth(leadB)).expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([fixture.projectBId]);

    await harness.http().get(`/api/v1/projects/${fixture.projectBId}`).set(auth(leadB)).expect(200);
    await harness.http().get(`/api/v1/projects/${fixture.projectAId}`).set(auth(leadB)).expect(404);
  });

  it('sees only the positions on their project', async () => {
    const response = await harness.http().get('/api/v1/positions').set(auth(leadA)).expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(fixture.positionAId);
    expect(ids).not.toContain(fixture.positionBId);
  });

  it('cannot create or change a project', async () => {
    await harness
      .http()
      .post('/api/v1/projects')
      .set(auth(leadA))
      .send({
        name: 'Not Allowed',
        code: 'NOPE-1',
        clientName: 'Client',
        startDate: futureDate(7),
        managerId: manager.user.id,
        hrId: hr.user.id,
      })
      .expect(403);

    await harness
      .http()
      .patch(`/api/v1/projects/${fixture.projectAId}`)
      .set(auth(leadA))
      .send({ name: 'Renamed' })
      .expect(403);
  });

  it('cannot open a position, even on their own project', async () => {
    // Leads oversee delivery; staffing decisions belong to a manager or HR.
    await harness
      .http()
      .post('/api/v1/positions')
      .set(auth(leadA))
      .send({ projectId: fixture.projectAId, title: 'Sneaky', headcount: 1 })
      .expect(403);
  });

  it('cannot reach candidates or offers', async () => {
    await harness.http().get('/api/v1/candidates').set(auth(leadA)).expect(403);
    await harness.http().get('/api/v1/offers').set(auth(leadA)).expect(403);
  });
});

/**
 * A scope must be a floor that no request parameter can raise.
 *
 * Both directions of this were live bugs: a scope predicate spread into the same
 * object as an explicit `id` overwrote it (so fetching someone else's project
 * silently returned your own with a 200), and a query parameter spread after the
 * scope overwrote *that* (so `?projectId=` read straight past it).
 */
describe('a filter cannot override the caller scope', () => {
  it('a lead asking for another project by id gets nothing, not their own', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/projects/${fixture.projectBId}`)
      .set(auth(leadA))
      .expect(404);

    expect(response.body.title).toBe('Not found');
  });

  it('a lead cannot read another project positions through ?projectId', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/positions?projectId=${fixture.projectBId}`)
      .set(auth(leadA))
      .expect(200);

    expect(response.body.data).toHaveLength(0);
  });

  it('an interviewer cannot read another interviewer queue through ?interviewerId', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/interviews?interviewerId=${interviewerB.user.id}`)
      .set(auth(interviewerA))
      .expect(200);

    expect(response.body.data).toHaveLength(0);
  });

  it('an interviewer cannot widen their candidate list through a search term', async () => {
    const response = await harness
      .http()
      .get('/api/v1/candidates?q=Candidate')
      .set(auth(interviewerA))
      .expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([fixture.candidateAId]);
  });

  it('a lead cannot reach another project applications through ?projectId', async () => {
    // Applications are HR-only, so this is refused before scope even applies.
    await harness
      .http()
      .get(`/api/v1/applications?projectId=${fixture.projectBId}`)
      .set(auth(leadA))
      .expect(403);
  });
});

describe('an organisation-wide role sees everything', () => {
  it('HR sees both projects, both positions and both candidates', async () => {
    const [projects, positions, candidates] = await Promise.all([
      harness.http().get('/api/v1/projects').set(auth(hr)).expect(200),
      harness.http().get('/api/v1/positions').set(auth(hr)).expect(200),
      harness.http().get('/api/v1/candidates').set(auth(hr)).expect(200),
    ]);

    const projectIds = projects.body.data.map((row: { id: string }) => row.id);
    expect(projectIds).toEqual(expect.arrayContaining([fixture.projectAId, fixture.projectBId]));

    const positionIds = positions.body.data.map((row: { id: string }) => row.id);
    expect(positionIds).toEqual(expect.arrayContaining([fixture.positionAId, fixture.positionBId]));

    const candidateIds = candidates.body.data.map((row: { id: string }) => row.id);
    expect(candidateIds).toEqual(
      expect.arrayContaining([fixture.candidateAId, fixture.candidateBId]),
    );
  });

  it('the interview pipeline is scoped per caller', async () => {
    const [hrBoard, interviewerBoard] = await Promise.all([
      harness.http().get('/api/v1/interviews/pipeline').set(auth(hr)).expect(200),
      harness.http().get('/api/v1/interviews/pipeline').set(auth(interviewerA)).expect(200),
    ]);

    const hrPositions = hrBoard.body.data.map(
      (row: { position: { id: string } }) => row.position.id,
    );
    expect(hrPositions).toEqual(expect.arrayContaining([fixture.positionAId, fixture.positionBId]));

    const theirPositions = interviewerBoard.body.data.map(
      (row: { position: { id: string } }) => row.position.id,
    );
    expect(theirPositions).toEqual([fixture.positionAId]);
  });
});
