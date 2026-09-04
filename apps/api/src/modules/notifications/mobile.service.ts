import { Injectable, Logger } from '@nestjs/common';
import {
  MOBILE_CHANNELS,
  MOBILE_TEMPLATES,
  maskMobile,
  normaliseIndianMobile,
  type MobileChannel,
  type MobileTemplateId,
  type NotificationType,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { MessagingProvider } from './messaging.provider.js';

export interface MobileIntent {
  readonly template: MobileTemplateId;
  /** Values for the template's declared parameters. Rendering checks them. */
  readonly values: Readonly<Record<string, string>>;
}

interface Recipient {
  readonly id: string;
  readonly phone: string | null;
  readonly mobileNotifications: boolean;
}

/**
 * Getting a message onto somebody's phone, and recording what happened.
 *
 * The caller says *what* to send and to which users. Everything else is decided
 * here: whether there is a number, whether they have opted out, which channel
 * to try, and what to do when one fails. Putting that at the call sites would
 * mean twenty copies of the same four checks, and the one that got it wrong
 * would be the one that mattered.
 */
@Injectable()
export class MobileMessageService {
  private readonly logger = new Logger(MobileMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: MessagingProvider,
  ) {}

  /**
   * Never throws, and never fails the request that triggered it.
   *
   * A leave decision is recorded whether or not the message about it goes out;
   * the alternative is a provider outage rolling back approvals. Failures land
   * in `message_deliveries`, which is the record to chase them from.
   */
  async send(
    userIds: readonly string[],
    intent: MobileIntent,
    context: { notificationType: NotificationType; entityType?: string; entityId?: string },
  ): Promise<void> {
    const recipients = await this.resolve(userIds);

    for (const recipient of recipients) {
      try {
        await this.sendToOne(recipient, intent, context);
      } catch (error) {
        // Belt and braces: a fault here must not escape into the caller.
        this.logger.error({ err: error, userId: recipient.id }, 'Mobile send failed unexpectedly');
      }
    }
  }

  private async sendToOne(
    recipient: Recipient,
    intent: MobileIntent,
    context: { notificationType: NotificationType; entityType?: string; entityId?: string },
  ): Promise<void> {
    const number = normaliseIndianMobile(recipient.phone);

    // Two different skips, recorded apart, because they call for different
    // action: one is a number to collect, the other is a choice to respect.
    if (!number) {
      await this.record(recipient, intent, context, MOBILE_CHANNELS[0], {
        status: 'skipped',
        toMasked: '+91 ••••••0000',
        error: 'No usable mobile number on file',
      });
      return;
    }
    if (!recipient.mobileNotifications) {
      await this.record(recipient, intent, context, MOBILE_CHANNELS[0], {
        status: 'skipped',
        toMasked: maskMobile(number),
        error: 'Opted out of messages to their phone',
      });
      return;
    }

    // WhatsApp first: it is cheaper, it is where these trainers already are,
    // and it can carry more than 160 characters. SMS is the fallback rather
    // than the default because it costs more and says less — but it arrives on
    // a phone with no app and no data, which is exactly when the first fails.
    for (const channel of MOBILE_CHANNELS) {
      const outcome = await this.provider.send(channel, {
        to: number,
        template: intent.template,
        values: intent.values,
      });

      await this.record(recipient, intent, context, channel, {
        status: outcome.sent ? 'sent' : 'failed',
        toMasked: maskMobile(number),
        providerMessageId: outcome.providerMessageId,
        error: outcome.error,
      });

      if (outcome.sent) return;
    }

    this.logger.warn(
      { userId: recipient.id, template: intent.template },
      'Every mobile channel refused the message',
    );
  }

  private async resolve(userIds: readonly string[]): Promise<Recipient[]> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return [];
    return this.prisma.db.user.findMany({
      where: { id: { in: unique }, status: 'active' },
      select: { id: true, phone: true, mobileNotifications: true },
    });
  }

  private async record(
    recipient: Recipient,
    intent: MobileIntent,
    context: { notificationType: NotificationType; entityType?: string; entityId?: string },
    channel: MobileChannel,
    outcome: {
      status: 'sent' | 'failed' | 'skipped';
      toMasked: string;
      providerMessageId?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.prisma.db.messageDelivery.create({
      data: {
        id: newId(),
        userId: recipient.id,
        channel,
        status: outcome.status,
        // The registered name rather than our key for it: when a provider
        // rejects a template, that is the name in their console.
        template: MOBILE_TEMPLATES[intent.template].name,
        toMasked: outcome.toMasked,
        providerMessageId: outcome.providerMessageId ?? null,
        error: outcome.error ?? null,
        notificationType: context.notificationType,
        entityType: context.entityType ?? null,
        entityId: context.entityId ?? null,
      },
    });
  }
}
