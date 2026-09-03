import { Injectable } from '@nestjs/common';
import {
  DOCUMENT_EXPIRY_WARNING_DAYS,
  DOCUMENT_LABELS,
  DOCUMENT_REMINDER_HOURS,
  EXPIRING_DOCUMENT_TYPES,
  MANDATORY_TRAINER_DOCUMENTS,
  can,
  documentValidity,
  toIstDateString,
  type DocumentExpiryQuery,
  type DocumentProgress,
  type UploadDocumentInput,
  type VerifyDocumentInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import { scopedWhere, trainerScope } from '../../common/scope.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';
import { TrainersService } from './trainers.service.js';

/** What the expiry queue may be ordered by. */
const EXPIRY_SORTABLE = ['expiresOn', 'docType', 'updatedAt'] as const;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly trainers: TrainersService,
  ) {}

  /**
   * The checklist for one trainer.
   *
   * A Manager or Project Lead may see that a document exists and whether it has
   * been verified; opening it is HR's business (spec 3.3). So the file id — the
   * key that opens it — is withheld from a caller without
   * `trainers.read_documents`, and `hasFile` carries the fact separately.
   * Returning the id and relying on the download endpoint to refuse would put
   * the whole defence in one place, and that place used to have a hole in it.
   */
  async list(trainerId: string, user: AuthenticatedUser) {
    await this.requireVisibleTrainer(trainerId, user);

    const documents = await this.prisma.db.trainerDocument.findMany({
      where: { trainerId },
      select: {
        id: true,
        docType: true,
        status: true,
        lastFour: true,
        fileId: true,
        rejectReason: true,
        verifiedAt: true,
        verifiedBy: { select: { id: true, name: true } },
        expiresOn: true,
        updatedAt: true,
      },
      orderBy: { docType: 'asc' },
    });

    const mayOpen = user.trainerId === trainerId || can(user.role, 'trainers.read_documents');

    return {
      data: documents.map(({ fileId, expiresOn, ...document }) => ({
        ...document,
        expiresOn: expiresOn ? toIstDateString(expiresOn) : null,
        // Derived on every read rather than stored: a saved "valid" becomes a
        // lie the moment the calendar moves past it, and nothing would notice.
        validity: documentValidity(document.docType, expiresOn ? toIstDateString(expiresOn) : null),
        // Whether something was uploaded is not the same question as whether
        // this caller may read it, so the two are answered separately.
        hasFile: fileId !== null,
        fileId: mayOpen ? fileId : null,
      })),
      progress: await this.progress(trainerId),
    };
  }

  /**
   * A trainer uploading their own document, or HR uploading on their behalf
   * when a scan arrives by email.
   *
   * Re-uploading replaces the file and returns the row to `pending`: a rejected
   * document that stayed rejected after a corrected scan would be a dead end.
   */
  async upload(trainerId: string, input: UploadDocumentInput, actor: AuthenticatedUser) {
    await this.requireVisibleTrainer(trainerId, actor);
    this.assertMayUpload(trainerId, actor);
    await this.files.requireConfirmed(input.fileId);

    const existing = await this.prisma.db.trainerDocument.findUnique({
      where: { trainerId_docType: { trainerId, docType: input.docType } },
    });

    if (existing?.status === 'verified') {
      throw new DomainRuleProblem(
        'document-already-verified',
        `Your ${DOCUMENT_LABELS[input.docType] ?? input.docType} has already been verified. Ask HR if it needs replacing.`,
      );
    }

    const document = await this.prisma.db.trainerDocument.upsert({
      where: { trainerId_docType: { trainerId, docType: input.docType } },
      update: {
        fileId: input.fileId,
        lastFour: input.lastFour ?? existing?.lastFour ?? null,
        status: 'pending',
        rejectReason: null,
        verifiedById: null,
        verifiedAt: null,
        expiresOn: input.expiresOn ? new Date(`${input.expiresOn}T00:00:00.000Z`) : null,
        // A renewal is a fresh document, so the chase starts again. Leaving the
        // stage where it was would mean the replacement never got a reminder.
        expiryReminderStage: 0,
      },
      create: {
        id: newId(),
        trainerId,
        docType: input.docType,
        fileId: input.fileId,
        lastFour: input.lastFour,
        status: 'pending',
        expiresOn: input.expiresOn ? new Date(`${input.expiresOn}T00:00:00.000Z`) : null,
      },
      select: {
        id: true,
        docType: true,
        status: true,
        lastFour: true,
        fileId: true,
        expiresOn: true,
      },
    });

    await this.files.attach(input.fileId, 'TrainerDocument', document.id);

    // The onboarding HR is who chases this, so they are who hears about it.
    const trainer = await this.prisma.db.trainer.findUnique({
      where: { id: trainerId },
      select: { onboardingHrId: true, user: { select: { name: true } } },
    });
    if (trainer?.onboardingHrId) {
      await this.notifications.notify({
        userIds: [trainer.onboardingHrId],
        type: 'document_reminder',
        title: 'Document uploaded',
        body: `${trainer.user.name} uploaded their ${DOCUMENT_LABELS[input.docType] ?? input.docType}. It is waiting to be verified.`,
        entityType: 'Trainer',
        entityId: trainerId,
      });
    }

    return { ...document, progress: await this.progress(trainerId) };
  }

  /**
   * HR's verification decision. Verifying the last mandatory document is what
   * makes a trainer active, so the trainer's status is refreshed from here
   * rather than left for somebody to set by hand.
   */
  async verify(
    trainerId: string,
    documentId: string,
    input: VerifyDocumentInput,
    actor: AuthenticatedUser,
  ) {
    const document = await this.prisma.db.trainerDocument.findFirst({
      where: { id: documentId, trainerId },
      include: { trainer: { select: { userId: true, user: { select: { name: true } } } } },
    });
    if (!document) throw new NotFoundProblem('That document');

    if (!document.fileId) {
      throw new DomainRuleProblem(
        'nothing-to-verify',
        `Nothing has been uploaded for the ${DOCUMENT_LABELS[document.docType] ?? document.docType} yet.`,
      );
    }

    const updated = await this.prisma.db.trainerDocument.update({
      where: { id: documentId },
      data: {
        status: input.decision,
        rejectReason: input.decision === 'rejected' ? input.rejectReason : null,
        verifiedById: actor.userId,
        verifiedAt: new Date(),
      },
      select: { id: true, docType: true, status: true, rejectReason: true },
    });

    await this.trainers.refreshOnboardingState(trainerId);

    const label = DOCUMENT_LABELS[document.docType] ?? document.docType;
    await this.notifications.notify({
      userIds: [document.trainer.userId],
      type: input.decision === 'rejected' ? 'document_rejected' : 'document_reminder',
      title: input.decision === 'rejected' ? 'A document needs re-uploading' : 'Document verified',
      body:
        input.decision === 'rejected'
          ? `Your ${label} was not accepted: ${input.rejectReason}`
          : `Your ${label} has been verified.`,
      entityType: 'Trainer',
      entityId: trainerId,
    });

    return { ...updated, progress: await this.progress(trainerId) };
  }

  /**
   * How far through the checklist a trainer is. Everything the onboarding
   * banner and the reminder job need, computed from the documents themselves so
   * there is no second copy of "are they done yet" to fall out of step.
   */
  async progress(trainerId: string): Promise<DocumentProgress> {
    const [trainer, documents] = await Promise.all([
      this.prisma.db.trainer.findUnique({
        where: { id: trainerId },
        select: { createdAt: true },
      }),
      this.prisma.db.trainerDocument.findMany({
        where: { trainerId },
        select: { docType: true, status: true, fileId: true },
      }),
    ]);

    const byType = new Map(documents.map((doc) => [doc.docType, doc]));
    const missing = MANDATORY_TRAINER_DOCUMENTS.filter((docType) => {
      const doc = byType.get(docType);
      return !doc || !doc.fileId || doc.status === 'rejected';
    });

    const mandatory = documents.filter((doc) =>
      MANDATORY_TRAINER_DOCUMENTS.includes(
        doc.docType as (typeof MANDATORY_TRAINER_DOCUMENTS)[number],
      ),
    );

    return {
      required: MANDATORY_TRAINER_DOCUMENTS.length,
      verified: mandatory.filter((doc) => doc.status === 'verified').length,
      pending: mandatory.filter((doc) => doc.status === 'pending' && doc.fileId).length,
      rejected: mandatory.filter((doc) => doc.status === 'rejected').length,
      missing: missing.map((docType) => DOCUMENT_LABELS[docType] ?? docType),
      complete: missing.length === 0,
      hoursSinceCreated: trainer
        ? Math.floor((Date.now() - trainer.createdAt.getTime()) / 3_600_000)
        : 0,
    };
  }

  /**
   * Trainers still missing a document past a reminder threshold.
   *
   * `documentReminderStage` records which reminders have already gone out, so a
   * retry of the daily job cannot send the same one twice. The stages are a
   * target with escalation, not a lock-out (spec 15.7).
   */
  async dueForReminder(now: Date) {
    const [firstHours, secondHours] = DOCUMENT_REMINDER_HOURS;

    const candidates = await this.prisma.db.trainer.findMany({
      where: { status: 'pending_onboarding', documentsCompletedAt: null },
      select: {
        id: true,
        createdAt: true,
        documentReminderStage: true,
        onboardingHrId: true,
        personalEmail: true,
        user: { select: { id: true, name: true } },
      },
      take: 200,
    });

    type Due = { trainer: (typeof candidates)[number]; stage: 1 | 2 };

    return candidates.flatMap<Due>((trainer) => {
      const hours = (now.getTime() - trainer.createdAt.getTime()) / 3_600_000;
      // Stage 2 is the escalation to HR; stage 1 is the trainer's own nudge.
      if (hours >= secondHours && trainer.documentReminderStage < 2) {
        return [{ trainer, stage: 2 }];
      }
      if (hours >= firstHours && trainer.documentReminderStage < 1) {
        return [{ trainer, stage: 1 }];
      }
      return [];
    });
  }

  async markReminderSent(trainerId: string, stage: number): Promise<void> {
    await this.prisma.db.trainer.update({
      where: { id: trainerId },
      data: { documentReminderStage: stage },
    });
  }

  /* ------------------------------------------------------------ internals */

  private async requireVisibleTrainer(trainerId: string, user: AuthenticatedUser) {
    const trainer = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(user), { id: trainerId }),
      select: { id: true },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');
    return trainer;
  }

  /**
   * A trainer uploads their own documents; HR uploads on anyone's behalf. A
   * project lead can see their team but has no business handling their
   * identity documents, which is why this checks the capability rather than
   * assuming visibility implies permission.
   */
  private assertMayUpload(trainerId: string, actor: AuthenticatedUser): void {
    if (can(actor.role, 'trainers.verify_documents')) return;
    if (can(actor.role, 'trainers.upload_documents') && actor.trainerId === trainerId) return;

    throw new ForbiddenProblem('You can only upload your own documents.');
  }

  /**
   * The documents that are lapsing, across everybody the caller may see.
   *
   * Scoped through the trainer, so a project lead sees their own team and a
   * trainer sees themselves. The file id is withheld exactly as it is on the
   * checklist — knowing that somebody's police verification runs out next week
   * is a different question from being allowed to open it.
   */
  async expiring(query: DocumentExpiryQuery, user: AuthenticatedUser) {
    const today = toIstDateString(new Date());
    const horizon = new Date(`${today}T00:00:00.000Z`);
    horizon.setUTCDate(horizon.getUTCDate() + DOCUMENT_EXPIRY_WARNING_DAYS);

    // Anything of a lapsing type that is either undated or inside the window.
    // Filtering in SQL rather than reading every document and discarding most.
    const where = scopedWhere(
      { trainer: trainerScope(user) },
      {
        docType: { in: [...EXPIRING_DOCUMENT_TYPES] },
        ...(query.projectId
          ? { trainer: { assignments: { some: { projectId: query.projectId } } } }
          : {}),
        ...(query.state === 'missing_date'
          ? { expiresOn: null }
          : query.state === 'expired'
            ? { expiresOn: { lt: new Date(`${today}T00:00:00.000Z`) } }
            : query.state === 'expiring_soon'
              ? { expiresOn: { gte: new Date(`${today}T00:00:00.000Z`), lte: horizon } }
              : {
                  OR: [{ expiresOn: null }, { expiresOn: { lte: horizon } }],
                }),
      },
    );

    const page = toPrismaPage(query, EXPIRY_SORTABLE, { expiresOn: 'asc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.trainerDocument.findMany({
        where,
        ...page,
        select: {
          id: true,
          docType: true,
          status: true,
          expiresOn: true,
          fileId: true,
          trainer: {
            select: {
              id: true,
              employeeCode: true,
              status: true,
              user: { select: { name: true, email: true } },
              assignments: {
                where: { status: 'active' },
                select: { project: { select: { id: true, name: true } } },
              },
            },
          },
        },
      }),
      this.prisma.db.trainerDocument.count({ where }),
    ]);

    const mayOpen = can(user.role, 'trainers.read_documents');

    return paginate(
      rows.map(({ fileId, expiresOn, trainer, ...document }) => ({
        ...document,
        expiresOn: expiresOn ? toIstDateString(expiresOn) : null,
        validity: documentValidity(
          document.docType,
          expiresOn ? toIstDateString(expiresOn) : null,
          { today },
        ),
        hasFile: fileId !== null,
        fileId: mayOpen || user.trainerId === trainer.id ? fileId : null,
        trainer: {
          id: trainer.id,
          employeeCode: trainer.employeeCode,
          status: trainer.status,
          name: trainer.user.name,
          projects: [...new Set(trainer.assignments.map((a) => a.project.name))],
        },
      })),
      total,
      query,
    );
  }

  /**
   * Documents due an expiry reminder, with the stage that is owed.
   *
   * Stage 1 goes out a month ahead and stage 2 once it has lapsed. The stage
   * already recorded is what stops a daily job sending the same one every day,
   * and a replaced document has it reset so the new one gets chased too.
   */
  async dueForExpiryReminder(now = new Date()) {
    const today = toIstDateString(now);
    const horizon = new Date(`${today}T00:00:00.000Z`);
    horizon.setUTCDate(horizon.getUTCDate() + DOCUMENT_EXPIRY_WARNING_DAYS);

    const rows = await this.prisma.db.trainerDocument.findMany({
      where: {
        docType: { in: [...EXPIRING_DOCUMENT_TYPES] },
        expiresOn: { not: null, lte: horizon },
        // Somebody who has left is not chased about a certificate.
        trainer: { status: { in: ['active', 'pending_onboarding'] }, deletedAt: null },
      },
      select: {
        id: true,
        docType: true,
        expiresOn: true,
        expiryReminderStage: true,
        trainer: {
          select: {
            id: true,
            personalEmail: true,
            onboardingHrId: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    return rows
      .map((row) => {
        const validity = documentValidity(row.docType, toIstDateString(row.expiresOn!), { today });
        const owed = validity.state === 'expired' ? 2 : validity.state === 'expiring_soon' ? 1 : 0;
        return { document: row, validity, stage: owed };
      })
      .filter((entry) => entry.stage > entry.document.expiryReminderStage);
  }

  async markExpiryReminderSent(documentId: string, stage: number) {
    await this.prisma.db.trainerDocument.update({
      where: { id: documentId },
      data: { expiryReminderStage: stage },
    });
  }
}
