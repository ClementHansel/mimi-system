import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { businessDateOf, type UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';
import { DailyPostingService } from './daily-posting.service';

/**
 * Fires `DailyPostingService` for the previous WITA business day (B-16).
 *
 * Without this, the aggregator is only reachable by someone remembering to
 * call `POST /api/accounting/daily-posting` — which is how JOUT-02/JOUT-03
 * came to be unposted in the first place. Modeled on
 * `dashboard/matview-refresh.service.ts` and
 * `device-registry/staleness-sweep.service.ts`: `OnApplicationBootstrap` plus
 * a plain `setInterval`, because this workspace has no `@nestjs/schedule`
 * dependency and adding one for a single timer is not worth it.
 *
 * THE INTERVAL IS SHORT AND THE WORK IS IDEMPOTENT, DELIBERATELY. A true
 * "run once at 01:00" cron silently loses the day if the process happens to
 * be restarting at 01:00. Here every tick re-attempts yesterday; the journal's
 * `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` makes the
 * second and subsequent attempts no-ops, so the loop self-heals after any
 * outage instead of leaving a permanent hole in the ledger.
 *
 * It posts YESTERDAY, never today: today is still being traded, and because
 * the entry is idempotent a partial figure posted now would become permanent.
 */
const TICK_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class DailyPostingScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DailyPostingScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly daily: DailyPostingService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed so a test can run one pass without waiting for the interval. */
  async tick(): Promise<{ businessDate: string; posted: number } | null> {
    const businessDate = businessDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    try {
      return await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
        const locations: UUID[] = await this.daily.locationsWithActivity(client, businessDate);
        let posted = 0;
        for (const locationId of locations) {
          // Per-location try/catch: one outlet whose data refuses to balance
          // must not stop every other outlet's day from posting.
          try {
            const result = await this.daily.postBusinessDay(client, locationId, businessDate);
            if (result.posted) posted += 1;
          } catch (err) {
            this.logger.error(
              `daily posting failed for location ${locationId} on ${businessDate}: ${(err as Error).message}`,
            );
          }
        }
        return { businessDate, posted };
      });
    } catch (err) {
      this.logger.error(`daily posting tick failed for ${businessDate}: ${(err as Error).message}`);
      return null;
    }
  }
}
