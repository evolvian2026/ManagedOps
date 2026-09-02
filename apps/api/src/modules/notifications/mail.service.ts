import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * One transport interface over SMTP. Mailpit locally, SES in AWS — the only
 * difference is configuration, so nothing above this layer knows which is which.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const mail = this.config.getOrThrow<{
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
    }>('mail');

    this.transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      ...(mail.user && mail.password ? { auth: { user: mail.user, pass: mail.password } } : {}),
    });
  }

  /**
   * Delivery failure never fails the request that triggered it — a trainer's
   * account is still created if the welcome email bounces. The failure is
   * logged so it can be retried or chased.
   */
  async send(message: MailMessage): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({
        from: this.config.getOrThrow<string>('mail.from'),
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return true;
    } catch (error) {
      this.logger.error({ err: error, to: message.to, subject: message.subject }, 'Email failed');
      return false;
    }
  }
}
