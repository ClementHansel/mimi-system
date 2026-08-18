import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `surat_jalan`/`sj_drops`/`sj_lines`/`sj_temperature_logs`/`sj_seals`/`drivers`/
 * `goods_receipts` are all RLS-enforced (CONTRACTS.md §1.14; migration 037) —
 * every query this module issues MUST run on the SAME `PoolClient`
 * `RlsContextGuard` already opened for this request (`SET LOCAL ROLE app_user`
 * + `app.user_id`/`app.role`/`app.location_ids` already live in that
 * transaction). `mimi_app` (the pool's own login role) is granted nothing but
 * `CONNECT` on its own — a fresh `DATABASE_POOL.query()` bypassing this would
 * fail on every statement rather than silently under-scope, but reaching for
 * `request.dbClient` explicitly here is what keeps every query honestly
 * RLS-scoped. Mirrors `modules/location/request-db-client.ts` (M03) — kept as
 * a local copy per BUILD-PLAN §6 rule 1 (one agent, one directory).
 */
export function requireDbClient(req: Request): PoolClient {
  const client = (req as unknown as RequestWithDbContext).dbClient;
  if (!client) {
    throw new ForbiddenException({
      code: 'ERR_FORBIDDEN',
      message: 'No RLS session context on this request',
    });
  }
  return client;
}
