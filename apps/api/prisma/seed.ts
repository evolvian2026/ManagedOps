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
      name: 'Anoop Dobhal',
      email: 'anoop.dcrust@gmail.com',
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
    // Deliberately left un-screened: an applicant waiting on a screening call
    // is the most common state on this board, so the demo should show one.
    {
      name: 'Ritika Bansal',
      email: 'ritika.bansal@example.com',
      phone: '+919812345674',
      source: 'job_board' as const,
    },
  ];

  for (const seed of candidateSeeds) {
    // A resume is mandatory at intake, so seeded candidates carry one too —
    // otherwise the demo data would be records the API itself would refuse.
    // Only the metadata is created here; the object lands in storage when a
    // real upload happens, so the download link is inert until then.
    // The upsert's return value is the row that exists now, which on a re-run is
    // the one already stored — not the id generated a line earlier. Using the
    // generated id regardless is why re-seeding used to fail with "record to
    // update not found" the second time it was run.
    const resume = await prisma.fileObject.upsert({
      where: { storageKey: `resumes/${seed.email}/cv.pdf` },
      update: {},
      create: {
        id: uuidv7(),
        storageKey: `resumes/${seed.email}/cv.pdf`,
        originalName: `${seed.name.replace(/ /g, '-').toLowerCase()}-cv.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 148_000,
        uploadedById: users.hr!.id,
        ownerType: 'Candidate',
        confirmedAt: daysFromToday(-10),
        scanStatus: 'skipped',
      },
    });

    const candidate = await prisma.candidate.upsert({
      where: { email: seed.email },
      update: {},
      create: {
        id: uuidv7(),
        name: seed.name,
        email: seed.email,
        phone: seed.phone,
        source: seed.source,
        resumeFileId: resume.id,
        status: 'active',
        poolEligible: true,
        createdById: users.hr!.id,
      },
    });

    await prisma.fileObject.update({
      where: { id: resume.id },
      data: { ownerId: candidate.id },
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

  // ------------------------------------------------------------- documents
  // Active trainers have their paperwork verified; one newer hire is still
  // partway through, so the onboarding checklist has a real state to show.
  const mandatoryDocs = ['aadhaar', 'pan', 'education_certificate'] as const;

  for (const [index, trainer] of trainers.entries()) {
    const midOnboarding = index === trainers.length - 1;

    for (const docType of mandatoryDocs) {
      const existing = await prisma.trainerDocument.findUnique({
        where: { trainerId_docType: { trainerId: trainer.trainerId, docType } },
      });
      if (existing) continue;

      // The last trainer has Aadhaar verified, PAN rejected and nothing else in.
      const state =
        !midOnboarding || docType === 'aadhaar'
          ? 'verified'
          : docType === 'pan'
            ? 'rejected'
            : 'pending';

      const fileId = state === 'pending' ? null : uuidv7();
      if (fileId) {
        await prisma.fileObject.create({
          data: {
            id: fileId,
            storageKey: `identity/${trainer.trainerId}/${docType}.pdf`,
            originalName: `${docType}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 96_000,
            uploadedById: trainer.userId,
            ownerType: 'TrainerDocument',
            confirmedAt: daysFromToday(-40),
            scanStatus: 'skipped',
          },
        });
      }

      await prisma.trainerDocument.create({
        data: {
          id: uuidv7(),
          trainerId: trainer.trainerId,
          docType,
          fileId,
          lastFour: docType === 'aadhaar' ? '4821' : docType === 'pan' ? 'K7Z1' : null,
          status: state,
          rejectReason: state === 'rejected' ? 'The scan is cut off along the bottom edge.' : null,
          verifiedById: state === 'pending' ? null : users.hr!.id,
          verifiedAt: state === 'pending' ? null : daysFromToday(-39),
        },
      });
    }

    if (midOnboarding) {
      // Status follows the facts: paperwork outstanding means still onboarding.
      await prisma.trainer.update({
        where: { id: trainer.trainerId },
        data: { status: 'pending_onboarding', documentsCompletedAt: null },
      });
      await prisma.user.update({
        where: { id: trainer.userId },
        data: { mustChangePassword: false },
      });
    }
  }

  // ------------------------------------------------------- pipeline states
  // Walks a few candidates to different stages so every Onboarding screen has
  // something real to show rather than three empty states.
  const applications = await prisma.application.findMany({
    where: { positionId: seededPosition.id },
    include: { candidate: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const [first, second, third] = applications;

  // One screened through and booked for an interview.
  if (first && first.status === 'applied') {
    await prisma.application.update({
      where: { id: first.id },
      data: {
        status: 'interviewing',
        screeningOutcome: 'proceed',
        screeningNotes: 'Strong Python and SQL, has taught undergraduates before.',
        screenedById: users.hr!.id,
        screenedAt: daysFromToday(-2),
      },
    });
    await prisma.interview.create({
      data: {
        id: uuidv7(),
        applicationId: first.id,
        round: 1,
        scheduledAt: new Date(daysFromToday(2).setUTCHours(4, 30, 0, 0)),
        durationMinutes: 45,
        meetingUrl: 'https://meet.example.com/managedops-demo',
        interviewerId: users.interviewer!.id,
        status: 'scheduled',
        createdById: users.hr!.id,
      },
    });
  }

  // One interviewed, selected, and holding a sent offer.
  if (second && second.status === 'applied') {
    await prisma.application.update({
      where: { id: second.id },
      data: {
        status: 'offer_stage',
        screeningOutcome: 'proceed',
        screenedById: users.hr!.id,
        screenedAt: daysFromToday(-9),
      },
    });
    await prisma.interview.create({
      data: {
        id: uuidv7(),
        applicationId: second.id,
        round: 1,
        scheduledAt: new Date(daysFromToday(-5).setUTCHours(5, 0, 0, 0)),
        interviewerId: users.interviewer!.id,
        status: 'completed',
        outcome: 'selected',
        feedback: 'Excellent communicator. Explained joins and window functions clearly.',
        conductedAt: daysFromToday(-5),
        createdById: users.hr!.id,
      },
    });
    await prisma.offer.create({
      data: {
        id: uuidv7(),
        applicationId: second.id,
        version: 1,
        salaryAnnual: new Prisma.Decimal(780000),
        joiningDate: dateOnly(daysFromToday(30)),
        status: 'sent',
        sentAt: daysFromToday(-3),
        notes: 'Standard summer-term contract.',
        createdById: users.hr!.id,
      },
    });
  }

  // One who no-showed, so the Missed tab is not empty either.
  if (third && third.status === 'applied') {
    await prisma.application.update({
      where: { id: third.id },
      data: {
        status: 'interviewing',
        screeningOutcome: 'proceed',
        screenedById: users.hr!.id,
        screenedAt: daysFromToday(-7),
      },
    });
    await prisma.interview.create({
      data: {
        id: uuidv7(),
        applicationId: third.id,
        round: 1,
        scheduledAt: new Date(daysFromToday(-4).setUTCHours(6, 0, 0, 0)),
        interviewerId: users.interviewer!.id,
        status: 'missed',
        createdById: users.hr!.id,
      },
    });
  }

  // ------------------------------------------------------- delivery operations
  //
  // Enough history for the screens to be worth looking at: a fortnight of
  // attendance per trainer with a couple of late arrivals and one day left
  // open, a correction waiting on an approver, leave in both states, teaching
  // sessions, a syllabus, an issued laptop, a claim above HR's limit and an
  // open flag. All of it derived from today's date, so the demo never goes stale.

  const assignments = await prisma.assignment.findMany({
    where: { projectId: project.id, status: 'active' },
    select: { id: true, trainerId: true, role: true },
  });

  const byTrainer = new Map(assignments.map((row) => [row.trainerId, row]));
  const leadAssignment = assignments.find((row) => row.role === 'lead');
  const sneha = trainers.find((trainer) => trainer.name === 'Sneha Iyer');
  const arjun = trainers.find((trainer) => trainer.name === 'Arjun Desai');
  const snehaAssignment = sneha ? byTrainer.get(sneha.trainerId) : undefined;
  const arjunAssignment = arjun ? byTrainer.get(arjun.trainerId) : undefined;

  /** Working days only — Sunday is the project's weekly off. */
  function recentWorkingDays(count: number): Date[] {
    const days: Date[] = [];
    for (let offset = 1; days.length < count; offset += 1) {
      const day = daysFromToday(-offset);
      if (day.getUTCDay() !== 0) days.push(day);
    }
    return days;
  }

  function at(day: Date, hours: number, minutes: number): Date {
    // Stored as an instant; these are IST clock times, which is UTC+5:30.
    const instant = new Date(day);
    instant.setUTCHours(hours - 5, minutes - 30, 0, 0);
    return instant;
  }

  const history = recentWorkingDays(12);
  let openDayRecordId: string | null = null;

  for (const [index, assignment] of assignments.entries()) {
    for (const [dayIndex, day] of history.entries()) {
      const workDate = dateOnly(day);
      const existing = await prisma.attendanceRecord.findUnique({
        where: { assignmentId_workDate: { assignmentId: assignment.id, workDate } },
      });
      if (existing) continue;

      // One trainer arrives late twice, and one day was never punched out —
      // the two cases the corrections queue exists for.
      const late = index === 1 && (dayIndex === 2 || dayIndex === 6);
      const leftOpen = index === 1 && dayIndex === 1;

      const record = await prisma.attendanceRecord.create({
        data: {
          id: uuidv7(),
          assignmentId: assignment.id,
          workDate,
          punchInAt: at(day, late ? 9 : 8, late ? 42 : 51),
          punchInLat: new Prisma.Decimal('18.520430'),
          punchInLng: new Prisma.Decimal('73.856743'),
          punchOutAt: leftOpen ? null : at(day, 17, 35),
          punchOutLat: leftOpen ? null : new Prisma.Decimal('18.520430'),
          punchOutLng: leftOpen ? null : new Prisma.Decimal('73.856743'),
          status: leftOpen ? 'missing_punch_out' : late ? 'late' : 'present',
          locationStatus: 'captured',
          source: 'self',
        },
      });
      if (leftOpen) openDayRecordId = record.id;
    }
  }

  // A correction waiting on the lead: the day above, with the punch-out the
  // trainer says they forgot.
  if (openDayRecordId && sneha) {
    const pending = await prisma.attendanceCorrection.findFirst({
      where: { attendanceRecordId: openDayRecordId },
    });
    if (!pending) {
      await prisma.attendanceCorrection.create({
        data: {
          id: uuidv7(),
          attendanceRecordId: openDayRecordId,
          requestedById: sneha.userId,
          requestedPunchOut: at(history[1], 18, 5),
          reason: 'Client wrapped up late and I left without punching out.',
          status: 'pending',
        },
      });
      await prisma.attendanceRecord.update({
        where: { id: openDayRecordId },
        data: { status: 'correction_pending' },
      });
    }
  }

  // ---------------------------------------------------------------- leave
  if (arjunAssignment) {
    const existing = await prisma.leaveRequest.findFirst({
      where: { assignmentId: arjunAssignment.id },
    });
    if (!existing) {
      await prisma.leaveRequest.create({
        data: {
          id: uuidv7(),
          assignmentId: arjunAssignment.id,
          startDate: dateOnly(daysFromToday(7)),
          endDate: dateOnly(daysFromToday(8)),
          dayType: 'full',
          daysCount: new Prisma.Decimal(2),
          unpaidDays: new Prisma.Decimal(0),
          reason: 'Family wedding in Nashik.',
          status: 'submitted',
        },
      });
    }
  }

  if (snehaAssignment) {
    const existing = await prisma.leaveRequest.findFirst({
      where: { assignmentId: snehaAssignment.id, status: 'approved' },
    });
    if (!existing) {
      const takenOn = dateOnly(history[4]);
      await prisma.leaveRequest.create({
        data: {
          id: uuidv7(),
          assignmentId: snehaAssignment.id,
          startDate: takenOn,
          endDate: takenOn,
          dayType: 'half',
          daysCount: new Prisma.Decimal('0.5'),
          unpaidDays: new Prisma.Decimal(0),
          reason: 'Medical appointment.',
          status: 'approved',
          approverId: leadTrainer?.userId,
          decidedAt: daysFromToday(-6),
        },
      });
      // An approved leave writes the day, exactly as the API does.
      await prisma.attendanceRecord.upsert({
        where: { assignmentId_workDate: { assignmentId: snehaAssignment.id, workDate: takenOn } },
        create: {
          id: uuidv7(),
          assignmentId: snehaAssignment.id,
          workDate: takenOn,
          status: 'half_day',
          source: 'leave',
          locationStatus: 'unavailable',
        },
        update: { status: 'half_day', source: 'leave' },
      });
    }
  }

  // ------------------------------------------------------------- daily log
  const syllabus = [
    'React component model and JSX',
    'State, effects and the rules of hooks',
    'Routing and data loading',
    'Forms, validation and accessibility',
    'Testing components with Vitest',
  ];

  if (leadAssignment) {
    for (const [index, day] of history.slice(0, 5).entries()) {
      const workDate = dateOnly(day);
      const existing = await prisma.dailyLog.findFirst({
        where: { assignmentId: leadAssignment.id, workDate },
      });
      if (existing) continue;

      await prisma.dailyLog.create({
        data: {
          id: uuidv7(),
          assignmentId: leadAssignment.id,
          workDate,
          sessionNo: 1,
          topic: syllabus[index % syllabus.length],
          hours: new Prisma.Decimal('3.5'),
          notes: 'Full cohort present. Lab exercise completed in pairs.',
          submittedAt: at(day, 18, 0),
          locked: true,
        },
      });
    }
  }

  // ----------------------------------------------------------- deliverables
  for (const assignment of [leadAssignment, snehaAssignment].filter(Boolean)) {
    for (const [index, title] of syllabus.entries()) {
      const existing = await prisma.deliverable.findFirst({
        where: { assignmentId: assignment!.id, title },
      });
      if (existing) continue;

      await prisma.deliverable.create({
        data: {
          id: uuidv7(),
          assignmentId: assignment!.id,
          type: 'syllabus',
          title,
          dueDate: dateOnly(daysFromToday(index * 7 - 14)),
          status: index < 2 ? 'completed' : index === 2 ? 'in_progress' : 'pending',
          completedAt: index < 2 ? daysFromToday(index * 7 - 14) : null,
          createdById: users.manager!.id,
        },
      });
    }
  }

  if (leadAssignment) {
    const duty = 'Weekly progress report to Horizon';
    const existing = await prisma.deliverable.findFirst({
      where: { assignmentId: leadAssignment.id, title: duty },
    });
    if (!existing) {
      await prisma.deliverable.create({
        data: {
          id: uuidv7(),
          assignmentId: leadAssignment.id,
          type: 'other_duty',
          title: duty,
          description: 'Attendance, syllabus progress and any blockers.',
          dueDate: dateOnly(daysFromToday(3)),
          status: 'pending',
          createdById: users.manager!.id,
        },
      });
    }
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

  // A laptop actually in someone's hands, so the Resources screen and the
  // deboarding reconciliation both have something real to reconcile.
  if (leadAssignment) {
    const laptop = await prisma.asset.findUnique({ where: { serialNumber: 'DL5440-0001' } });
    const alreadyIssued = laptop
      ? await prisma.assetIssue.findFirst({ where: { assetId: laptop.id, status: 'issued' } })
      : null;
    if (laptop && !alreadyIssued) {
      await prisma.assetIssue.create({
        data: {
          id: uuidv7(),
          assetId: laptop.id,
          assignmentId: leadAssignment.id,
          issuedById: users.manager!.id,
          issuedAt: daysFromToday(-44),
          issueSerial: laptop.serialNumber,
          issueNotes: 'Charger and sleeve included.',
          status: 'issued',
        },
      });
      await prisma.asset.update({ where: { id: laptop.id }, data: { status: 'issued' } });
    }
  }

  // -------------------------------------------------------- reimbursements
  if (snehaAssignment && sneha) {
    const existing = await prisma.reimbursement.findFirst({
      where: { trainerId: sneha.trainerId },
    });
    if (!existing) {
      const proof = await prisma.fileObject.upsert({
        where: { storageKey: `claims/${sneha.email}/cab-receipt.pdf` },
        update: {},
        create: {
          id: uuidv7(),
          storageKey: `claims/${sneha.email}/cab-receipt.pdf`,
          originalName: 'cab-receipt.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 62_000,
          uploadedById: sneha.userId,
          ownerType: 'Reimbursement',
          confirmedAt: daysFromToday(-3),
          scanStatus: 'skipped',
        },
      });

      // Above HR's ₹10,000 limit, so the Manager has to sign it off — the tier
      // rule is visible in the demo rather than only in the tests.
      const claim = await prisma.reimbursement.create({
        data: {
          id: uuidv7(),
          trainerId: sneha.trainerId,
          assignmentId: snehaAssignment.id,
          category: 'travel',
          amount: new Prisma.Decimal('12500.00'),
          description: 'Return airfare to the Hyderabad campus for the induction week.',
          proofFileId: proof.id,
          status: 'submitted',
        },
      });
      await prisma.fileObject.update({ where: { id: proof.id }, data: { ownerId: claim.id } });
    }
  }

  // ---------------------------------------------------------------- flags
  if (arjunAssignment && leadTrainer) {
    const existing = await prisma.flag.findFirst({ where: { assignmentId: arjunAssignment.id } });
    if (!existing) {
      await prisma.flag.create({
        data: {
          id: uuidv7(),
          assignmentId: arjunAssignment.id,
          raisedById: leadTrainer.userId,
          severity: 'medium',
          description:
            'Arrived after the session start on three occasions this fortnight. The cohort was left waiting each time.',
          status: 'raised',
        },
      });
    }
  }

  // One applicant screened out with a recorded reason, so the Talent Pool has a
  // candidate as well as a past trainer — and the reason it shows is the one the
  // rejection carried, not the internal notes from the call. Deliberately a
  // candidate of her own rather than one of the four on the board, so the
  // recruitment demo keeps its pipeline intact.
  const rejectedEmail = 'priyanka.rane@example.com';
  const rejectedResume = await prisma.fileObject.upsert({
    where: { storageKey: `resumes/${rejectedEmail}/cv.pdf` },
    update: {},
    create: {
      id: uuidv7(),
      storageKey: `resumes/${rejectedEmail}/cv.pdf`,
      originalName: 'priyanka-rane-cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 132_000,
      uploadedById: users.hr!.id,
      ownerType: 'Candidate',
      confirmedAt: daysFromToday(-30),
      scanStatus: 'skipped',
    },
  });

  const rejected = await prisma.candidate.upsert({
    where: { email: rejectedEmail },
    update: {},
    create: {
      id: uuidv7(),
      name: 'Priyanka Rane',
      email: rejectedEmail,
      phone: '+919812345680',
      source: 'job_board',
      resumeFileId: rejectedResume.id,
      status: 'active',
      poolEligible: true,
      createdById: users.hr!.id,
    },
  });
  await prisma.fileObject.update({
    where: { id: rejectedResume.id },
    data: { ownerId: rejected.id },
  });

  const rejectedApplication = await prisma.application.findUnique({
    where: {
      candidateId_positionId: { candidateId: rejected.id, positionId: seededPosition.id },
    },
  });
  if (!rejectedApplication) {
    await prisma.application.create({
      data: {
        id: uuidv7(),
        candidateId: rejected.id,
        positionId: seededPosition.id,
        status: 'rejected_screening',
        screeningNotes: 'Pleasant call; strong on fundamentals.',
        rejectionReason: 'Wants a Java cohort; this one is React end to end.',
        screenedAt: daysFromToday(-9),
        screenedById: users.hr!.id,
        createdById: users.hr!.id,
      },
    });
  }

  // ------------------------------------------------------- exit and re-use
  //
  // One person who has already left — re-hire eligible, so they surface in the
  // Talent Pool — and one deboarding still in progress with an unreturned
  // laptop, so the completion rule has something real to block on.

  const alumnusUser = await prisma.user.upsert({
    where: { email: 'rohit.varma@managedops.local' },
    update: {},
    create: {
      id: uuidv7(),
      name: 'Rohit Varma',
      email: 'rohit.varma@managedops.local',
      phone: '+919800000099',
      role: 'trainer',
      // Their login stopped working the day their deboarding completed.
      status: 'disabled',
      passwordHash,
      mustChangePassword: false,
    },
  });

  const alumnus = await prisma.trainer.upsert({
    where: { userId: alumnusUser.id },
    update: {},
    create: {
      id: uuidv7(),
      userId: alumnusUser.id,
      employeeCode: `MO-${TODAY.getUTCFullYear()}-0099`,
      personalEmail: 'rohit.varma@managedops.local',
      phone: '+919800000099',
      joiningDate: dateOnly(daysFromToday(-400)),
      salaryAnnual: new Prisma.Decimal(680000),
      status: 'deboarded',
      onboardingHrId: users.hr?.id,
      rehireEligible: true,
      documentsCompletedAt: daysFromToday(-399),
    },
  });

  const alumnusAssignment =
    (await prisma.assignment.findFirst({ where: { trainerId: alumnus.id } })) ??
    (await prisma.assignment.create({
      data: {
        id: uuidv7(),
        trainerId: alumnus.id,
        projectId: project.id,
        role: 'trainer',
        startDate: dateOnly(daysFromToday(-400)),
        endDate: dateOnly(daysFromToday(-120)),
        status: 'ended',
        leaveAllowanceDays: new Prisma.Decimal(3),
        createdById: users.manager!.id,
      },
    }));

  const completed = await prisma.deboarding.findUnique({
    where: { assignmentId: alumnusAssignment.id },
  });
  if (!completed) {
    await prisma.deboarding.create({
      data: {
        id: uuidv7(),
        assignmentId: alumnusAssignment.id,
        initiatedById: users.hr!.id,
        lastWorkingDay: dateOnly(daysFromToday(-120)),
        reason: 'Term ended and the client did not renew the second cohort.',
        status: 'completed',
        assetsReconciled: true,
        fnfStatus: 'settled',
        fnfAmount: new Prisma.Decimal('48200.00'),
        fnfSettledAt: daysFromToday(-115),
        feedback: 'Strong on delivery, would take again for a Java cohort.',
        completedAt: daysFromToday(-115),
      },
    });
  }

  // In progress, and blocked: Karan still holds the Dell laptop.
  if (leadAssignment) {
    const open = await prisma.deboarding.findUnique({
      where: { assignmentId: leadAssignment.id },
    });
    if (!open) {
      await prisma.deboarding.create({
        data: {
          id: uuidv7(),
          assignmentId: leadAssignment.id,
          initiatedById: users.hr!.id,
          lastWorkingDay: dateOnly(daysFromToday(21)),
          reason: 'Moving to a client-side role at the end of the term.',
          status: 'assets_pending',
          assetsReconciled: false,
          fnfStatus: 'pending',
        },
      });
      await prisma.trainer.update({
        where: { id: leadTrainer!.trainerId },
        data: { status: 'deboarding' },
      });
    }
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
      `${candidateSeeds.length} candidates applied to "${seededPosition.title}", ` +
      `1 past trainer in the Talent Pool.`,
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
