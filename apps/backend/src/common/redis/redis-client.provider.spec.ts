/**
 * The regression: a backend run OUTSIDE compose connected to redis with no
 * password and every command failed `NOAUTH`, because `REDIS_URL` is injected
 * by `docker-compose.yml` on the backend service and is absent from `.env`
 * (which defines `REDIS_PASSWORD`/`REDIS_PORT` instead). It showed up only as
 * `/health: degraded` — the idempotency locks and cache redis backs just
 * quietly stopped working.
 */
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { resolveRedisUrl } from './redis-client.provider';

/** A ConfigService over a plain map, so a variable being ABSENT is testable. */
function configOf(vars: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => vars[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('resolveRedisUrl', () => {
  it('uses REDIS_URL verbatim when compose injected one', () => {
    const url = resolveRedisUrl(
      configOf({ REDIS_URL: 'redis://:pw@redis:6379', REDIS_PASSWORD: 'ignored' }),
    );
    expect(url).toBe('redis://:pw@redis:6379');
  });

  it('assembles an AUTHENTICATED url from the parts `.env` defines when REDIS_URL is absent', () => {
    // This is the host-run case that was broken: no REDIS_URL, but a password
    // the redis container demands via `--requirepass`.
    const url = resolveRedisUrl(configOf({ REDIS_PASSWORD: 'mimi_redis_secret' }));
    expect(url).toBe('redis://:mimi_redis_secret@localhost:6379');
  });

  it('honours REDIS_HOST/REDIS_PORT', () => {
    const url = resolveRedisUrl(
      configOf({ REDIS_HOST: 'redis', REDIS_PORT: '6380', REDIS_PASSWORD: 'pw' }),
    );
    expect(url).toBe('redis://:pw@redis:6380');
  });

  it('percent-encodes the password so one containing url syntax cannot break the url', () => {
    // A password with `@` would otherwise terminate the userinfo early and
    // point the client at an entirely different host.
    const url = resolveRedisUrl(configOf({ REDIS_PASSWORD: 'p@ss/w:rd' }));
    expect(url).toBe('redis://:p%40ss%2Fw%3Ard@localhost:6379');
    expect(new URL(url).hostname).toBe('localhost');
  });

  it('omits the auth section entirely when no password is set', () => {
    // A local redis without `requirepass` must not be handed an empty
    // credential, which some servers reject outright.
    expect(resolveRedisUrl(configOf({}))).toBe('redis://localhost:6379');
  });
});
