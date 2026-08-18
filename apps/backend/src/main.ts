// Pin the process timezone to WITA BEFORE anything else runs (D-11 — "do not
// copy AIRE's Asia/Jakarta default"). Every `new Date()` / TIMESTAMPTZ
// formatting downstream depends on this being set first.
process.env.TZ = 'Asia/Makassar';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, BadRequestException, Logger, RequestMethod } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // Deploy topology is Traefik → backend (infrastructure/traefik) — trust the
  // first hop so req.ip / audit_log.ip_address resolve to the real client,
  // not the reverse proxy's address.
  app.set('trust proxy', 1);

  // Single-tenant app, but the frontend and any future branch-node dashboards
  // may run on a different origin than the API in dev; lock this down to an
  // explicit allowlist in production via CORS_ORIGIN (comma-separated).
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true,
    credentials: true,
  });

  // CONTRACTS.md §0 error shape: { statusCode, code, message, details? }.
  app.useGlobalFilters(new AllExceptionsFilter());

  // class-validator failures are folded into the same error shape (code
  // ERR_VALIDATION) instead of Nest's default { statusCode, message: [...] }.
  // NOTE: `ValidationPipe` needs `class-validator` + `class-transformer` as
  // runtime peer deps for Wave 3/4 DTOs to actually validate — neither is in
  // apps/backend/package.json yet. Per collision rule 2 (dependencies route
  // through W1-A, this agent doesn't add them), flagged in this agent's
  // final report rather than added here. The structural type below avoids a
  // hard compile-time import of 'class-validator' in the meantime.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (
        errors: Array<{ property: string; constraints?: Record<string, string> }>,
      ) =>
        new BadRequestException({
          code: 'ERR_VALIDATION',
          message: 'Validation failed',
          details: errors.map((e) => ({
            field: e.property,
            constraints: e.constraints ? Object.values(e.constraints) : [],
          })),
        }),
    }),
  );

  // Every endpoint in CONTRACTS.md §4 is `/api/...`, with ONE documented
  // exception: CONTRACTS.md §4.23 / SYNC-PROTOCOL §4.1 fix `/sync/v1/*` as
  // its own bare (non-`/api`) path family — it mirrors the `/sync` socket.io
  // namespace (also bare) so a device's sync transport never needs to know
  // about the REST API's prefix. `/health` is excluded for the same
  // "no API awareness needed" reason (docker-compose.yml's healthcheck curls
  // the bare path). Added by W2-D (kernel/sync) alongside the sync engine —
  // `main.ts` isn't on BUILD-PLAN §6 rule 2's frozen-file list, and the
  // wire paths above are binding, not optional.
  app.setGlobalPrefix('api', {
    exclude: [
      'health',
      { path: 'sync/v1/health', method: RequestMethod.ALL },
      { path: 'sync/v1/hello', method: RequestMethod.ALL },
      { path: 'sync/v1/push', method: RequestMethod.ALL },
      { path: 'sync/v1/pull', method: RequestMethod.ALL },
      { path: 'sync/v1/bootstrap', method: RequestMethod.ALL },
      { path: 'sync/v1/attachments/(.*)', method: RequestMethod.ALL },
    ],
  });

  // Let in-flight requests and kernel modules' OnModuleDestroy hooks (pool.end(),
  // redis.quit() — see common/database, common/redis) run on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Mimi Chicken OS backend listening on http://0.0.0.0:${port} (TZ=${process.env.TZ})`);
}

bootstrap();
