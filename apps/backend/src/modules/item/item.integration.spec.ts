/**
 * Integration tests for `ItemService`/`ItemCategoryService`/`UnitService`
 * against the live database. See `modules/location/location.integration.spec.ts`
 * for why every test calls a mutating method at most once per `withRollback`
 * block and cleans up explicitly (these services self-commit).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { can, ItemStorageType, RoleKey } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ItemService } from './item.service';
import { ItemCategoryService } from './item-category.service';
import { UnitService } from './unit.service';
import {
  getOwnerPool,
  loadFixtures,
  nextCode,
  withRollback,
  type Fixtures,
} from '../location/test-support/live-db';

const eventsRepo = new SyncEventsRepository();
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(conflictsRepo);
const sync = new SyncEmitService(eventsRepo, conflictDetector);
const itemService = new ItemService(sync);
const categoryService = new ItemCategoryService(sync);
const unitService = new UnitService(sync);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';

async function cleanupItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [itemIds]);
  await pool.query(`DELETE FROM unit_conversions WHERE item_id = ANY($1::uuid[])`, [itemIds]);
  await pool.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [itemIds]);
}

async function cleanupCategories(categoryIds: string[]): Promise<void> {
  if (categoryIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [categoryIds]);
  await pool.query(`DELETE FROM item_categories WHERE id = ANY($1::uuid[])`, [categoryIds]);
}

async function cleanupUnits(unitIds: string[]): Promise<void> {
  if (unitIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [unitIds]);
  await pool.query(`DELETE FROM units WHERE id = ANY($1::uuid[])`, [unitIds]);
}

describe('ItemService / ItemCategoryService / UnitService (live database)', () => {
  let fixtures: Fixtures;
  const createdItemIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdUnitIds: string[] = [];

  const setup = async () => {
    fixtures = await loadFixtures();
  };

  afterAll(async () => {
    await cleanupItems(createdItemIds);
    await cleanupCategories(createdCategoryIds);
    await cleanupUnits(createdUnitIds);
  });

  it('loads fixtures', async () => {
    await setup();
    expect(fixtures.baseUnitId).toBeTruthy();
  });

  it('creates an item, includes cost fields when includeCost=true, hides them otherwise', async () => {
    const created = await withRollback((client) =>
      itemService.create(
        client,
        {
          sku: nextCode('SKU'),
          name: 'Test Item',
          categoryId: fixtures.categoryId,
          baseUnitId: fixtures.baseUnitId,
          storageType: ItemStorageType.DRY,
        },
        ACTOR,
      ),
    );
    createdItemIds.push(created.id);
    expect(created.baseUnit.id).toBe(fixtures.baseUnitId);
    expect(created.avgCost).toBeDefined();

    const withCost = await withRollback((client) => itemService.getById(client, created.id, true));
    expect(withCost.avgCost).toBeDefined();
    expect(withCost.lastPurchaseCost).toBeDefined();

    const withoutCost = await withRollback((client) =>
      itemService.getById(client, created.id, false),
    );
    expect(withoutCost.avgCost).toBeUndefined();
    expect(withoutCost.lastPurchaseCost).toBeUndefined();
  });

  it('updates and deactivates an item', async () => {
    const created = await withRollback((client) =>
      itemService.create(
        client,
        {
          sku: nextCode('SKU'),
          name: 'Before',
          baseUnitId: fixtures.baseUnitId,
          storageType: ItemStorageType.CHILLED,
        },
        ACTOR,
      ),
    );
    createdItemIds.push(created.id);

    const updated = await withRollback((client) =>
      itemService.update(client, created.id, { name: 'After' }, ACTOR),
    );
    expect(updated.name).toBe('After');

    const deactivated = await withRollback((client) =>
      itemService.deactivate(client, created.id, ACTOR),
    );
    expect(deactivated.deactivated).toBe(true);
  });

  it('404s on a nonexistent item', async () => {
    await expect(
      withRollback((client) =>
        itemService.getById(client, '00000000-0000-0000-0000-000000000000', true),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('creates and updates an item category (no delete endpoint per CONTRACTS.md §4.4)', async () => {
    const created = await withRollback((client) =>
      categoryService.create(client, { name: nextCode('Cat') }, ACTOR),
    );
    createdCategoryIds.push(created.id);
    expect(created.sortOrder).toBe(0);

    const updated = await withRollback((client) =>
      categoryService.update(client, created.id, { sortOrder: 5 }, ACTOR),
    );
    expect(updated.sortOrder).toBe(5);
  });

  it('creates a unit and lists it', async () => {
    const created = await withRollback((client) =>
      unitService.createUnit(client, { code: nextCode('U'), name: 'Test Unit' }, ACTOR),
    );
    createdUnitIds.push(created.id);

    const list = await withRollback((client) => unitService.listUnits(client));
    expect(list.some((u) => u.id === created.id)).toBe(true);
  });

  it("replaces an item's unit conversions via PUT (full-replace semantics)", async () => {
    const item = await withRollback((client) =>
      itemService.create(
        client,
        {
          sku: nextCode('SKU'),
          name: 'Conv Item',
          baseUnitId: fixtures.baseUnitId,
          storageType: ItemStorageType.DRY,
        },
        ACTOR,
      ),
    );
    createdItemIds.push(item.id);

    const firstPut = await withRollback((client) =>
      unitService.putConversions(
        client,
        item.id,
        {
          conversions: [
            {
              fromUnitId: fixtures.baseUnitId,
              toUnitId: fixtures.altUnitId,
              factor: '1000.000000',
            },
          ],
        },
        ACTOR,
      ),
    );
    expect(firstPut).toHaveLength(1);
    expect(firstPut[0]!.factor).toBe('1000.000000');

    // A second PUT with an EMPTY list must fully replace (delete) the first — proves this isn't an upsert-only append.
    const secondPut = await withRollback((client) =>
      unitService.putConversions(client, item.id, { conversions: [] }, ACTOR),
    );
    expect(secondPut).toHaveLength(0);

    const fetched = await withRollback((client) => unitService.getConversions(client, item.id));
    expect(fetched).toHaveLength(0);
  });

  describe('RBAC (CONTRACTS.md §3) — negative checks', () => {
    it('item.read is denied to kasir and driver', () => {
      expect(can(RoleKey.KASIR, 'item.read')).toBe(false);
      expect(can(RoleKey.DRIVER, 'item.read')).toBe(false);
    });

    it('item.manage is granted only to owner, manager, kepala_gudang', () => {
      const granted = [RoleKey.OWNER, RoleKey.MANAGER, RoleKey.KEPALA_GUDANG];
      // SUPERADMIN holds every key by construction (RoleKey.SUPERADMIN), so it
      // is excluded from the denied set — the claim under test is about the
      // nine business roles, not the all-access technical account.
      const denied = Object.values(RoleKey).filter(
        (r) => !granted.includes(r) && r !== RoleKey.SUPERADMIN,
      );
      for (const role of granted) expect(can(role, 'item.manage')).toBe(true);
      for (const role of denied) expect(can(role, 'item.manage')).toBe(false);
    });

    it('unit.manage is denied to kepala_gudang (item.manage does not imply unit.manage)', () => {
      expect(can(RoleKey.KEPALA_GUDANG, 'unit.manage')).toBe(false);
      expect(can(RoleKey.OWNER, 'unit.manage')).toBe(true);
    });
  });
});
