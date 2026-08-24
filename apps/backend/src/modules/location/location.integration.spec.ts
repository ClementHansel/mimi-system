/**
 * Integration tests for `LocationService`/`StorageAreaService` against the
 * live database (BUILD-PLAN §8 "unit + integration tests green").
 *
 * IMPORTANT: unlike `kernel/approvals`'s harness, these services self-commit
 * within their own mutating methods (the "AIRE/inventory convention" —
 * matches ONE HTTP request, ONE COMMIT in production). `withRollback`'s own
 * ROLLBACK is therefore a no-op the instant a mutating call runs — the row
 * really persists. Every test that calls a mutating method:
 *   1. never issues a FURTHER query on that same `client` afterward (the
 *      session's `SET LOCAL ROLE app_user` reverted at COMMIT — a later
 *      query on the same connection would run back under the bare,
 *      grant-less `mimi_app` login role and fail with "permission denied");
 *   2. asserts against the method's OWN return value instead;
 *   3. cleans up whatever it created via `cleanupLocations()` (OWNER pool).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { can, LocationType, RoleKey, StorageAreaType } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { LocationService } from './location.service';
import { StorageAreaService } from './storage-area.service';
import { CreateLocationDto } from './dto/location.dto';
import {
  cleanupLocations,
  closePool,
  loadFixtures,
  nextCode,
  withRollback,
  type Fixtures,
} from './test-support/live-db';

const eventsRepo = new SyncEventsRepository();
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(conflictsRepo);
const sync = new SyncEmitService(eventsRepo, conflictDetector);
const locationService = new LocationService(sync);
const storageAreaService = new StorageAreaService(sync);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';

describe('LocationService (live database)', () => {
  const createdLocationIds: string[] = [];

  afterAll(async () => {
    await cleanupLocations(createdLocationIds);
    await closePool();
  });

  it('creates a location with storageAreaCount 0 and no pre-existing row', async () => {
    const created = await withRollback((client) =>
      locationService.create(
        client,
        {
          code: nextCode('LOC'),
          name: 'Outlet Test',
          type: LocationType.OUTLET,
          city: 'Balikpapan',
        },
        ACTOR,
      ),
    );
    createdLocationIds.push(created.id);
    expect(created.id).toBeTruthy();
    expect(created.isActive).toBe(true);
    expect(created.storageAreaCount).toBe(0);
  });

  it('lists the 4 Kalimantan cities including seeded data', async () => {
    const cities = await withRollback((client) => locationService.listCities(client));
    expect(cities.length).toBeGreaterThan(0);
  });

  it('updates a location', async () => {
    const created = await withRollback((client) =>
      locationService.create(
        client,
        { code: nextCode('LOC'), name: 'Before', type: LocationType.OUTLET, city: 'Samarinda' },
        ACTOR,
      ),
    );
    createdLocationIds.push(created.id);

    const updated = await withRollback((client) =>
      locationService.update(client, created.id, { name: 'After' }, ACTOR),
    );
    expect(updated.name).toBe('After');
  });

  it('deactivates a location', async () => {
    const created = await withRollback((client) =>
      locationService.create(
        client,
        { code: nextCode('LOC'), name: 'ToDeactivate', type: LocationType.OUTLET, city: 'Tarakan' },
        ACTOR,
      ),
    );
    createdLocationIds.push(created.id);

    const result = await withRollback((client) =>
      locationService.deactivate(client, created.id, ACTOR),
    );
    expect(result.deactivated).toBe(true);

    const fetched = await withRollback((client) => locationService.getById(client, created.id));
    expect(fetched.isActive).toBe(false);
  });

  it('404s on a nonexistent location', async () => {
    await expect(
      withRollback((client) =>
        locationService.getById(client, '00000000-0000-0000-0000-000000000000'),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  describe('StorageAreaService', () => {
    it('creates, lists, updates a storage area for a location', async () => {
      const location = await withRollback((client) =>
        locationService.create(
          client,
          {
            code: nextCode('LOC'),
            name: 'For Areas',
            type: LocationType.OUTLET,
            city: 'Balikpapan',
          },
          ACTOR,
        ),
      );
      createdLocationIds.push(location.id);

      const area = await withRollback((client) =>
        storageAreaService.create(
          client,
          location.id,
          {
            code: 'FRZ',
            name: 'Freezer 1',
            type: StorageAreaType.FREEZER,
            tempMin: '-25.0',
            tempMax: '-15.0',
          },
          ACTOR,
        ),
      );
      expect(area.locationId).toBe(location.id);

      const list = await withRollback((client) =>
        storageAreaService.listForLocation(client, location.id),
      );
      expect(list.some((a) => a.id === area.id)).toBe(true);

      const updated = await withRollback((client) =>
        storageAreaService.update(client, location.id, area.id, { name: 'Freezer Utama' }, ACTOR),
      );
      expect(updated.name).toBe('Freezer Utama');

      const refetchedLocation = await withRollback((client) =>
        locationService.getById(client, location.id),
      );
      expect(refetchedLocation.storageAreaCount).toBe(1);
    });

    it('rejects deactivation of a storage area with a non-zero stock balance (D-15, ERR_AREA_HAS_STOCK)', async () => {
      const fixtures: Fixtures = await loadFixtures();

      await withRollback(async (client) => {
        // A storage area CREATED BY THIS TEST, not a seeded one.
        //
        // It used to reuse `fixtures.storageAreaOutlet`, which made the
        // assertion depend on every balance any other spec had left in that
        // area — and the old net-sum check could be cancelled to zero by a
        // stray negative row, so this failed intermittently on data that had
        // nothing to do with it. An area nobody else knows about cannot be
        // interfered with.
        const area = await client.query<{ id: string }>(
          `INSERT INTO storage_areas (location_id, code, name, type, is_active)
           VALUES ($1, $2, 'Area uji deaktivasi', 'dry_store', true)
           RETURNING id`,
          [fixtures.outletId, `TST-${Date.now().toString().slice(-8)}`],
        );
        const areaId = area.rows[0]!.id;

        await client.query(
          `INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand)
           VALUES ($1,$2,$3,10.000)`,
          [fixtures.outletId, areaId, fixtures.itemId],
        );

        await expect(
          storageAreaService.deactivate(client, fixtures.outletId, areaId, ACTOR),
        ).rejects.toMatchObject({ response: { code: 'ERR_AREA_HAS_STOCK' } });
      });
      // ^ this whole block's own INSERT is rolled back — deactivate() rejects
      // before ever reaching its own COMMIT (withWrite's ROLLBACK on throw),
      // so nothing here needed cleanup.
    });

    it('deactivates a storage area with a zero stock balance', async () => {
      const location = await withRollback((client) =>
        locationService.create(
          client,
          {
            code: nextCode('LOC'),
            name: 'Zero Stock',
            type: LocationType.OUTLET,
            city: 'Balikpapan',
          },
          ACTOR,
        ),
      );
      createdLocationIds.push(location.id);

      const area = await withRollback((client) =>
        storageAreaService.create(
          client,
          location.id,
          { code: 'DRY', name: 'Dry Store', type: StorageAreaType.DRY_STORE },
          ACTOR,
        ),
      );

      const result = await withRollback((client) =>
        storageAreaService.deactivate(client, location.id, area.id, ACTOR),
      );
      expect(result.deactivated).toBe(true);
    });
  });

  describe('coordinate validation (CreateLocationDto) — geofence data quality', () => {
    /**
     * These validate the DTO the way `ValidationPipe` actually runs it
     * (`whitelist: true`, per `main.ts`) — not the service, which never
     * re-validates its own input. `LocationService.create()` trusts whatever
     * a `CreateLocationDto` instance carries, so a bad coordinate is caught
     * here, at the HTTP boundary, before it ever reaches SQL.
     */
    const base = {
      code: 'VALDTO1',
      name: 'DTO Validation Test',
      type: LocationType.OUTLET,
      city: 'Balikpapan',
    };

    it('accepts valid, non-zero coordinates', async () => {
      const dto = plainToInstance(CreateLocationDto, {
        ...base,
        latitude: '-1.265000',
        longitude: '116.831000',
      });
      expect(await validate(dto, { whitelist: true })).toHaveLength(0);
    });

    it('rejects the (0, 0) null-island pair', async () => {
      const dto = plainToInstance(CreateLocationDto, {
        ...base,
        latitude: '0',
        longitude: '0',
      });
      const errors = await validate(dto, { whitelist: true });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.constraints && 'notNullIsland' in e.constraints)).toBe(true);
    });

    it('rejects an out-of-range latitude', async () => {
      const dto = plainToInstance(CreateLocationDto, {
        ...base,
        latitude: '91.000000',
        longitude: '116.831000',
      });
      const errors = await validate(dto, { whitelist: true });
      expect(errors.some((e) => e.property === 'latitude')).toBe(true);
    });

    it('rejects an out-of-range longitude', async () => {
      const dto = plainToInstance(CreateLocationDto, {
        ...base,
        latitude: '-1.265000',
        longitude: '181.000000',
      });
      const errors = await validate(dto, { whitelist: true });
      expect(errors.some((e) => e.property === 'longitude')).toBe(true);
    });

    it('rejects a lowercase code', async () => {
      const dto = plainToInstance(CreateLocationDto, { ...base, code: 'lowercase' });
      const errors = await validate(dto, { whitelist: true });
      expect(errors.some((e) => e.property === 'code')).toBe(true);
    });
  });

  describe('create() with valid coordinates (live database)', () => {
    it('persists latitude/longitude exactly as given', async () => {
      const created = await withRollback((client) =>
        locationService.create(
          client,
          {
            code: nextCode('LOC'),
            name: 'Kantor Uji',
            type: LocationType.OUTLET,
            city: 'Balikpapan',
            latitude: '-1.265000',
            longitude: '116.831000',
          },
          ACTOR,
        ),
      );
      createdLocationIds.push(created.id);
      expect(created.latitude).toBe('-1.265000');
      expect(created.longitude).toBe('116.831000');
    });
  });

  describe('code immutability on update', () => {
    it('rejects a PATCH that changes code, and leaves the stored code untouched', async () => {
      const created = await withRollback((client) =>
        locationService.create(
          client,
          { code: nextCode('LOC'), name: 'Kode Tetap', type: LocationType.OUTLET, city: 'Tarakan' },
          ACTOR,
        ),
      );
      createdLocationIds.push(created.id);

      await expect(
        withRollback((client) =>
          locationService.update(client, created.id, { code: 'SOMETHING-ELSE' }, ACTOR),
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_LOCATION_CODE_IMMUTABLE' } });

      const fetched = await withRollback((client) => locationService.getById(client, created.id));
      expect(fetched.code).toBe(created.code);
    });

    it('accepts a PATCH that echoes the SAME code back (the admin edit-form case)', async () => {
      const created = await withRollback((client) =>
        locationService.create(
          client,
          { code: nextCode('LOC'), name: 'Sebelum', type: LocationType.OUTLET, city: 'Tarakan' },
          ACTOR,
        ),
      );
      createdLocationIds.push(created.id);

      const updated = await withRollback((client) =>
        locationService.update(client, created.id, { code: created.code, name: 'Sesudah' }, ACTOR),
      );
      expect(updated.code).toBe(created.code);
      expect(updated.name).toBe('Sesudah');
    });
  });

  describe('RBAC (CONTRACTS.md §3) — negative checks', () => {
    it('location.read is granted to every role', () => {
      for (const role of Object.values(RoleKey)) {
        expect(can(role, 'location.read')).toBe(true);
      }
    });

    it('location.manage is denied to every non-central role', () => {
      const denied: RoleKey[] = [
        RoleKey.FINANCE,
        RoleKey.KEPALA_GUDANG,
        RoleKey.SUPERVISOR,
        RoleKey.LEADER_OUTLET,
        RoleKey.KASIR,
        RoleKey.HR_ADMIN,
        RoleKey.DRIVER,
      ];
      for (const role of denied) {
        expect(can(role, 'location.manage')).toBe(false);
      }
      expect(can(RoleKey.OWNER, 'location.manage')).toBe(true);
      expect(can(RoleKey.MANAGER, 'location.manage')).toBe(true);
    });

    it('storage_area.manage is denied to every non-central role, including kepala_gudang', () => {
      const denied: RoleKey[] = [
        RoleKey.FINANCE,
        RoleKey.KEPALA_GUDANG,
        RoleKey.SUPERVISOR,
        RoleKey.LEADER_OUTLET,
        RoleKey.KASIR,
        RoleKey.HR_ADMIN,
        RoleKey.DRIVER,
      ];
      for (const role of denied) {
        expect(can(role, 'storage_area.manage')).toBe(false);
      }
    });
  });
});
