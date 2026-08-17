import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import type Redis from 'ioredis';
import { DATABASE_POOL } from './common/database/database-pool.provider';
import { REDIS_CLIENT } from './common/redis/redis-client.provider';

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    database: HealthCheckResult;
    redis: HealthCheckResult;
  };
}

/** Backs `GET /health` — DB and Redis reachability (BUILD-PLAN §5 W1-D). */
@Injectable()
export class AppService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async checkHealth(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database.ok && redis.ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<HealthCheckResult> {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown database error' };
    }
  }

  private async checkRedis(): Promise<HealthCheckResult> {
    try {
      const pong = await this.redis.ping();
      return { ok: pong === 'PONG' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown redis error' };
    }
  }
}
