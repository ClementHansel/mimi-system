import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationOutboxRepository } from './notification-outbox.repository';

export interface WhatsAppSendResult {
  success: boolean;
  outboxId: string;
  error?: string;
}

/**
 * WhatsApp channel (D-03) — delivered via an n8n webhook, never a direct WA
 * SDK (BUILD-PLAN §2, `infrastructure/n8n/README.md`). RISK-P4: the client's
 * real WA gateway credentials may not exist by go-live, so this channel is
 * built to be inert-by-default and provably safe to ship that way:
 *
 * - EVERY send, enabled or not, is first recorded as a `notification_outbox`
 *   row (`channel='whatsapp'`, `status='pending'`) — a durable, queryable
 *   record of "we tried to tell someone this" that survives independent of
 *   whether the webhook call itself ever happens.
 * - `WA_ENABLED=false` (the default, `.env.example`) stops HERE: the
 *   webhook is never called, the row is left `pending`, and the method
 *   returns `success: false`. Flipping `WA_ENABLED=true` and dropping real
 *   n8n credentials into the workflow (see
 *   `infrastructure/n8n/workflows/wa-notify.json`) is the ENTIRE cutover —
 *   no backend code or migration changes (BUILD-PLAN RISK-P4).
 * - `WA_ENABLED=true` calls `N8N_WEBHOOK_URL_WA` and updates the SAME
 *   outbox row to `sent`/`failed` with the attempt count and last error,
 *   giving W5-04 a real retry surface later without a redesign.
 */
@Injectable()
export class WhatsAppChannelService {
  private readonly logger = new Logger(WhatsAppChannelService.name);
  private readonly enabled: boolean;
  private readonly webhookUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: NotificationOutboxRepository,
  ) {
    this.enabled = String(this.config.get('WA_ENABLED', 'false')).toLowerCase() === 'true';
    this.webhookUrl = this.config.get<string>('N8N_WEBHOOK_URL_WA', '');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(
    recipientPhone: string,
    templateKey: string,
    params: Record<string, string>,
    renderedText: string,
  ): Promise<WhatsAppSendResult> {
    const outboxId = await this.outbox.create('whatsapp', recipientPhone, templateKey, { params, text: renderedText });

    if (!this.enabled) {
      this.logger.log(`WA_ENABLED=false — wrote outbox row ${outboxId} for ${recipientPhone}, sending nothing.`);
      return { success: false, outboxId, error: 'WhatsApp channel disabled (mock outbox mode)' };
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipientPhone, templateKey, params, text: renderedText }),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => `HTTP ${response.status}`);
        await this.outbox.markFailed(outboxId, errorText);
        return { success: false, outboxId, error: errorText };
      }
      await this.outbox.markSent(outboxId);
      return { success: true, outboxId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.outbox.markFailed(outboxId, message);
      return { success: false, outboxId, error: message };
    }
  }
}
