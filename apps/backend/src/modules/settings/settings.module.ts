import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SettingsRepository } from './settings.repository';
import { StatutoryController } from './statutory.controller';
import { StatutoryService } from './statutory.service';
import { StatutoryRepository } from './statutory.repository';
import { EmailSettingsService } from './email-settings.service';
import { NotificationModule } from '../../kernel/notification/notification.module';

/**
 * M20 `settings` — owned by Wave 3, agent W3-01 (senior-be).
 *
 * Company profile, approval thresholds (`approval_chain_steps` editing),
 * payroll rules, geofence radius, cold-chain limits (CONTRACTS.md §4.20) —
 * the namespaced `settings` key/value table (block 007). `settings.manage`
 * is Owner/Manager only; `settings.approval_chain.manage` is Owner only.
 *
 * Also hosts the D-18 statutory payroll wizard (`StatutoryController`,
 * `/api/settings/statutory/*`) — CONTRACTS.md §4.15 places this endpoint set
 * under `/api/payroll/statutory/*` (M15, Wave 4); shipped here instead per
 * an explicit coordinator directive. See `statutory.repository.ts`'s file
 * header for the full reasoning, flagged to the architect/W4-01 in this
 * agent's final report.
 */
@Module({
  imports: [SyncEngineModule, NotificationModule],
  controllers: [SettingsController, StatutoryController],
  providers: [
    SettingsService,
    SettingsRepository,
    StatutoryService,
    StatutoryRepository,
    EmailSettingsService,
  ],
})
export class SettingsModule {}
