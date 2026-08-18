import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { NotificationOutboxRepository } from './notification-outbox.repository';

export interface EmailSendResult {
  success: boolean;
  outboxId: string;
  error?: string;
}

/**
 * SMTP email channel (D-03). Config comes from `.env.example`'s `SMTP_*`
 * vars, already wired by W1-A into `docker-compose.yml`'s backend service.
 *
 * Every send is first recorded as a `notification_outbox` row
 * (`channel='email'`) — same bookkeeping discipline as the WhatsApp channel
 * (`whatsapp-channel.service.ts`), via the shared
 * `NotificationOutboxRepository`. When `SMTP_HOST` is unset (nothing
 * configured — true of a fresh dev checkout before ops drops in real
 * credentials), the row is written and left `pending`/marked `failed` with
 * a clear reason, rather than throwing — the pipeline is exercised
 * end-to-end either way.
 */
@Injectable()
export class EmailChannelService {
  private readonly logger = new Logger(EmailChannelService.name);
  private readonly transporter: Transporter | null;
  private readonly fromAddress: string;

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: NotificationOutboxRepository,
  ) {
    const host = this.config.get<string>('SMTP_HOST', '');
    this.fromAddress = this.config.get<string>('SMTP_FROM_EMAIL', 'noreply@mimichicken.local');

    if (!host) {
      this.transporter = null;
      this.logger.warn(
        'SMTP_HOST not configured — email channel will record outbox rows without sending.',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: String(this.config.get('SMTP_SECURE', 'false')).toLowerCase() === 'true',
      auth: this.config.get<string>('SMTP_USER')
        ? {
            user: this.config.get<string>('SMTP_USER'),
            pass: this.config.get<string>('SMTP_PASSWORD'),
          }
        : undefined,
    });
  }

  isConfigured(): boolean {
    return this.transporter !== null;
  }

  async send(
    to: string,
    templateKey: string,
    subject: string,
    body: string,
  ): Promise<EmailSendResult> {
    const outboxId = await this.outbox.create('email', to, templateKey, { subject, body });

    if (!this.transporter) {
      this.logger.warn(
        `SMTP not configured — outbox row ${outboxId} left pending: to=${to} subject="${subject}"`,
      );
      await this.outbox.markFailed(outboxId, 'SMTP not configured');
      return { success: false, outboxId, error: 'SMTP not configured' };
    }
    try {
      await this.transporter.sendMail({ from: this.fromAddress, to, subject, text: body });
      await this.outbox.markSent(outboxId);
      return { success: true, outboxId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${message}`);
      await this.outbox.markFailed(outboxId, message);
      return { success: false, outboxId, error: message };
    }
  }
}
