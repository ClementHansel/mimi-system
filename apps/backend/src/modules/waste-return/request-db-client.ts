import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * `waste_records`/`returns`/`return_lines` are RLS-enforced (CONTRACTS.md
 * §1.14; migration block 080-089) — every query this module issues MUST run
 * on the SAME `PoolClient` `RlsContextGuard` already opened for this
 * request. Local copy per BUILD-PLAN §6 rule 1 — mirrors
 * `modules/delivery/request-db-client.ts`.
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
