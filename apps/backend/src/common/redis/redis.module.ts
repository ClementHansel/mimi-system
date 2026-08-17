import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT, RedisClientProvider } from './redis-client.provider';

@Global()
@Module({
  providers: [RedisClientProvider],
  exports: [RedisClientProvider],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
