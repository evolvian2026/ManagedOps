import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DOCUMENT_LABELS, DOCUMENT_REMINDER_HOURS } from '@managedops/shared';
import { DocumentsService } from '../modules/workforce/documents.service.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';

/**
 * The onboarding document chase.
 *
 * Two stages, and neither of them locks anyone out (spec 15.7): the 24-hour
 * reminder nudges the trainer, and the 72-hour one escalates to the HR who
 * onboarded them, because by then somebody needs to pick up the phone.
 *
 * `documentReminderStage` records what has already gone out, so a retry of the
 * daily job cannot send the same reminder twice.
 */
@Injectable()
export class OnboardingJobs {
  private readonly logger = new Logger(OnboardingJobs.name);

  constructor(
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async sendDocumentReminders(now = new Date()): Promise<number> {
    const due = await this.documents.dueForReminder(now);
    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');
    const [firstHours, secondHours] = DOCUMENT_REMINDER_HOURS;

    for (const { trainer, stage } of due) {
      const progress = await this.documents.progress(trainer.id);
      // Completed between the query and here — nothing to chase.
      if (progress.complete) continue;

      const outstanding = progress.missing.join(', ');

      await this.notifications.notify({
        userIds: [trainer.user.id],
        type: 'document_reminder',
        title: 'Your documents are still outstanding',
        body: `Still needed: ${outstanding}.`,
        entityType: 'Trainer',
        entityId: trainer.id,
        email: {
          to: trainer.personalEmail,
          subject: 'ManagedOps — your documents are still outstanding',
          text:
            `Hello ${trainer.user.name},\n\n` +
            `We still need the following before your onboarding is complete:\n` +
            `  ${outstanding}\n\n` +
            `Upload them from your profile: ${webBaseUrl}/my/profile\n\n` +
            `You can keep using ManagedOps in the meantime — this is a reminder, not a lock-out.\n`,
        },
        // The one message most likely to be missed by email: a new joiner has
        // barely used the work address we made for them.
        mobile: {
          template: 'documents_outstanding',
          values: { name: trainer.user.name, outstanding },
        },
      });

      if (stage === 2 && trainer.onboardingHrId) {
        await this.notifications.notify({
          userIds: [trainer.onboardingHrId],
          type: 'document_escalation',
          title: 'Onboarding documents overdue',
          body: `${trainer.user.name} has been onboarding for over ${secondHours} hours and still owes: ${outstanding}.`,
          entityType: 'Trainer',
          entityId: trainer.id,
        });
      }

      await this.documents.markReminderSent(trainer.id, stage);
    }

    if (due.length > 0) {
      this.logger.log(
        { count: due.length, firstHours, secondHours },
        'Sent onboarding document reminders',
      );
    }
    return due.length;
  }

  /**
   * The document renewal chase.
   *
   * Two stages, mirroring the onboarding chase above: a month out the trainer
   * hears about it, and once it has lapsed HR does too — because an expired
   * police verification is not the trainer's problem alone, it is the reason a
   * client turns somebody away at the door.
   *
   * `expiryReminderStage` records what has gone out, so the daily job cannot
   * send the same reminder twice; uploading a replacement resets it, so the new
   * document gets chased in its turn.
   */
  async sendExpiryReminders(now = new Date()): Promise<number> {
    const due = await this.documents.dueForExpiryReminder(now);
    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');

    for (const { document, validity, stage } of due) {
      const label = DOCUMENT_LABELS[document.docType] ?? document.docType;
      const { trainer } = document;
      const expired = validity.state === 'expired';

      await this.notifications.notify({
        userIds: [trainer.user.id],
        type: 'document_expiry',
        title: expired ? `Your ${label} has expired` : `Your ${label} expires soon`,
        body: validity.message ?? '',
        entityType: 'Trainer',
        entityId: trainer.id,
        email: {
          to: trainer.personalEmail,
          subject: `ManagedOps — your ${label} ${expired ? 'has expired' : 'expires soon'}`,
          text:
            `Hello ${trainer.user.name},\n\n` +
            `${validity.message}\n\n` +
            `Upload the renewed document from your profile: ${webBaseUrl}/my/profile\n\n` +
            (expired
              ? `A client may refuse you access to site until this is current again.\n`
              : `Renewing it before it lapses saves everyone the scramble.\n`),
        },
        // Two registered templates, picked on the fact. `daysRemaining` goes
        // negative once a document has lapsed, so the count is taken as a
        // magnitude and the tense comes from the template.
        mobile: {
          template: expired ? 'document_expired' : 'document_expiring',
          values: {
            name: trainer.user.name,
            document: label.toLowerCase(),
            days: String(Math.abs(validity.daysRemaining ?? 0)),
          },
        },
      });

      // Only once it has actually lapsed. Escalating a month early would train
      // HR to ignore the message that matters.
      if (expired && trainer.onboardingHrId) {
        await this.notifications.notify({
          userIds: [trainer.onboardingHrId],
          type: 'document_expiry_escalation',
          title: `${label} expired`,
          body: `${trainer.user.name}'s ${label} ${validity.message?.toLowerCase() ?? 'has expired'} It needs replacing before they are put on a client site.`,
          entityType: 'Trainer',
          entityId: trainer.id,
        });
      }

      await this.documents.markExpiryReminderSent(document.id, stage);
    }

    if (due.length > 0) {
      this.logger.log({ count: due.length }, 'Sent document expiry reminders');
    }
    return due.length;
  }
}
