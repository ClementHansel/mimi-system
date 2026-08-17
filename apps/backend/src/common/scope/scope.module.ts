import { Global, Module } from '@nestjs/common';
import { ScopeService } from './scope.service';

/**
 * Global so `RlsContextGuard` (and any module) can inject `ScopeService`
 * without per-module wiring. `ScopeService` takes no DI dependencies of its
 * own — phase 2 of the RLS session-context handshake runs on the
 * caller-supplied `PoolClient` (see `scope.service.ts`'s class comment),
 * never a connection it acquires itself, so this module needs no
 * `DatabaseModule` import.
 */
@Global()
@Module({
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
