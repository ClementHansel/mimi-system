import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Builds the connection string from whatever the environment actually defines.
 *
 * WHY THIS IS NOT JUST `config.get('REDIS_URL')`: `REDIS_URL` is set by
 * `docker-compose.yml` on the BACKEND SERVICE only — it is not in `.env`, which
 * defines `REDIS_PASSWORD`/`REDIS_PORT` instead. So the composed stack got an
 * authenticated url and a backend run on the host (`pnpm dev` / `nest start`,
 * the workflow the README documents first) fell through to the unauthenticated
 * default and every command failed `NOAUTH Authentication required` — the redis
 * container runs `--requirepass`. That surfaced only as `/health` reporting
 * `degraded`, while the things redis actually backs (idempotency locks and
 * cache, BUILD-PLAN §2) silently did not work.
 *
 * This is the same trap `kernel/storage`'s `StorageService` already documents
 * for MinIO — reading only the compose-injected variable meant running outside
 * compose built a client with no credentials — and it is fixed the same way:
 * prefer the explicit url, otherwise assemble one from the parts `.env` has.
 */
export function resolveRedisUrl(config: ConfigService): string {
  const explicit = config.get<string>('REDIS_URL');
  if (explicit) return explicit;

  const host = config.get<string>('REDIS_HOST', 'localhost');
  const port = config.get<string>('REDIS_PORT', '6379');
  const password = config.get<string>('REDIS_PASSWORD');

  // `redis://:password@host:port` — the userless form ioredis and redis-cli
  // both accept for a `requirepass`-only server (no ACL user configured).
  // Percent-encoded so a password containing `@`, `/` or `:` cannot break the
  // url it is embedded in.
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${host}:${port}`;
}

/**
 * Shared ioredis client (cache + distributed locks — BUILD-PLAN §2). Kernel
 * modules (W2-*) inject this for idempotency locks and cache; the health
 * endpoint pings it directly.
 */
export const RedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    return new Redis(resolveRedisUrl(config), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  },
};
