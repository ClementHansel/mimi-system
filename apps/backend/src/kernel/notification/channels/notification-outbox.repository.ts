import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { withSystemContext } from '../../../common/database/system-context';

export type OutboxChannel = 'email' | 'whatsapp';
export type OutboxStatus = 'pending' | 'sent' | 'failed';

/**
 * Thin wrapper over `notification_outbox` (migration 006) — shared by both
 * the email and WhatsApp channels so every outbound attempt on either
 * channel leaves the SAME durable, queryable record (`channel`, `recipient`,
 * `template_key`, `payload`, `status`, `attempts`, `last_error`, `sent_at`),
 * not just the WA mock path. This is what makes "did we actually try to
 * tell this person X" answerable later (W5-04's notification surfaces,
 * ops debugging a missed alert) regardless of which channel it was.
 *
 * D-21/D-22: `DATABASE_POOL` connects as `mimi_app`, which holds NO table
 * grants of its own — every query here needs `SET LOCAL ROLE app_user`
 * first (`withSystemContext`, `common/database/system-context.ts`, the
 * canonical helper five modules independently converged on).
 * `notification_outbox` carries no RLS policy at all (migration 009 §1.14
 * "NONE" group), so the role switch alone is sufficient — `role: ''` (no
 * `app.*` session var is read by any policy on this table).
 */
@Injectable()
export class NotificationOutboxRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async create(
    channel: OutboxChannel,
    recipient: string,
    templateKey: string,
    payload: unknown,
  ): Promise<string> {
    return withSystemContext(this.pool, { role: '' }, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox (channel, recipient, template_key, payload, status)
         VALUES ($1,$2,$3,$4,'pending')
         RETURNING id`,
        [channel, recipient, templateKey, JSON.stringify(payload)],
      );
      return result.rows[0]!.id;
    });
  }

  async markSent(id: string): Promise<void> {
    await withSystemContext(this.pool, { role: '' }, (client) =>
      client.query(
        `UPDATE notification_outbox SET status = 'sent', attempts = attempts + 1, sent_at = NOW() WHERE id = $1`,
        [id],
      ),
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await withSystemContext(this.pool, { role: '' }, (client) =>
      client.query(
        `UPDATE notification_outbox SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [id, error],
      ),
    );
  }
}
