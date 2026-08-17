import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { NotificationGateway } from '../notification.gateway';
import { withSystemContext } from '../../../common/database/system-context';

export interface InAppNotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  locationId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * In-app channel: one `notifications` row per recipient (RLS `notifications_self`,
 * migration 009 — a user only ever reads/writes their own), plus a
 * best-effort socket.io push so an already-connected client sees it without
 * polling. `GET /api/notifications` (CONTRACTS.md §4.0) reads this table
 * directly; the socket push is a UX nicety on top, never the source of
 * truth.
 *
 * D-21/D-22: `notifications_self` is `USING/WITH CHECK (app_is_self(user_id))`
 * with NO central-role bypass — the row's own `user_id` is the ONLY session
 * identity Postgres will let insert it. Since the caller triggering a
 * notification is essentially always a DIFFERENT user than the recipient
 * (a supervisor's approval notifies the owner, not themselves), this INSERT
 * can never ride on the caller's own request-scoped `PoolClient` — it needs
 * `app.user_id` set to the RECIPIENT's real id for this one transaction
 * (`withSystemContext(pool, { role: '', userId: recipientId }, fn)`,
 * `common/database/system-context.ts`'s "recipient/self impersonation"
 * shape), on `DATABASE_POOL` directly.
 */
@Injectable()
export class InAppChannelService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly gateway: NotificationGateway,
  ) {}

  async create(
    userId: string,
    type: string,
    title: string,
    body: string,
    payload: Record<string, unknown>,
    locationId: string | null,
  ): Promise<InAppNotificationRow> {
    const result = await withSystemContext(this.pool, { role: '', userId }, (client) =>
      client.query(
        `INSERT INTO notifications (user_id, type, title, body, payload, location_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, user_id, type, title, body, payload, location_id, read_at, created_at`,
        [userId, type, title, body, JSON.stringify(payload), locationId],
      ),
    );
    const row = this.toDto(result.rows[0]);
    this.gateway.pushToUser(userId, row);
    return row;
  }

  private toDto(row: {
    id: string;
    user_id: string;
    type: string;
    title: string;
    body: string;
    payload: unknown;
    location_id: string | null;
    read_at: Date | null;
    created_at: Date;
  }): InAppNotificationRow {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      payload: (row.payload as Record<string, unknown>) ?? {},
      locationId: row.location_id,
      readAt: row.read_at ? row.read_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
