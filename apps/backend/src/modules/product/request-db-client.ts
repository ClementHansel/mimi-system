import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `products`/`recipes`/`recipe_lines` carry no RLS policy (CONTRACTS.md
 * §1.14 — API-gated only via `PermissionsGuard`, `recipe.read` additionally
 * because a recipe is cost structure), but the pool's own login role
 * (`mimi_app`) is granted NOTHING but `CONNECT` (migration 203/205) — every
 * actual table privilege lives on `app_user`, reached only via the
 * `SET LOCAL ROLE app_user` `RlsContextGuard` already issued on
 * `request.dbClient`.
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

/** `req.locationScope` set by `RlsContextGuard` — needed for `StorageService.getUrl`'s entity-scope check. */
export function requireLocationScope(req: Request): string[] | null {
  return (req as unknown as RequestWithDbContext).locationScope ?? null;
}
