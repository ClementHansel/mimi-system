import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `purchase_requests`/`purchase_orders`/`po_receipts`/`petty_cash` (and their
 * line tables) are all RLS-enforced (CONTRACTS.md §1.14; migration blocks
 * 040-049) — every query this module issues MUST run on the SAME `PoolClient`
 * `RlsContextGuard` already opened for this request. `mimi_app` holds zero
 * direct grants; reaching for `request.dbClient` explicitly is what keeps
 * every query honestly RLS-scoped. Local copy per BUILD-PLAN §6 rule 1 (one
 * agent, one directory) — mirrors `modules/delivery/request-db-client.ts`.
 */
export function requireDbClient(req: Request): PoolClient {
  const client = (req as unknown as RequestWithDbContext).dbClient;
  if (!client) {
    throw new ForbiddenException({ code: 'ERR_FORBIDDEN', message: 'No RLS session context on this request' });
  }
  return client;
}
