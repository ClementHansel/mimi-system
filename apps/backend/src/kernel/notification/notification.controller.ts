import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Paginated } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { NotificationQueryDto } from './notification-query.dto';
import { InAppNotificationRow } from './channels/in-app-channel.service';

/**
 * `GET/POST /api/notifications*` (CONTRACTS.md §4.0). Reads run on
 * `request.dbClient` (the RLS-scoped connection `RlsContextGuard` already
 * opened for this request) — `notifications_self` RLS (migration 009)
 * already restricts every query here to the caller's own rows; the
 * explicit `WHERE user_id = ...` below is defense in depth, not the only
 * enforcement.
 */
@Controller('notifications')
export class NotificationController {

  @Get()
  @RequirePermission('notification.read.own')
  async list(
    @Req() req: RequestWithDbContext,
    @Query() query: NotificationQueryDto,
  ): Promise<Paginated<InAppNotificationRow>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = 50;
    const client = req.dbClient!;
    const userId = req.user!.sub;

    const where = query.unreadOnly ? 'AND read_at IS NULL' : '';
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 ${where}`,
      [userId],
    );
    const rowsResult = await client.query(
      `SELECT id, user_id, type, title, body, payload, location_id, read_at, created_at
         FROM notifications
        WHERE user_id = $1 ${where}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, pageSize, (page - 1) * pageSize],
    );

    const rows: InAppNotificationRow[] = rowsResult.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      body: r.body,
      payload: r.payload ?? {},
      locationId: r.location_id,
      readAt: r.read_at ? r.read_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    }));

    return { rows, total: Number(countResult.rows[0]?.count ?? 0), page, pageSize };
  }

  @Post(':id/read')
  @RequirePermission('notification.read.own')
  async markRead(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<{ id: string; readAt: string }> {
    const client = req.dbClient!;
    const result = await client.query(
      `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL
       RETURNING id, read_at`,
      [id, req.user!.sub],
    );
    if (result.rows.length > 0) {
      return { id: result.rows[0].id, readAt: result.rows[0].read_at.toISOString() };
    }
    // Already read or not the caller's row (RLS would have hidden the latter
    // anyway) — return the current state rather than erroring, matching
    // idempotent "mark as read" semantics.
    const existing = await client.query('SELECT id, read_at FROM notifications WHERE id = $1', [id]);
    const row = existing.rows[0];
    return { id, readAt: row?.read_at ? row.read_at.toISOString() : new Date().toISOString() };
  }

  @Post('read-all')
  @RequirePermission('notification.read.own')
  async markAllRead(@Req() req: RequestWithDbContext): Promise<{ updated: number }> {
    const client = req.dbClient!;
    const result = await client.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.sub],
    );
    return { updated: result.rowCount ?? 0 };
  }
}
