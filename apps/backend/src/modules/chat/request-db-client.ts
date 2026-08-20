import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * M06 `supplier` — RLS-enforced (CONTRACTS.md §1.14; D-20 column-level + row visibility).
 * Every query this module issues MUST run on the SAME `PoolClient` `RlsContextGuard`
 * already opened for this request (`SET LOCAL ROLE app_user` + `app.user_id`/`app.role`/
 * `app.location_ids` already live in that transaction). `mimi_app` (the pool's own login role)
 * is deliberately granted NOTHING but `CONNECT` — a fresh `DATABASE_POOL.query()` bypassing
 * this would fail on every single statement with "permission denied".
 *
 * Reaching for `request.dbClient` explicitly here (rather than depending on that failure mode)
 * is what keeps every query in this module honestly RLS-scoped instead of accidentally working
 * via some future grant change to `mimi_app` itself.
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
