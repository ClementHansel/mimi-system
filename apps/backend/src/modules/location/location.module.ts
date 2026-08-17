import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { StorageAreaService } from './storage-area.service';

/**
 * M03 `location` — owned by Wave 3, agent W3-02 (medior).
 *
 * Outlets, gudang pusat, cities, and storage areas within a location (D-15).
 * CONTRACTS.md §4.3. Stock is keyed by `(location_id, storage_area_id,
 * item_id)` — this module owns the storage-area master data that key
 * depends on, but never writes `stock_balances` itself (D-07).
 *
 * `SyncEngineModule` is imported for `SyncEmitService` — every mutation here
 * emits a `locations`/`storage_areas` sync event (CONTRACTS.md §0, BUILD-PLAN
 * §6 rule 6) so branch nodes and devices receive the master-data update.
 */
@Module({
  imports: [SyncEngineModule],
  controllers: [LocationController],
  providers: [LocationService, StorageAreaService],
  exports: [LocationService, StorageAreaService],
})
export class LocationModule {}
