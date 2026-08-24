import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `import` — local copy per the repo's own convention (every domain module
 * keeps its own `requireDbClient`, e.g. `modules/supplier/request-db-client.ts`,
 * `modules/item/request-db-client.ts`) rather than a shared helper, so no
 * module ever depends on another module's internals for something this small.
 *
 * `items`/`item_categories`/`products` carry no RLS policy of their own
 * (CONTRACTS.md §1.14 NONE — global master data, API-gated only), but the
 * pool's own login role (`mimi_app`) is granted NOTHING but `CONNECT` — every
 * query in this module MUST run on the SAME `PoolClient` `RlsContextGuard`
 * already opened for this request (`SET LOCAL ROLE app_user`), never on a
 * fresh `DATABASE_POOL.query()`.
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

/** `req.locationScope` set by `RlsContextGuard` — `ProductService.create/update` need it (photo-url resolution only; import rows never carry a photo). */
export function requireLocationScope(req: Request): string[] | null {
  return (req as unknown as RequestWithDbContext).locationScope ?? null;
}
