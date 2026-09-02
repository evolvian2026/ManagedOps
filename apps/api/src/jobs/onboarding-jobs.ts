import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DOCUMENT_REMINDER_HOURS } from '@managedops/shared';
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
}
