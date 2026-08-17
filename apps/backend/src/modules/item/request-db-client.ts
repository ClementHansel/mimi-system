import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `items`/`item_categories`/`units`/`unit_conversions` carry no RLS policy
 * (CONTRACTS.md §1.14 — API-gated only via `PermissionsGuard`), but the
 * pool's own login role (`mimi_app`) is granted NOTHING but `CONNECT`
 * (migration 203/205) — every actual table privilege lives on `app_user`,
 * reached only via the `SET LOCAL ROLE app_user` `RlsContextGuard` already
 * issued on `request.dbClient`. A fresh `DATABASE_POOL.query()` here would
 * fail outright rather than silently under-scope, but this module always
 * reaches for the request-scoped client explicitly rather than depending on
 * that failure mode.
 */
export function requireDbClient(req: Request): PoolClient {
  const client = (req as unknown as RequestWithDbContext).dbClient;
  if (!client) {
    throw new ForbiddenException({ code: 'ERR_FORBIDDEN', message: 'No RLS session context on this request' });
  }
  return client;
}
