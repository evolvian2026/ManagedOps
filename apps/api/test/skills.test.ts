import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, type Harness, type Session } from './harness.js';
import { newId } from '../src/common/ids.js';

/**
 * Skills, capacity and who to put on the work.
 *
 * The unit tests already pin the arithmetic. What these prove is that the right
 * facts reach it, that a rate of the same shape — capacity — is enforced by the
 * database rather than hoped for, and that a trainer's own profile is theirs
 * and nobody else's.
 */
let harness: Harness;
let manager: Session;
let hr: Session;
let lead: Session;
let trainer: Session;

let context: {
  projectId: string;
  otherProjectId: string;
  positionId: string;
  strongTrainerId: string;
  staleTrainerId: string;
  wrongTrainerId: string;
  skills: Record<string, string>;
};

function auth(session: Session) {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function buildWorld() {
  const managerUser = await harness.prisma.db.user.findFirst({ where: { role: 'manager' } });
  const hrUser = await harness.prisma.db.user.findFirst({ where: { role: 'hr' } });
  const leadUser = await harness.prisma.db.user.findFirst({ where: { role: 'project_lead' } });

  const client = await harness.seedClient('Skills Test Client');

  const makeProject = (name: string) =>
    harness.prisma.db.project.create({
      data: {
        id: newId(),
        name,
        code: `SK-${Math.floor(Math.random() * 1_000_000)}`,
        clientId: client.id,
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        managerId: managerUser!.id,
        hrId: hrUser!.id,
        leadTrainerId: leadUser!.id,
      },
    });

  const project = await makeProject('Skills Test Project');
  const otherProject = await makeProject('Somewhere Else');

  const position = await harness.prisma.db.position.create({
    data: {
      id: newId(),
      projectId: project.id,
      title: 'Python Trainer',
      headcount: 1,
      status: 'open',
      createdById: hrUser!.id,
    },
  });

  const skills: Record<string, string> = {};
  for (const name of ['Python', 'SQL', 'Charts', 'React']) {
    const skill = await harness.prisma.db.skill.create({
      data: { id: newId(), name: `${name} ${Date.now()}${Math.random()}`.slice(0, 60) },
    });
    skills[name] = skill.id;
  }

  await harness.prisma.db.positionSkill.createMany({
    data: [
      { id: newId(), positionId: position.id, skillId: skills.Python!, requirement: 'essential' },
      { id: newId(), positionId: position.id, skillId: skills.SQL!, requirement: 'essential' },
      { id: newId(), positionId: position.id, skillId: skills.Charts!, requirement: 'desirable' },
    ],
  });

  const makeTrainer = async (
    name: string,
    profile: { skillId: string; proficiency: 'advanced' | 'expert'; monthsAgo: number }[],
  ) => {
    const user = await harness.seedUser({ role: 'trainer', name });
    const record = await harness.prisma.db.trainer.create({
      data: {
        id: newId(),
        userId: user.id,
        employeeCode: `SK-${Math.floor(Math.random() * 1_000_000)}`,
        personalEmail: user.email,
        phone: '+919812345678',
        status: 'active',
        salaryAnnual: 720_000,
      },
    });

    for (const entry of profile) {
      const lastUsed = new Date();
      lastUsed.setUTCMonth(lastUsed.getUTCMonth() - entry.monthsAgo);
      await harness.prisma.db.trainerSkill.create({
        data: {
          id: newId(),
          trainerId: record.id,
          skillId: entry.skillId,
          proficiency: entry.proficiency,
          lastUsedOn: new Date(lastUsed.toISOString().slice(0, 10)),
        },
      });
    }
    return record.id;
  };

  return {
    projectId: project.id,
    otherProjectId: otherProject.id,
    positionId: position.id,
    skills,
    // Everything the position needs, used last month.
    strongTrainerId: await makeTrainer('Strong Match', [
      { skillId: skills.Python!, proficiency: 'expert', monthsAgo: 1 },
      { skillId: skills.SQL!, proficiency: 'advanced', monthsAgo: 1 },
      { skillId: skills.Charts!, proficiency: 'advanced', monthsAgo: 1 },
    ]),
    // The same essentials, four years cold.
    staleTrainerId: await makeTrainer('Stale Match', [
      { skillId: skills.Python!, proficiency: 'expert', monthsAgo: 48 },
      { skillId: skills.SQL!, proficiency: 'advanced', monthsAgo: 48 },
    ]),
    // Excellent, and at the wrong thing.
    wrongTrainerId: await makeTrainer('Wrong Discipline', [
      { skillId: skills.React!, proficiency: 'expert', monthsAgo: 1 },
    ]),
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

  manager = await harness.signIn(managerUser.email);
  hr = await harness.signIn(hrUser.email);

  context = await buildWorld();

  lead = await harness.signIn(leadUser.email);
  // Signed in after the profiles exist, so the token carries a trainer id.
  const own = await harness.prisma.db.trainer.findUniqueOrThrow({
    where: { id: context.strongTrainerId },
    select: { user: { select: { email: true } } },
  });
  await harness.setPassword(
    (
      await harness.prisma.db.trainer.findUniqueOrThrow({
        where: { id: context.strongTrainerId },
        select: { userId: true },
      })
    ).userId,
  );
  trainer = await harness.signIn(own.user.email);
});

/* --------------------------------------------------------------- catalogue */

describe('the skill catalogue', () => {
  it('is readable by everyone, because every picker needs it', async () => {
    for (const session of [manager, hr, lead, trainer]) {
      await harness.http().get('/api/v1/skills').set(auth(session)).expect(200);
    }
  });

  it('is only writable by somebody who owns the catalogue', async () => {
    await harness
      .http()
      .post('/api/v1/skills')
      .set(auth(hr))
      .send({ name: 'Kubernetes' })
      .expect(201);

    for (const session of [lead, trainer]) {
      await harness
        .http()
        .post('/api/v1/skills')
        .set(auth(session))
        .send({ name: 'Whatever They Fancy' })
        .expect(403);
    }
  });

  it('refuses a duplicate name, which is the whole point of a catalogue', async () => {
    await harness.http().post('/api/v1/skills').set(auth(hr)).send({ name: 'Rust' }).expect(201);

    const response = await harness
      .http()
      .post('/api/v1/skills')
      .set(auth(hr))
      .send({ name: 'Rust' })
      .expect(422);
    expect(response.body.errors[0].path).toBe('name');
  });

  it('refuses to delete a skill somebody claims, and says to archive it', async () => {
    const response = await harness
      .http()
      .delete(`/api/v1/skills/${context.skills.Python}`)
      .set(auth(hr))
      .expect(409);
    expect(response.body.detail).toMatch(/Archive it instead/);
  });

  it('will not let an archived skill be added to a profile', async () => {
    await harness
      .http()
      .patch(`/api/v1/skills/${context.skills.React}`)
      .set(auth(hr))
      .send({ status: 'archived' })
      .expect(200);

    const response = await harness
      .http()
      .put(`/api/v1/trainers/${context.strongTrainerId}/skills`)
      .set(auth(hr))
      .send({ skillId: context.skills.React, proficiency: 'expert' })
      .expect(409);
    expect(response.body.detail).toMatch(/archived/);
  });
});

/* ------------------------------------------------------------- own profile */

describe('a trainer’s own skills', () => {
  it('can be kept current by the trainer themselves', async () => {
    await harness
      .http()
      .put(`/api/v1/trainers/${context.strongTrainerId}/skills`)
      .set(auth(trainer))
      .send({ skillId: context.skills.React, proficiency: 'intermediate' })
      .expect(200);

    const response = await harness
      .http()
      .get(`/api/v1/trainers/${context.strongTrainerId}/skills`)
      .set(auth(trainer))
      .expect(200);
    expect(response.body.map((row: { skill: { id: string } }) => row.skill.id)).toContain(
      context.skills.React,
    );
  });

  it('updates rather than duplicating when the same skill is set twice', async () => {
    const body = { skillId: context.skills.Python, proficiency: 'beginner' as const };
    await harness
      .http()
      .put(`/api/v1/trainers/${context.strongTrainerId}/skills`)
      .set(auth(trainer))
      .send(body)
      .expect(200);

    const rows = await harness.prisma.db.trainerSkill.findMany({
      where: { trainerId: context.strongTrainerId, skillId: context.skills.Python },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proficiency).toBe('beginner');
  });

  it('is not editable on somebody else’s record', async () => {
    await harness
      .http()
      .put(`/api/v1/trainers/${context.staleTrainerId}/skills`)
      .set(auth(trainer))
      .send({ skillId: context.skills.React, proficiency: 'expert' })
      .expect(404);
  });

  it('refuses a last-used date in the future', async () => {
    await harness
      .http()
      .put(`/api/v1/trainers/${context.strongTrainerId}/skills`)
      .set(auth(trainer))
      .send({
        skillId: context.skills.React,
        proficiency: 'expert',
        lastUsedOn: isoDaysFromNow(30),
      })
      .expect(422);
  });
});

/* ---------------------------------------------------------------- matching */

describe('finding somebody for a position', () => {
  it('ranks the current match above the identical but stale one', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?positionId=${context.positionId}`)
      .set(auth(hr))
      .expect(200);

    const names = response.body.candidates.map((c: { name: string }) => c.name);
    expect(names).toEqual(['Strong Match', 'Stale Match']);
    // The one nobody could argue with: the wrong discipline is not on the list.
    expect(names).not.toContain('Wrong Discipline');
  });

  it('says in words why somebody is not on the list', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?positionId=${context.positionId}&eligibleOnly=false`)
      .set(auth(hr))
      .expect(200);

    const wrong = response.body.candidates.find(
      (c: { name: string }) => c.name === 'Wrong Discipline',
    );
    expect(wrong.eligible).toBe(false);
    expect(wrong.score).toBe(0);
    expect(wrong.reasons[0]).toMatch(/^Missing an essential skill:/);
  });

  it('names the staleness rather than only scoring it down', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?positionId=${context.positionId}`)
      .set(auth(hr))
      .expect(200);

    const stale = response.body.candidates.find((c: { name: string }) => c.name === 'Stale Match');
    expect(stale.reasons.join(' ')).toMatch(/Has not used the essential skills in \d years/);
  });

  it('searches on skills alone, for the question asked before a requisition exists', async () => {
    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?skillIds=${context.skills.React}`)
      .set(auth(hr))
      .expect(200);

    expect(response.body.position).toBeNull();
    expect(response.body.candidates.map((c: { name: string }) => c.name)).toEqual([
      'Wrong Discipline',
    ]);
  });

  it('refuses a search that says nothing about what is wanted', async () => {
    await harness.http().get('/api/v1/matching/trainers').set(auth(hr)).expect(422);
  });

  it('refuses a skill id that is not in the catalogue', async () => {
    await harness
      .http()
      .get(`/api/v1/matching/trainers?skillIds=${newId()}`)
      .set(auth(hr))
      .expect(422);
  });

  it('reports availability beside fit rather than folded into it', async () => {
    await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: context.strongTrainerId,
        projectId: context.projectId,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: null,
        status: 'active',
        allocationPercent: 100,
      },
    });

    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?positionId=${context.positionId}`)
      .set(auth(hr))
      .expect(200);

    const strong = response.body.candidates.find(
      (c: { name: string }) => c.name === 'Strong Match',
    );
    // Still ranked first on fit — being busy is a fact for a human to weigh,
    // not a reason to bury the best-matched person.
    expect(response.body.candidates[0].name).toBe('Strong Match');
    expect(strong.availability.availablePercent).toBe(0);
    expect(strong.availability.availableFrom).toBeNull();
    expect(strong.commitments[0].projectName).toBe('Skills Test Project');
  });

  it('hides the fully booked when asked to', async () => {
    await harness.prisma.db.assignment.create({
      data: {
        id: newId(),
        trainerId: context.strongTrainerId,
        projectId: context.projectId,
        role: 'trainer',
        startDate: new Date('2026-01-01T00:00:00Z'),
        status: 'active',
        allocationPercent: 100,
      },
    });

    const response = await harness
      .http()
      .get(`/api/v1/matching/trainers?positionId=${context.positionId}&availableOnly=true`)
      .set(auth(hr))
      .expect(200);

    const names = response.body.candidates.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Strong Match');
    expect(names).toContain('Stale Match');
    // The count of who was considered survives the filter, so an empty list
    // reads as "nobody free" rather than "nobody exists".
    expect(response.body.consideredCount).toBe(3);
  });

  it('is not readable by a lead or a trainer', async () => {
    for (const session of [lead, trainer]) {
      await harness
        .http()
        .get(`/api/v1/matching/trainers?positionId=${context.positionId}`)
        .set(auth(session))
        .expect(403);
    }
  });
});

/* ---------------------------------------------------------------- capacity */

describe('nobody is in two places at once', () => {
  // Not async: the supertest object has to be returned unwrapped so `.expect`
  // still chains off it.
  function assign(trainerId: string, projectId: string, body: Record<string, unknown> = {}) {
    return harness
      .http()
      .post(`/api/v1/trainers/${trainerId}/assignments`)
      .set(auth(hr))
      .send({ projectId, role: 'trainer', startDate: '2027-01-01', ...body });
  }

  it('refuses a second full-time posting and names the one in the way', async () => {
    await assign(context.strongTrainerId, context.projectId).expect(201);

    const response = await assign(context.strongTrainerId, context.otherProjectId).expect(409);
    expect(response.body.detail).toMatch(/Skills Test Project/);
    expect(response.body.detail).toMatch(/no agreed end date/);
  });

  it('allows a second posting that starts after the first ends', async () => {
    await assign(context.strongTrainerId, context.projectId, {
      startDate: '2027-01-01',
      endDate: '2027-06-30',
    }).expect(201);

    await assign(context.strongTrainerId, context.otherProjectId, {
      startDate: '2027-07-01',
    }).expect(201);
  });

  it('allows two part-time postings that overlap', async () => {
    await assign(context.strongTrainerId, context.projectId, { allocationPercent: 60 }).expect(201);
    await assign(context.strongTrainerId, context.otherProjectId, {
      allocationPercent: 40,
    }).expect(201);
  });

  it('is enforced by the database, not only by the check that explains it', async () => {
    await assign(context.strongTrainerId, context.projectId).expect(201);

    // Straight past the service, the way a second concurrent request would
    // arrive. Before this constraint existed the read-then-write check let
    // both through.
    await expect(
      harness.prisma.db.assignment.create({
        data: {
          id: newId(),
          trainerId: context.strongTrainerId,
          projectId: context.otherProjectId,
          role: 'trainer',
          startDate: new Date('2027-03-01T00:00:00Z'),
          status: 'active',
          allocationPercent: 100,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a duplicate live assignment on the same project at the database', async () => {
    await assign(context.strongTrainerId, context.projectId, { allocationPercent: 50 }).expect(201);

    await expect(
      harness.prisma.db.assignment.create({
        data: {
          id: newId(),
          trainerId: context.strongTrainerId,
          projectId: context.projectId,
          role: 'trainer',
          startDate: new Date('2027-02-01T00:00:00Z'),
          status: 'active',
          allocationPercent: 50,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses an allocation outside one to a hundred', async () => {
    await assign(context.strongTrainerId, context.projectId, { allocationPercent: 0 }).expect(422);
    await assign(context.strongTrainerId, context.projectId, { allocationPercent: 150 }).expect(
      422,
    );
  });
});
