import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { ScopeModule } from './scope/scope.module';
import { JwtCoreModule } from './jwt/jwt-core.module';

/**
 * Aggregates every global `common/**` provider into one import for
 * `app.module.ts` (BUILD-PLAN §6 rule 2 — keep the root module's import list
 * short and frozen). `JwtAuthGuard` / `RlsContextGuard` / `PermissionsGuard` /
 * `RlsCleanupInterceptor` are registered as `APP_GUARD`/`APP_INTERCEPTOR`
 * directly in `AppModule` (they need no module of their own — Nest picks up
 * global-token providers regardless of which module declares them, so they
 * could live here too, but keeping them visible in `app.module.ts` makes the
 * guard ORDER — which matters — obvious at a glance).
 */
@Global()
@Module({
  imports: [DatabaseModule, RedisModule, ScopeModule, JwtCoreModule],
  exports: [DatabaseModule, RedisModule, ScopeModule, JwtCoreModule],
})
export class CommonModule {}
