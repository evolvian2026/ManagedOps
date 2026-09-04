import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  MANDATORY_TRAINER_DOCUMENTS,
  assertTransition,
  type ConvertOfferInput,
  type TrainerQuery,
  type UpdateTrainerInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { scopedWhere, trainerScope } from '../../common/scope.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PasswordService } from '../identity/password.service.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { can } from '@managedops/shared';

const SORTABLE = ['createdAt', 'employeeCode', 'joiningDate', 'status'] as const;

/** Everything a roster row or profile header needs, minus anything sensitive. */
const TRAINER_SELECT = {
  id: true,
  employeeCode: true,
  personalEmail: true,
  workEmail: true,
  phone: true,
  joiningDate: true,
  status: true,
  rehireEligible: true,
  documentsCompletedAt: true,
  travelArrivalDate: true,
  travelMode: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, status: true, mustChangePassword: true } },
  onboardingHr: { select: { id: true, name: true } },
} as const;

@Injectable()
export class TrainersService {
  private readonly logger = new Logger(TrainersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async list(query: TrainerQuery, user: AuthenticatedUser) {
    const where = scopedWhere(trainerScope(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId
        ? { assignments: { some: { projectId: query.projectId, status: 'active' as const } } }
        : {}),
      ...(query.documentsPending === 'true' ? { documentsCompletedAt: null } : {}),
      ...(query.documentsPending === 'false' ? { documentsCompletedAt: { not: null } } : {}),
      ...(query.q
        ? {
            OR: [
              { employeeCode: { contains: query.q, mode: 'insensitive' as const } },
              { user: { name: { contains: query.q, mode: 'insensitive' as const } } },
              { personalEmail: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    });

    const page = toPrismaPage(query, SORTABLE);
    const [rows, total] = await Promise.all([
      this.prisma.db.trainer.findMany({
        where,
        ...page,
        select: {
          ...TRAINER_SELECT,
          assignments: {
            where: { status: 'active' },
            select: {
              id: true,
              role: true,
              startDate: true,
              project: { select: { id: true, name: true, code: true } },
            },
          },
          _count: { select: { documents: true } },
        },
      }),
      this.prisma.db.trainer.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  /**
   * One trainer's profile. Salary is included only for a caller who holds
   * `trainers.read_salary` at a scope that covers this person, and reading it
   * is audited — this is the point at which somebody looks at pay.
   */
  async get(id: string, user: AuthenticatedUser) {
    const trainer = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(user), { id }),
      select: {
        ...TRAINER_SELECT,
        candidateId: true,
        travelCost: true,
        assignments: {
          select: {
            id: true,
            role: true,
            status: true,
            startDate: true,
            endDate: true,
            leaveAllowanceDays: true,
            project: {
              select: {
                id: true,
                name: true,
                code: true,
                client: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { startDate: 'desc' },
        },
        documents: {
          select: {
            id: true,
            docType: true,
            status: true,
            lastFour: true,
            fileId: true,
            rejectReason: true,
            verifiedAt: true,
            verifiedBy: { select: { id: true, name: true } },
            updatedAt: true,
          },
        },
      },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');

    const salary = await this.readSalaryIfPermitted(trainer.id, user);
    return { ...trainer, salaryAnnual: salary, documents: this.withChecklist(trainer.documents) };
  }

  async update(id: string, input: UpdateTrainerInput, actor: AuthenticatedUser) {
    const existing = await this.prisma.db.trainer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundProblem('That trainer');

    // Salary is a separate capability from editing a profile.
    if (input.salaryAnnual !== undefined && !can(actor.role, 'trainers.read_salary')) {
      throw new ForbiddenProblem('Your role cannot change salary.');
    }

    return this.prisma.db.trainer.update({
      where: { id },
      data: {
        // The number lives in two places for two reasons — the trainer record
        // is what onboarding captured, the user record is what the messaging
        // layer sends to — so a correction here has to reach both. One updated
        // without the other is a reminder going to somebody's old number.
        ...(input.phone !== undefined
          ? { phone: input.phone, user: { update: { phone: input.phone } } }
          : {}),
        ...(input.personalEmail !== undefined ? { personalEmail: input.personalEmail } : {}),
        ...(input.workEmail !== undefined ? { workEmail: input.workEmail } : {}),
        ...(input.joiningDate !== undefined ? { joiningDate: new Date(input.joiningDate) } : {}),
        ...(input.salaryAnnual !== undefined
          ? { salaryAnnual: new Prisma.Decimal(input.salaryAnnual) }
          : {}),
        ...(input.rehireEligible !== undefined ? { rehireEligible: input.rehireEligible } : {}),
        ...(input.travelArrivalDate !== undefined
          ? { travelArrivalDate: new Date(input.travelArrivalDate) }
          : {}),
        ...(input.travelMode !== undefined ? { travelMode: input.travelMode } : {}),
        ...(input.travelCost !== undefined
          ? { travelCost: new Prisma.Decimal(input.travelCost) }
          : {}),
        updatedById: actor.userId,
      },
      select: TRAINER_SELECT,
    });
  }

  /**
   * Converts an accepted offer into a working trainer.
   *
   * The account, the profile and the credentials are created together: a
   * half-converted hire — a login with no profile, or a profile nobody can sign
   * in to — is worse than a failed conversion, so the whole thing is one
   * transaction. The temporary password exists only in the email; it is never
   * returned to the caller and never written to the logs.
   */
  async convertOffer(offerId: string, input: ConvertOfferInput, actor: AuthenticatedUser) {
    const offer = await this.prisma.db.offer.findUnique({
      where: { id: offerId },
      include: {
        application: {
          include: {
            candidate: true,
            position: { select: { id: true, title: true, projectId: true } },
          },
        },
      },
    });
    if (!offer) throw new NotFoundProblem('That offer');

    if (offer.status !== 'accepted') {
      throw new DomainRuleProblem(
        'offer-not-accepted',
        `This offer is ${offer.status.replace(/_/g, ' ')}. A trainer is created once an offer is accepted.`,
      );
    }

    const { candidate } = offer.application;
    const existing = await this.prisma.db.trainer.findFirst({
      where: { candidateId: candidate.id },
    });
    if (existing) {
      throw new DomainRuleProblem(
        'already-converted',
        `${candidate.name} already has a trainer record (${existing.employeeCode}).`,
      );
    }

    const personalEmail = input.personalEmail ?? candidate.email;
    const loginEmail = personalEmail;

    const emailTaken = await this.prisma.raw.user.findUnique({ where: { email: loginEmail } });
    if (emailTaken) {
      throw new DomainRuleProblem(
        'email-in-use',
        `${loginEmail} already has a ManagedOps account. Give a different personal email for their login.`,
      );
    }

    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const employeeCode = await this.nextEmployeeCode();
    const joiningDate = input.joiningDate ? new Date(input.joiningDate) : offer.joiningDate;
    const projectId = input.projectId ?? offer.application.position.projectId;

    const trainerId = newId();
    const userId = newId();

    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          name: candidate.name,
          email: loginEmail,
          phone: candidate.phone,
          // A lead is a trainer with project oversight; both hold the trainer's
          // own self-service capabilities.
          role: input.assignmentRole === 'lead' ? 'project_lead' : 'trainer',
          passwordHash,
          mustChangePassword: true,
          createdById: actor.userId,
        },
      });

      await tx.trainer.create({
        data: {
          id: trainerId,
          userId,
          candidateId: candidate.id,
          employeeCode,
          personalEmail,
          workEmail: input.workEmail,
          phone: candidate.phone,
          joiningDate,
          salaryAnnual: offer.salaryAnnual,
          status: 'pending_onboarding',
          onboardingHrId: actor.userId,
          createdById: actor.userId,
        },
      });

      // The document checklist is created up front so the trainer sees exactly
      // what is expected of them rather than an empty page.
      await tx.trainerDocument.createMany({
        data: MANDATORY_TRAINER_DOCUMENTS.map((docType) => ({
          id: newId(),
          trainerId,
          docType,
          status: 'pending' as const,
        })),
      });

      if (projectId) {
        await tx.assignment.create({
          data: {
            id: newId(),
            trainerId,
            projectId,
            role: input.assignmentRole,
            startDate: joiningDate,
            status: 'active',
            leaveAllowanceDays: new Prisma.Decimal(3),
            createdById: actor.userId,
          },
        });
      }

      await tx.candidate.update({
        where: { id: candidate.id },
        data: { status: 'hired', poolEligible: false, workedBefore: true },
      });
    });

    // Sent after the transaction commits: emailing credentials for a hire that
    // then failed to save would be worse than a missing email.
    await this.sendCredentials(userId, candidate.name, personalEmail, temporaryPassword);

    await this.audit.record({
      actorUserId: actor.userId,
      action: 'TRAINER_CREATED',
      entityType: 'Trainer',
      entityId: trainerId,
      after: { employeeCode, offerId, candidateId: candidate.id },
    });

    return this.prisma.db.trainer.findUniqueOrThrow({
      where: { id: trainerId },
      select: TRAINER_SELECT,
    });
  }

  /**
   * Promotes a trainer to active once every mandatory document is verified and
   * they have somewhere to work. Called after each document verification, so the
   * status follows the facts rather than needing anyone to remember to set it.
   */
  async refreshOnboardingState(trainerId: string): Promise<void> {
    const trainer = await this.prisma.db.trainer.findUnique({
      where: { id: trainerId },
      include: {
        documents: { select: { docType: true, status: true } },
        assignments: { where: { status: 'active' }, select: { id: true } },
      },
    });
    if (!trainer || trainer.status !== 'pending_onboarding') return;

    const verified = new Set(
      trainer.documents.filter((doc) => doc.status === 'verified').map((doc) => doc.docType),
    );
    const complete = MANDATORY_TRAINER_DOCUMENTS.every((docType) => verified.has(docType));
    if (!complete) return;

    await this.prisma.db.trainer.update({
      where: { id: trainerId },
      data: { documentsCompletedAt: new Date() },
    });

    if (trainer.assignments.length === 0) return;

    assertTransition('trainer', trainer.status, 'active');
    await this.prisma.db.trainer.update({ where: { id: trainerId }, data: { status: 'active' } });
    this.logger.log({ trainerId }, 'Trainer onboarding complete');
  }

  /** Re-issues a temporary password when the first email never arrived. */
  async resendCredentials(id: string, actor: AuthenticatedUser) {
    const trainer = await this.prisma.db.trainer.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');

    const temporaryPassword = this.passwords.generateTemporary();
    await this.prisma.db.user.update({
      where: { id: trainer.userId },
      data: {
        passwordHash: await this.passwords.hash(temporaryPassword),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedById: actor.userId,
      },
    });

    await this.sendCredentials(
      trainer.userId,
      trainer.user.name,
      trainer.personalEmail,
      temporaryPassword,
    );
    return {
      id,
      message: `A new temporary password has been emailed to ${trainer.personalEmail}.`,
    };
  }

  /** The signed-in trainer's own record, for the self-service screens. */
  async me(user: AuthenticatedUser) {
    if (!user.trainerId) {
      throw new NotFoundProblem('A trainer profile for this account');
    }
    return this.get(user.trainerId, user);
  }

  /* ------------------------------------------------------------ internals */

  /**
   * `MO-2026-0001`, sequential within the year (spec assumption A16). Derived
   * from the highest existing code rather than a counter, so it stays correct
   * if records are ever imported.
   */
  private async nextEmployeeCode(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `MO-${year}-`;

    const latest = await this.prisma.raw.trainer.findFirst({
      where: { employeeCode: { startsWith: prefix } },
      orderBy: { employeeCode: 'desc' },
      select: { employeeCode: true },
    });

    const sequence = latest ? Number(latest.employeeCode.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  private async readSalaryIfPermitted(
    trainerId: string,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    if (!can(user.role, 'trainers.read_salary')) return null;

    // A trainer or lead holds this at 'own' scope: their own pay, nobody else's.
    const scope = scopedWhere(trainerScope(user, 'trainers.read_salary'), { id: trainerId });
    const row = await this.prisma.db.trainer.findFirst({
      where: scope,
      select: { salaryAnnual: true },
    });
    if (!row?.salaryAnnual) return null;

    await this.audit.recordSensitiveRead({
      actorUserId: user.userId,
      entityType: 'Trainer',
      entityId: trainerId,
      field: 'salaryAnnual',
    });
    return row.salaryAnnual.toString();
  }

  private withChecklist(documents: { docType: string; status: string }[]) {
    // Optional documents only exist once uploaded; mandatory ones always show,
    // so the checklist is the same list for everyone.
    return documents.map((doc) => ({
      ...doc,
      mandatory: MANDATORY_TRAINER_DOCUMENTS.includes(
        doc.docType as (typeof MANDATORY_TRAINER_DOCUMENTS)[number],
      ),
    }));
  }

  /**
   * The one message a new joiner cannot afford to miss.
   *
   * Routed through `notify` rather than straight to the mailer so all three
   * channels come from one place: the password goes by email, where it is at
   * least addressed to one inbox, and the phone gets only a nudge to go and
   * read it. This is also what finally emits `credentials_issued`, which was a
   * notification type nothing raised.
   */
  private async sendCredentials(
    userId: string,
    name: string,
    email: string,
    temporaryPassword: string,
  ): Promise<void> {
    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');
    await this.notifications.notify({
      userIds: [userId],
      type: 'credentials_issued',
      title: 'Your ManagedOps account is ready',
      body: 'Your sign-in details have been emailed to you.',
      entityType: 'User',
      entityId: userId,
      email: {
        to: email,
        subject: 'Welcome to ManagedOps — your account',
        text:
          `Hello ${name},\n\n` +
          `Welcome aboard. Your ManagedOps account is ready.\n\n` +
          `Sign in at: ${webBaseUrl}\n` +
          `Email: ${email}\n` +
          `Temporary password: ${temporaryPassword}\n\n` +
          `You will be asked to choose your own password the first time you sign in.\n` +
          `After that, please upload your documents — the checklist is on your profile.\n`,
      },
      mobile: { template: 'account_ready', values: { name } },
    });
  }
}
