import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MOBILE_TEMPLATES,
  mobileTemplateValues,
  renderMobileTemplate,
  type MobileChannel,
  type MobileTemplateId,
} from '@managedops/shared';

export interface OutboundMessage {
  /** E.164, already normalised — nothing below this layer re-parses a number. */
  readonly to: string;
  readonly template: MobileTemplateId;
  readonly values: Readonly<Record<string, string>>;
}

export interface SendOutcome {
  readonly sent: boolean;
  readonly providerMessageId?: string;
  readonly error?: string;
}

/**
 * One interface over both mobile channels.
 *
 * WhatsApp takes a registered template name and positional parameters; an
 * Indian SMS route takes the rendered text of a template registered under DLT.
 * Same catalogue entry, two shapes — which is exactly why the catalogue holds
 * both the parameter order and the wording.
 */
export abstract class MessagingProvider {
  abstract readonly name: string;
  abstract send(channel: MobileChannel, message: OutboundMessage): Promise<SendOutcome>;
}

/**
 * The development transport: renders the message and logs it, the way Mailpit
 * catches email locally.
 *
 * It is not a stub that always succeeds. A number in the reserved 6000 test
 * range fails, so the fallback from WhatsApp to SMS and the failure recording
 * are exercised by the same code path that runs in production rather than by a
 * mock that only exists in the test suite.
 */
@Injectable()
export class LogMessagingProvider extends MessagingProvider {
  readonly name = 'log';
  private readonly logger = new Logger('MobileMessage');

  send(channel: MobileChannel, message: OutboundMessage): Promise<SendOutcome> {
    const text = renderMobileTemplate(message.template, message.values);

    if (isReservedFailureNumber(message.to, channel)) {
      return Promise.resolve({
        sent: false,
        error: `${channel} rejected the message (test number)`,
      });
    }

    this.logger.log(
      { channel, to: message.to, template: MOBILE_TEMPLATES[message.template].name, text },
      'Mobile message',
    );
    return Promise.resolve({ sent: true, providerMessageId: `log-${channel}-${Date.now()}` });
  }
}

/**
 * Numbers reserved for exercising failure locally, the way card networks reserve
 * a decline card. `+9160000000xx` fails on WhatsApp only, so a test can drive
 * the fallback; `+9160000001xx` fails on both.
 */
function isReservedFailureNumber(to: string, channel: MobileChannel): boolean {
  if (to.startsWith('+9160000001')) return true;
  return channel === 'whatsapp' && to.startsWith('+9160000000');
}

interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  smsFrom?: string;
  whatsappFrom?: string;
}

/**
 * Twilio, which carries both channels under one credential.
 *
 * Chosen over talking to Meta's Cloud API and an Indian SMS aggregator
 * separately because the fallback below is only worth having if the second
 * channel is one API call away rather than a second integration to keep alive.
 *
 * The request is built by hand rather than pulling in the SDK: it is one form
 * post, and the SDK's weight is not worth it for the two calls this makes.
 */
@Injectable()
export class TwilioMessagingProvider extends MessagingProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioMessagingProvider.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(channel: MobileChannel, message: OutboundMessage): Promise<SendOutcome> {
    const twilio = this.config.getOrThrow<TwilioConfig>('messaging.twilio');
    const from = channel === 'whatsapp' ? twilio.whatsappFrom : twilio.smsFrom;

    if (!twilio.accountSid || !twilio.authToken || !from) {
      return { sent: false, error: `No ${channel} sender is configured` };
    }

    const body = new URLSearchParams();
    body.set('To', channel === 'whatsapp' ? `whatsapp:${message.to}` : message.to);
    body.set('From', channel === 'whatsapp' ? `whatsapp:${from}` : from);

    if (channel === 'whatsapp') {
      // A business-initiated WhatsApp message must name an approved template;
      // free text is only allowed inside a 24-hour reply window we never have.
      body.set('ContentSid', MOBILE_TEMPLATES[message.template].name);
      body.set(
        'ContentVariables',
        JSON.stringify(
          Object.fromEntries(
            // Twilio numbers a template's variables from 1, in the order the
            // approved template declares them — which is the order the
            // catalogue declares, and why that order is part of its contract.
            mobileTemplateValues(message.template, message.values).map((value, index) => [
              String(index + 1),
              value,
            ]),
          ),
        ),
      );
    } else {
      body.set('Body', renderMobileTemplate(message.template, message.values));
    }

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        },
      );

      const payload = (await response.json()) as { sid?: string; message?: string };
      if (!response.ok) {
        return { sent: false, error: payload.message ?? `Provider returned ${response.status}` };
      }
      return { sent: true, providerMessageId: payload.sid };
    } catch (error) {
      // A timeout or a DNS failure is the provider's problem, not the caller's.
      // It is reported back so it lands in the delivery record rather than
      // vanishing into a log nobody reads.
      this.logger.warn({ err: error, channel }, 'Mobile send failed');
      return { sent: false, error: error instanceof Error ? error.message : 'Send failed' };
    }
  }
}
