import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { renderNotificationText } from './i18n/id-ID';
import { getTemplate, NotificationTemplateKey } from './template-registry';
import { EmailChannelService } from './channels/email-channel.service';
import { WhatsAppChannelService } from './channels/whatsapp-channel.service';
import { InAppChannelService, InAppNotificationRow } from './channels/in-app-channel.service';
import { SYSTEM_CENTRAL_ROLE, withSystemContext } from '../../common/database/system-context';

export interface NotifyRequest {
  templateKey: NotificationTemplateKey;
  /** Recipients — every one gets the in-app row; email/WhatsApp use their resolved contact info. */
  userIds: string[];
  params: Record<string, string>;
  locationId?: string;
  /** Restricts delivery to a subset of the template's default channels (e.g. an in-app-only re-send). */
  channels?: Array<'in_app' | 'email' | 'whatsapp'>;
}

export interface NotifyResult {
  inApp: InAppNotificationRow[];
  email: { userId: string; success: boolean; outboxId?: string; error?: string }[];
  whatsapp: { userId: string; success: boolean; outboxId?: string; error?: string }[];
}

interface RecipientContact {
  id: string;
  email: string | null;
  phone: string | null;
  /** Whose SMTP sends to this person — see `resolveContacts`. */
  tenantId: string;
}

/**
 * `NotificationService` — the single entry point every module calls to
 * tell a user something (D-03). Callers never touch a channel directly;
 * they name a template + recipients + params, and this service fans out to
 * whichever channels that template is configured for
 * (`template-registry.ts`), rendering Bahasa Indonesia text through the one
 * i18n resource (`i18n/id-ID.ts`) — never hardcoding it here.
 *
 * `type` written to `notifications.type` and used as the WA/email
 * `template_key` is the SAME string as `templateKey` — CONTRACTS.md
 * (migration 006) documents `notifications.type` values that are exactly
 * this registry's keys.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly inApp: InAppChannelService,
    private readonly email: EmailChannelService,
    private readonly whatsapp: WhatsAppChannelService,
  ) {}

  async notify(request: NotifyRequest): Promise<NotifyResult> {
    const template = getTemplate(request.templateKey);
    const activeChannels = request.channels
      ? template.channels.filter((c) => request.channels!.includes(c))
      : template.channels;
    const text = renderNotificationText(request.templateKey, request.params);

    const contacts = await this.resolveContacts(request.userIds);

    const result: NotifyResult = { inApp: [], email: [], whatsapp: [] };

    for (const contact of contacts) {
      if (activeChannels.includes('in_app')) {
        const row = await this.inApp.create(
          contact.id,
          request.templateKey,
          text.title,
          text.body,
          { templateKey: request.templateKey, params: request.params },
          request.locationId ?? null,
        );
        result.inApp.push(row);
      }

      if (activeChannels.includes('email')) {
        if (contact.email) {
          const sendResult = await this.email.send(
            contact.tenantId,
            contact.email,
            request.templateKey,
            text.title,
            text.body,
          );
          result.email.push({ userId: contact.id, ...sendResult });
        } else {
          this.logger.debug(`Skipping email for user ${contact.id}: no email on file`);
        }
      }

      if (activeChannels.includes('whatsapp')) {
        if (contact.phone) {
          const sendResult = await this.whatsapp.send(
            contact.phone,
            request.templateKey,
            request.params,
            text.body,
          );
          result.whatsapp.push({ userId: contact.id, ...sendResult });
        } else {
          this.logger.debug(`Skipping WhatsApp for user ${contact.id}: no phone on file`);
        }
      }
    }

    return result;
  }

  /**
   * D-21/D-22: resolving contact info for an arbitrary set of recipient ids
   * is inherently a cross-user read — the caller's own RLS scope (if any)
   * cannot be assumed to cover it (a Kasir's action notifying an Owner is
   * the common case, not the exception). `users_select`'s RLS is
   * `app_is_central() OR app_is_self(id)`, so this legitimately needs the
   * central-role bypass (`withSystemContext(pool, { role: SYSTEM_CENTRAL_ROLE }, fn)`,
   * `common/database/system-context.ts` — the canonical helper) on
   * `DATABASE_POOL` directly — never the caller's own request client.
   */
  private async resolveContacts(userIds: string[]): Promise<RecipientContact[]> {
    if (userIds.length === 0) return [];
    return withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      // `tenant_id` comes back too, because outbound mail is sent through the
      // RECIPIENT'S OWN tenant SMTP (migration 264). A notification to client
      // A's staff must leave from client A's mailbox, not from whichever
      // company happened to configure email first.
      const result = await client.query<{
        id: string;
        email: string | null;
        phone: string | null;
        tenant_id: string;
      }>('SELECT id, email, phone, tenant_id FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      // snake_case out of Postgres, camelCase in the domain type.
      return result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        phone: r.phone,
        tenantId: r.tenant_id,
      }));
    });
  }
}
