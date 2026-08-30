import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { Pool } from 'pg';
import { NotificationOutboxRepository } from './notification-outbox.repository';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../../common/database/system-context';
import { openSmtpPassword } from '../smtp-secret';

export interface EmailSendResult {
  success: boolean;
  outboxId: string;
  error?: string;
}

interface TenantSmtp {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  passwordSealed: string | null;
  fromEmail: string;
  fromName: string | null;
  isEnabled: boolean;
}

/**
 * SMTP email channel (D-03), configured PER TENANT.
 *
 * Every send is first recorded as a `notification_outbox` row
 * (`channel='email'`) — the same bookkeeping discipline as the WhatsApp
 * channel, via the shared `NotificationOutboxRepository`.
 *
 * WHY PER TENANT. This used to build ONE transporter in its constructor from
 * process-wide `SMTP_*` environment variables: one mailbox for the whole
 * deployment. That cannot work once one instance serves several businesses —
 * client A's staff would receive notifications from client B's address, or
 * from nobody at all. Each tenant now supplies their own Gmail (their own
 * account, their own 2FA and App Password) in Settings, stored in
 * `tenant_email_settings` with the password sealed (migration 264).
 *
 * The transporter is CACHED PER TENANT and invalidated by `forget()` when
 * settings change. Building one per send would open a fresh TCP+TLS
 * connection for every notification, which on a batch of low-stock alerts is
 * both slow and a good way to trip Gmail's rate limiting.
 *
 * The environment `SMTP_*` variables remain as a FALLBACK for a tenant that has
 * not configured anything — useful for a single-tenant deployment and for
 * local development, where per-tenant setup would be pure ceremony.
 */
@Injectable()
export class EmailChannelService {
  private readonly logger = new Logger(EmailChannelService.name);
  private readonly cache = new Map<string, { transporter: Transporter; from: string }>();

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: NotificationOutboxRepository,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Drop a tenant's cached transporter. Called after their settings change —
   * without it, a corrected password would not take effect until restart, and
   * the operator would reasonably conclude the fix had not worked.
   */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async loadTenantSmtp(tenantId: string): Promise<TenantSmtp | null> {
    return withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      const res = await client.query<{
        host: string;
        port: number;
        secure: boolean;
        username: string | null;
        password_encrypted: string | null;
        from_email: string;
        from_name: string | null;
        is_enabled: boolean;
      }>(
        `SELECT host, port, secure, username, password_encrypted, from_email, from_name, is_enabled
           FROM tenant_email_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        host: row.host,
        port: row.port,
        secure: row.secure,
        username: row.username,
        passwordSealed: row.password_encrypted,
        fromEmail: row.from_email,
        fromName: row.from_name,
        isEnabled: row.is_enabled,
      };
    });
  }

  /** The deployment-wide fallback, for a tenant with nothing configured. */
  private envFallback(): TenantSmtp | null {
    const host = this.config.get<string>('SMTP_HOST', '');
    if (!host) return null;
    return {
      host,
      port: Number(this.config.get('SMTP_PORT', 587)),
      secure: String(this.config.get('SMTP_SECURE', 'false')).toLowerCase() === 'true',
      username: this.config.get<string>('SMTP_USER') ?? null,
      // The env password is plaintext by nature; `buildTransport` distinguishes
      // it from a sealed one by this flag rather than by guessing at format.
      passwordSealed: null,
      fromEmail: this.config.get<string>('SMTP_FROM_EMAIL', 'noreply@mimichicken.local'),
      fromName: null,
      isEnabled: true,
    };
  }

  private async resolve(
    tenantId: string,
  ): Promise<{ transporter: Transporter; from: string } | null> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const tenant = await this.loadTenantSmtp(tenantId);
    const settings = tenant ?? this.envFallback();
    if (!settings || !settings.isEnabled) return null;

    let password: string | undefined;
    if (settings.passwordSealed) {
      try {
        password = openSmtpPassword(settings.passwordSealed);
      } catch (err) {
        // A password that cannot be opened is a configuration problem, not a
        // reason to send unauthenticated — most providers would reject that
        // anyway, and silently trying would bury the real cause.
        this.logger.error(
          `Tenant ${tenantId}: stored SMTP password could not be opened — ${(err as Error).message}`,
        );
        return null;
      }
    } else if (!tenant) {
      password = this.config.get<string>('SMTP_PASSWORD');
    }

    const transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.username ? { user: settings.username, pass: password } : undefined,
    });
    const from = settings.fromName
      ? `"${settings.fromName}" <${settings.fromEmail}>`
      : settings.fromEmail;

    const entry = { transporter, from };
    this.cache.set(tenantId, entry);
    return entry;
  }

  /** Whether this tenant can send at all — used by the settings UI. */
  async isConfigured(tenantId: string): Promise<boolean> {
    return (await this.resolve(tenantId)) !== null;
  }

  async send(
    tenantId: string,
    to: string,
    templateKey: string,
    subject: string,
    body: string,
  ): Promise<EmailSendResult> {
    const outboxId = await this.outbox.create('email', to, templateKey, { subject, body });

    const resolved = await this.resolve(tenantId);
    if (!resolved) {
      this.logger.warn(
        `Tenant ${tenantId} has no usable SMTP — outbox row ${outboxId} recorded, nothing sent: to=${to} subject="${subject}"`,
      );
      await this.outbox.markFailed(outboxId, 'No SMTP configured for this tenant');
      return { success: false, outboxId, error: 'No SMTP configured for this tenant' };
    }

    try {
      await resolved.transporter.sendMail({ from: resolved.from, to, subject, text: body });
      await this.outbox.markSent(outboxId);
      return { success: true, outboxId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${message}`);
      await this.outbox.markFailed(outboxId, message);
      // Drop the cached transporter: an auth failure usually means the App
      // Password was revoked or rotated, and holding a dead connection would
      // make every subsequent send fail the same way until restart.
      this.cache.delete(tenantId);
      return { success: false, outboxId, error: message };
    }
  }
}
