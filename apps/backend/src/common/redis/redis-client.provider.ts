import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Shared ioredis client (cache + distributed locks — BUILD-PLAN §2). Kernel
 * modules (W2-*) inject this for idempotency locks and cache; the health
 * endpoint pings it directly.
 */
export const RedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    return new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  },
};
