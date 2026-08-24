/**
 * Integration tests for `ImportService` against the live database — same
 * harness `modules/item`/`modules/product` already use
 * (`modules/location/test-support/live-db`). Named `.integration.test.ts`
 * (not `.spec.ts`) to match this repo's other `*.integration.test.ts` files
 * (e.g. `modules/pos/pos-shift-flow.integration.test.ts`) rather than the
 * `*.integration.spec.ts` files that predate that convention — either
 * pattern is picked up by `vitest run` the same way.
 *
 * What this file is actually here to prove (the ticket's own list):
 *   1. a clean preview reports every row as would-create/would-update with
 *      zero errors;
 *   2. a bad enum value AND a missing required header column each name the
 *      exact offending column;
 *   3. commit is atomic — one bad row in a batch writes NOTHING, even for
 *      the rows that were individually fine.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { BadRequestException } from '@nestjs/common';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StorageService } from '../../kernel/storage/storage.service';
import { ItemService } from '../item/item.service';
import { ItemCategoryService } from '../item/item-category.service';
import { ProductService } from '../product/product.service';
import { PackageService } from '../product/package.service';
import { ImportService } from './import.service';
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
const itemCategoryService = new ItemCategoryService(sync);
const eventBus = new EventBus();
// Same reasoning as `product.integration.spec.ts`: no fixture in this suite
// ever sets a photo, so `resolvePhotoUrl` returns null before this pool is
// ever touched.
const dummyPool = {
  query: () => {
    throw new Error('StorageService.pool should not be queried in this suite');
  },
} as unknown as Pool;
const storage = new StorageService(new ConfigService(), dummyPool);
const packageService = new PackageService(sync);
const productService = new ProductService(sync, eventBus, storage, packageService);
const importService = new ImportService(itemService, itemCategoryService, productService);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';
const SYSTEM_USER: JwtAccessPayload = {
  sub: ACTOR,
  username: 'system',
  roleKey: 'owner',
  locationIds: [],
};

async function cleanupCategories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM item_categories WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM unit_conversions WHERE item_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupProducts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(
    `DELETE FROM recipe_lines WHERE recipe_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [ids],
  );
  await pool.query(`DELETE FROM recipes WHERE product_id = ANY($1::uuid[])`, [ids]);
  await pool.query(
    `DELETE FROM product_package_lines WHERE package_product_id = ANY($1::uuid[]) OR member_product_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [ids]);
}

/** Byte-for-byte what `GET /import/:entity/preview`'s multipart body decodes to before reaching the service — the service takes the decoded text, not a `File`. */
const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

describe('ImportService (live database)', () => {
  let fixtures: Fixtures;
  const createdCategoryIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdProductIds: string[] = [];

  afterAll(async () => {
    await cleanupItems(createdItemIds);
    await cleanupProducts(createdProductIds);
    await cleanupCategories(createdCategoryIds);
  });

  it('loads fixtures', async () => {
    fixtures = await loadFixtures();
    expect(fixtures.baseUnitId).toBeTruthy();
  });

  describe('preview — clean file', () => {
    it('reports every row as would-create with zero errors, and writes nothing', async () => {
      const name = nextCode('ImportCat');
      const body = csv('name,sort_order', `${name},5`);

      const result = await withRollback((client) =>
        importService.preview(client, 'item_categories', body),
      );

      expect(result.fileErrors).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.createCount).toBe(1);
      expect(result.rows[0]).toMatchObject({ status: 'would-create', naturalKey: name });

      const found = await getOwnerPool().query(`SELECT 1 FROM item_categories WHERE name = $1`, [
        name,
      ]);
      expect(found.rowCount).toBe(0); // preview must never write
    });

    it('reports would-update for a row whose natural key already exists', async () => {
      const created = await withRollback((client) =>
        itemCategoryService.create(client, { name: nextCode('ImportCat') }, ACTOR),
      );
      createdCategoryIds.push(created.id);

      const body = csv('name,sort_order', `${created.name},9`);
      const result = await withRollback((client) =>
        importService.preview(client, 'item_categories', body),
      );

      expect(result.rows[0]).toMatchObject({ status: 'would-update', naturalKey: created.name });
      expect(result.updateCount).toBe(1);
    });
  });

  describe('preview — required-column and enum failures name the exact column', () => {
    it('a missing required header column ("base_unit") is a file-level error naming that column', async () => {
      const body = csv('sku,name,storage_type', 'BPP01,Dada Ayam,frozen');
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.rows).toEqual([]);
      expect(result.fileErrors.some((e) => e.column === 'base_unit')).toBe(true);
    });

    it('a bad enum value is a row-level error naming the "storage_type" column', async () => {
      const body = csv(
        'sku,name,base_unit,storage_type',
        `${nextCode('SKU')},Dada Ayam,kg,lukewarm`,
      );
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.fileErrors).toEqual([]);
      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'storage_type' });
      expect(result.rows[0]!.errors[0]!.message).toMatch(/frozen, chilled, dry/);
    });

    it('an unresolvable foreign key (unknown base_unit code) is a row-level error naming "base_unit"', async () => {
      const body = csv(
        'sku,name,base_unit,storage_type',
        `${nextCode('SKU')},Dada Ayam,NOSUCHUNIT,frozen`,
      );
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'base_unit' });
    });
  });

  describe('commit — atomicity', () => {
    it('refuses a header-invalid file without writing anything', async () => {
      // Missing the only required column ("name") — a genuine header failure,
      // not just a row full of optional-column defaults.
      const body = csv('sort_order', '5');
      await expect(
        withRollback((client) =>
          importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a batch with ONE bad row writes NOTHING — not even the row that was individually valid', async () => {
      const goodName = nextCode('ImportCatGood');
      const body = csv(
        'name,sort_order',
        `${goodName},5`,
        // Second row is bad: sort_order is not a whole number.
        `${nextCode('ImportCatBad')},not-a-number`,
      );

      await expect(
        withRollback((client) =>
          importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The row that on its own would have been perfectly valid must not
      // exist either — that is the whole point of "all or nothing".
      const found = await getOwnerPool().query(`SELECT 1 FROM item_categories WHERE name = $1`, [
        goodName,
      ]);
      expect(found.rowCount).toBe(0);
    });

    it('commits a clean single-row batch and reports one insert', async () => {
      const name = nextCode('ImportCatCommit');
      const body = csv('name,sort_order', `${name},7`);

      const result = await withRollback((client) =>
        importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'item_categories', inserted: 1, updated: 0 });

      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM item_categories WHERE name = $1`,
        [name],
      );
      expect(row.rows).toHaveLength(1);
      createdCategoryIds.push(row.rows[0]!.id);
    });

    it('commits an item that resolves its category and base_unit FKs by name/code', async () => {
      const sku = nextCode('SKU');
      const body = csv('sku,name,base_unit,storage_type', `${sku},Import Test Item,kg,dry`);

      const result = await withRollback((client) =>
        importService.commit(client, 'items', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'items', inserted: 1, updated: 0 });

      const row = await getOwnerPool().query<{ id: string; base_unit_id: string }>(
        `SELECT id, base_unit_id FROM items WHERE sku = $1`,
        [sku],
      );
      expect(row.rows).toHaveLength(1);
      createdItemIds.push(row.rows[0]!.id);
    });

    it('a second commit of the same sku UPDATES rather than duplicating (upsert on the natural key)', async () => {
      const sku = nextCode('SKU');
      await withRollback((client) =>
        importService.commit(
          client,
          'items',
          csv('sku,name,base_unit,storage_type', `${sku},First Name,kg,dry`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      const first = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM items WHERE sku = $1`,
        [sku],
      );
      createdItemIds.push(first.rows[0]!.id);

      const result = await withRollback((client) =>
        importService.commit(
          client,
          'items',
          csv('sku,name,base_unit,storage_type', `${sku},Renamed,kg,dry`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(result).toEqual({ entity: 'items', inserted: 0, updated: 1 });

      const after = await getOwnerPool().query<{ id: string; name: string }>(
        `SELECT id, name FROM items WHERE sku = $1`,
        [sku],
      );
      expect(after.rows).toHaveLength(1); // still exactly one row — not a duplicate
      expect(after.rows[0]!.name).toBe('Renamed');
    });
  });
});
