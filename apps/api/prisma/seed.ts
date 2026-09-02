/**
 * Seeds a realistic starting point for development and demos.
 *
 * It is idempotent: re-running updates the same records rather than piling up
 * duplicates, so `pnpm db:seed` is safe to repeat against a live dev database.
 *
 * Everything here is demo data. The only credential is SEED_PASSWORD from the
 * environment, which exists solely so a developer can sign in; nothing in this
 * file is used by, or reachable from, production.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { v7 as uuidv7 } from 'uuid';

const prisma = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'ManagedOps!2026';
const TODAY = new Date();

function daysFromToday(offset: number): Date {
  const date = new Date(TODAY);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

function dateOnly(date: Date): Date {
  return new Date(date.toISOString().slice(0, 10));
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  console.log('Seeding ManagedOps demo data...');
  const passwordHash = await argon2.hash(SEED_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  // ---------------------------------------------------------------- users
  const staff = [
    {
      key: 'superAdmin',
      name: 'Vishal Rathee',
      email: 'vishal.rathee@managedops.local',
      role: 'super_admin' as const,
    },
    {
      key: 'manager',
      name: 'Priya Nair',
      email: 'priya.nair@managedops.local',
      role: 'manager' as const,
    },
    {
      key: 'hr',
      name: 'Ananya Sharma',
      email: 'ananya.sharma@managedops.local',
      role: 'hr' as const,
    },
    {
      key: 'interviewer',
      name: 'Rohit Verma',
      email: 'rohit.verma@managedops.local',
      role: 'interviewer' as const,
    },
  ];

  const users: Record<string, { id: string; email: string; name: string }> = {};
  for (const person of staff) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name, role: person.role, status: 'active' },
      create: {
        id: uuidv7(),
        name: person.name,
        email: person.email,
        phone: '+919800000001',
        role: person.role,
        passwordHash,
        // Seeded accounts skip the forced change so a developer can sign
        // straight in; a real account created through the API cannot.
        mustChangePassword: false,
      },
    });
    users[person.key] = { id: user.id, email: user.email, name: user.name };
  }

  // ---------------------------------------------------------------- trainers
  const trainerSeeds = [
    { name: 'Karan Mehta', email: 'karan.mehta@managedops.local', lead: true },
    { name: 'Sneha Iyer', email: 'sneha.iyer@managedops.local', lead: false },
    { name: 'Arjun Desai', email: 'arjun.desai@managedops.local', lead: false },
    { name: 'Meera Krishnan', email: 'meera.krishnan@managedops.local', lead: false },
  ];

  const trainers: {
    userId: string;
    trainerId: string;
    name: string;
    email: string;
    lead: boolean;
  }[] = [];
  let employeeSequence = 1;

  for (const seed of trainerSeeds) {
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      update: { name: seed.name, role: seed.lead ? 'project_lead' : 'trainer', status: 'active' },
      create: {
        id: uuidv7(),
        name: seed.name,
        email: seed.email,
        phone: `+91980000${String(1000 + employeeSequence).slice(-4)}`,
        // A head trainer teaches as well as leading, so their role carries both
        // project oversight and the trainer's own self-service capabilities.
        role: seed.lead ? 'project_lead' : 'trainer',
        passwordHash,
        mustChangePassword: false,
      },
    });

    const employeeCode = `MO-${TODAY.getUTCFullYear()}-${String(employeeSequence).padStart(4, '0')}`;
    const trainer = await prisma.trainer.upsert({
      where: { userId: user.id },
      update: { status: 'active' },
      create: {
        id: uuidv7(),
        userId: user.id,
        employeeCode,
        personalEmail: seed.email,
        workEmail: seed.email.replace('@managedops.local', '@managedops.example'),
        phone: `+91980000${String(1000 + employeeSequence).slice(-4)}`,
        joiningDate: dateOnly(daysFromToday(-45)),
        salaryAnnual: new Prisma.Decimal(seed.lead ? 960000 : 720000),
        status: 'active',
        onboardingHrId: users.hr?.id,
        rehireEligible: true,
        documentsCompletedAt: daysFromToday(-44),
      },
    });

    trainers.push({
      userId: user.id,
      trainerId: trainer.id,
      name: seed.name,
      email: seed.email,
      lead: seed.lead,
    });
    employeeSequence += 1;
  }

  const leadTrainer = trainers.find((trainer) => trainer.lead);

  // ---------------------------------------------------------------- projects
  const project = await prisma.project.upsert({
    where: { code: 'MO-DEMO-01' },
    update: {},
    create: {
      id: uuidv7(),
      name: 'Full Stack Bootcamp — Spring Term',
      code: 'MO-DEMO-01',
      clientName: 'Horizon Institute of Technology',
      location: 'Pune',
      startDate: dateOnly(daysFromToday(-45)),
      endDate: dateOnly(daysFromToday(60)),
      status: 'active',
      managerId: users.manager!.id,
      hrId: users.hr!.id,
      leadTrainerId: leadTrainer?.userId,
      workStartTime: '09:00',
      graceMinutes: 15,
      weeklyOffDays: [0],
      createdById: users.superAdmin!.id,
    },
  });

  const secondProject = await prisma.project.upsert({
    where: { code: 'MO-DEMO-02' },
    update: {},
    create: {
      id: uuidv7(),
      name: 'Data Analytics Certificate — Summer Term',
      code: 'MO-DEMO-02',
      clientName: 'Meridian Business School',
      location: 'Bengaluru',
      startDate: dateOnly(daysFromToday(21)),
      status: 'planned',
      managerId: users.manager!.id,
      hrId: users.hr!.id,
      createdById: users.superAdmin!.id,
    },
  });

  // Republic Day, as an organisation-wide holiday that leave will not consume.
  await prisma.holiday
    .upsert({
      where: { projectId_date: { projectId: null as never, date: dateOnly(daysFromToday(14)) } },
      update: {},
      create: {
        id: uuidv7(),
        projectId: null,
        date: dateOnly(daysFromToday(14)),
        name: 'Public holiday',
      },
    })
    .catch(() => undefined);

  // ---------------------------------------------------------------- assignments
  for (const trainer of trainers) {
    const existing = await prisma.assignment.findFirst({
      where: { trainerId: trainer.trainerId, projectId: project.id, status: 'active' },
    });
    if (existing) continue;

    await prisma.assignment.create({
      data: {
        id: uuidv7(),
        trainerId: trainer.trainerId,
        projectId: project.id,
        role: trainer.lead ? 'lead' : 'trainer',
        startDate: dateOnly(daysFromToday(-45)),
        status: 'active',
        leaveAllowanceDays: new Prisma.Decimal(3),
        createdById: users.manager!.id,
      },
    });
  }

  // ---------------------------------------------------------------- recruitment
  const position = await prisma.position.findFirst({
    where: { projectId: secondProject.id, title: 'Data Analytics Trainer' },
  });
  const seededPosition =
    position ??
    (await prisma.position.create({
      data: {
        id: uuidv7(),
        projectId: secondProject.id,
        title: 'Data Analytics Trainer',
        headcount: 3,
        description: 'Delivers the Python, SQL and visualisation modules for the summer term.',
        status: 'open',
        createdById: users.hr!.id,
      },
    }));

  const candidateSeeds = [
    {
      name: 'Nikhil Joshi',
      email: 'nikhil.joshi@example.com',
      phone: '+919812345671',
      source: 'referral' as const,
    },
    {
      name: 'Divya Menon',
      email: 'divya.menon@example.com',
      phone: '+919812345672',
      source: 'email' as const,
    },
    {
      name: 'Sameer Kulkarni',
      email: 'sameer.kulkarni@example.com',
      phone: '+919812345673',
      source: 'whatsapp' as const,
    },
  ];

  for (const seed of candidateSeeds) {
    const candidate = await prisma.candidate.upsert({
      where: { email: seed.email },
      update: {},
      create: {
        id: uuidv7(),
        name: seed.name,
        email: seed.email,
        phone: seed.phone,
        source: seed.source,
        status: 'active',
        poolEligible: true,
        createdById: users.hr!.id,
      },
    });

    await prisma.application.upsert({
      where: {
        candidateId_positionId: { candidateId: candidate.id, positionId: seededPosition.id },
      },
      update: {},
      create: {
        id: uuidv7(),
        candidateId: candidate.id,
        positionId: seededPosition.id,
        status: 'applied',
        createdById: users.hr!.id,
      },
    });
  }

  // ---------------------------------------------------------------- assets
  const assetSeeds = [
    { name: 'Dell Latitude 5440', category: 'hardware' as const, serialNumber: 'DL5440-0001' },
    { name: 'Dell Latitude 5440', category: 'hardware' as const, serialNumber: 'DL5440-0002' },
    {
      name: 'Boya BY-M1 lapel microphone',
      category: 'accessory' as const,
      serialNumber: 'BOYA-0031',
    },
    { name: 'HDMI cable (3m)', category: 'accessory' as const, serialNumber: null },
  ];

  for (const seed of assetSeeds) {
    const existing = seed.serialNumber
      ? await prisma.asset.findUnique({ where: { serialNumber: seed.serialNumber } })
      : await prisma.asset.findFirst({ where: { name: seed.name, serialNumber: null } });
    if (existing) continue;

    await prisma.asset.create({
      data: {
        id: uuidv7(),
        name: seed.name,
        category: seed.category,
        serialNumber: seed.serialNumber,
        status: 'available',
        createdById: users.manager!.id,
      },
    });
  }

  console.log('');
  console.log('Seed complete. Sign in with any of these — all share one password.');
  console.log('');
  for (const person of staff) {
    console.log(`  ${person.role.padEnd(12)} ${person.email}`);
  }
  for (const trainer of trainers) {
    console.log(`  ${(trainer.lead ? 'project_lead' : 'trainer').padEnd(12)} ${trainer.email}`);
  }
  console.log('');
  console.log(`  password     ${SEED_PASSWORD}`);
  console.log('');
  console.log(
    `  ${trainers.length} trainers on "${project.name}", ` +
      `${candidateSeeds.length} candidates applied to "${seededPosition.title}".`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
