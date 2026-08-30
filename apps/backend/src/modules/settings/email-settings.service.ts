import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import nodemailer from 'nodemailer';
import {
  maskSmtpPassword,
  openSmtpPassword,
  sealSmtpPassword,
} from '../../kernel/notification/smtp-secret';
import { EmailChannelService } from '../../kernel/notification/channels/email-channel.service';

export interface EmailSettingsRes {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** Always masked. The real value never leaves the server. */
  password: string | null;
  fromEmail: string;
  fromName: string | null;
  isEnabled: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface PutEmailSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  /** Omitted or empty means "keep the stored password" — see `save`. */
  password?: string | null;
  fromEmail: string;
  fromName?: string | null;
  isEnabled?: boolean;
}

/**
 * A tenant's own outbound email configuration (migration 264).
 *
 * Each client connects THEIR OWN Gmail — their account, their 2FA, their App
 * Password — and the system sends as them. Every query here runs on the
 * request's own `dbClient`, so the RLS policy on `tenant_email_settings` is
 * what confines a caller to their own row; this service never takes a
 * `tenantId` from the caller, because a settings endpoint that accepted one
 * would let an owner rewrite another company's mail credentials.
 */
@Injectable()
export class EmailSettingsService {
  constructor(private readonly emailChannel: EmailChannelService) {}

  /** The caller's tenant, from the session — never from input. */
  private async tenantOf(client: PoolClient): Promise<string> {
    const res = await client.query<{ tenant_id: string }>(
      `SELECT current_setting('app.tenant_id', true)::uuid AS tenant_id`,
    );
    const id = res.rows[0]?.tenant_id;
    if (!id) throw new Error('No tenant in session context');
    return id;
  }

  async get(client: PoolClient): Promise<EmailSettingsRes | null> {
    const res = await client.query<Record<string, any>>(
      `SELECT host, port, secure, username, password_encrypted, from_email, from_name,
              is_enabled, last_tested_at, last_test_ok, last_test_error
         FROM tenant_email_settings`,
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      host: r.host,
      port: r.port,
      secure: r.secure,
      username: r.username,
      password: maskSmtpPassword(r.password_encrypted),
      fromEmail: r.from_email,
      fromName: r.from_name,
      isEnabled: r.is_enabled,
      lastTestedAt: r.last_tested_at ? new Date(r.last_tested_at).toISOString() : null,
      lastTestOk: r.last_test_ok,
      lastTestError: r.last_test_error,
    };
  }

  async save(
    client: PoolClient,
    dto: PutEmailSettings,
    actorId: string,
  ): Promise<EmailSettingsRes> {
    const tenantId = await this.tenantOf(client);

    // An ABSENT or EMPTY password means "leave the stored one alone".
    //
    // The UI never receives the real password (it gets a mask), so if it echoed
    // that mask back on save, a user changing only the port would overwrite
    // their working credential with the literal string "••••••••" and email
    // would break for a reason nobody would connect to editing a port.
    const sealed =
      dto.password && dto.password.trim() && !/^•+$/.test(dto.password)
        ? sealSmtpPassword(dto.password.trim())
        : null;

    await client.query(
      `INSERT INTO tenant_email_settings
         (tenant_id, host, port, secure, username, password_encrypted,
          from_email, from_name, is_enabled, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE),$10,NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         host = EXCLUDED.host,
         port = EXCLUDED.port,
         secure = EXCLUDED.secure,
         username = EXCLUDED.username,
         -- COALESCE keeps the existing secret when none was supplied.
         password_encrypted = COALESCE(EXCLUDED.password_encrypted, tenant_email_settings.password_encrypted),
         from_email = EXCLUDED.from_email,
         from_name = EXCLUDED.from_name,
         is_enabled = EXCLUDED.is_enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        tenantId,
        dto.host,
        dto.port,
        dto.secure,
        dto.username ?? null,
        sealed,
        dto.fromEmail,
        dto.fromName ?? null,
        dto.isEnabled ?? true,
        actorId,
      ],
    );

    // The channel caches a transporter per tenant; without this, corrected
    // credentials would not take effect until the next restart and the operator
    // would reasonably conclude the fix had not worked.
    this.emailChannel.forget(tenantId);

    return (await this.get(client))!;
  }

  /**
   * Proves the credentials actually work, and records the verdict.
   *
   * `verify()` opens a real connection and authenticates without sending mail.
   * The result is STORED rather than only returned, because the failure that
   * matters is the one nobody was watching: an App Password revoked weeks after
   * it was entered, with notifications quietly failing ever since.
   */
  async test(client: PoolClient): Promise<{ ok: boolean; error: string | null }> {
    const res = await client.query<Record<string, any>>(
      `SELECT host, port, secure, username, password_encrypted FROM tenant_email_settings`,
    );
    const r = res.rows[0];
    if (!r) return { ok: false, error: 'No email settings saved yet' };

    let outcome: { ok: boolean; error: string | null };
    try {
      const password = r.password_encrypted ? openSmtpPassword(r.password_encrypted) : undefined;
      const transporter = nodemailer.createTransport({
        host: r.host,
        port: r.port,
        secure: r.secure,
        auth: r.username ? { user: r.username, pass: password } : undefined,
        // A hung connection is the most common Gmail misconfiguration (465 with
        // secure=false). Without a timeout this request would hang until the
        // gateway gave up, which reads as "the app is broken" rather than
        // "these settings are wrong".
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });
      await transporter.verify();
      outcome = { ok: true, error: null };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    await client.query(
      `UPDATE tenant_email_settings
          SET last_tested_at = NOW(), last_test_ok = $1, last_test_error = $2`,
      [outcome.ok, outcome.error],
    );
    return outcome;
  }
}
