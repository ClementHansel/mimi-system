/**
 * Integration tests for `ProductService`/`RecipeService` against the live
 * database. See `modules/location/location.integration.spec.ts` for why
 * every test calls a mutating method at most once per `withRollback` block
 * and cleans up explicitly (these services self-commit, matching production
 * — one HTTP request, one COMMIT).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { can, RoleKey } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StorageService } from '../../kernel/storage/storage.service';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';
import { getOwnerPool, loadFixtures, nextCode, withRollback, type Fixtures } from '../location/test-support/live-db';

const eventsRepo = new SyncEventsRepository();
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(conflictsRepo);
const sync = new SyncEmitService(eventsRepo, conflictDetector);
const eventBus = new EventBus();
// No attachment is ever created in this suite (photoAttachmentId stays
// unset), so `resolvePhotoUrl` returns null before ever touching this pool —
// a dummy is safe here without standing up a real MinIO-backed StorageService.
const dummyPool = { query: () => { throw new Error('StorageService.pool should not be queried in this suite'); } } as unknown as Pool;
const storage = new StorageService(new ConfigService(), dummyPool);
const productService = new ProductService(sync, eventBus, storage);
const recipeService = new RecipeService(sync);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';
const SYSTEM_USER: JwtAccessPayload = { sub: ACTOR, username: 'system', roleKey: 'owner', locationIds: [] };

async function cleanupProducts(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [productIds]);
  await pool.query(
    `DELETE FROM sync_events WHERE entity_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [productIds],
  );
  await pool.query(`DELETE FROM recipe_lines WHERE recipe_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`, [productIds]);
  await pool.query(`DELETE FROM recipes WHERE product_id = ANY($1::uuid[])`, [productIds]);
  await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [productIds]);
}

describe('ProductService / RecipeService (live database)', () => {
  let fixtures: Fixtures;
  const createdProductIds: string[] = [];

  afterAll(async () => {
    await cleanupProducts(createdProductIds);
  });

  it('loads fixtures', async () => {
    fixtures = await loadFixtures();
    expect(fixtures.itemId).toBeTruthy();
  });

  it('creates a product with hasRecipe=false and no photo', async () => {
    const created = await withRollback((client) =>
      productService.create(
        client,
        { code: nextCode('PRD'), name: 'Ayam Geprek', category: 'Ayam', price: '25000.00' },
        ACTOR,
        SYSTEM_USER,
        null,
      ),
    );
    createdProductIds.push(created.id);
    expect(created.hasRecipe).toBe(false);
    expect(created.photoUrl).toBeNull();
    expect(created.price).toBe('25000.00');
  });

  it('updates a product and emits product.price_changed on the EventBus only when price actually changes', async () => {
    const created = await withRollback((client) =>
      productService.create(client, { code: nextCode('PRD'), name: 'Before', category: 'Umum', price: '10000.00' }, ACTOR, SYSTEM_USER, null),
    );
    createdProductIds.push(created.id);

    let received: unknown;
    const unsubscribe = eventBus.subscribe('product.price_changed', (event) => {
      received = event.payload;
    });
    try {
      // A non-price update must NOT emit product.price_changed.
      await withRollback((client) => productService.update(client, created.id, { name: 'Renamed' }, ACTOR, SYSTEM_USER, null));
      expect(received).toBeUndefined();

      // A real price change must.
      const updated = await withRollback((client) => productService.update(client, created.id, { price: '30000.00' }, ACTOR, SYSTEM_USER, null));
      expect(updated.price).toBe('30000.00');
      expect(received).toMatchObject({ productId: created.id, oldPrice: '10000.00', newPrice: '30000.00' });
    } finally {
      unsubscribe();
    }
  });

  it('deactivates a product', async () => {
    const created = await withRollback((client) =>
      productService.create(client, { code: nextCode('PRD'), name: 'ToDeactivate', category: 'Umum', price: '5000.00' }, ACTOR, SYSTEM_USER, null),
    );
    createdProductIds.push(created.id);
    const result = await withRollback((client) => productService.deactivate(client, created.id, ACTOR));
    expect(result.deactivated).toBe(true);
  });

  it('404s on a nonexistent product', async () => {
    await expect(
      withRollback((client) => productService.getById(client, '00000000-0000-0000-0000-000000000000', SYSTEM_USER, null)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('GET recipe on a product with no recipe yet returns an empty BOM (not 404)', async () => {
    const created = await withRollback((client) =>
      productService.create(client, { code: nextCode('PRD'), name: 'No Recipe Yet', category: 'Umum', price: '1000.00' }, ACTOR, SYSTEM_USER, null),
    );
    createdProductIds.push(created.id);

    const recipe = await withRollback((client) => recipeService.getRecipe(client, created.id));
    expect(recipe.lines).toEqual([]);
  });

  it('PUT recipe replaces the BOM, sets hasRecipe=true, and the round-tripped recipe explodes correctly', async () => {
    const created = await withRollback((client) =>
      productService.create(client, { code: nextCode('PRD'), name: 'With Recipe', category: 'Ayam', price: '20000.00' }, ACTOR, SYSTEM_USER, null),
    );
    createdProductIds.push(created.id);

    const putResult = await withRollback((client) =>
      recipeService.putRecipe(
        client,
        created.id,
        { yieldQty: '1.000', lines: [{ itemId: fixtures.itemId, qty: '0.150', unitId: fixtures.baseUnitId }] },
        ACTOR,
      ),
    );
    expect(putResult.lines).toHaveLength(1);
    expect(putResult.lines[0]!.itemId).toBe(fixtures.itemId);

    const refetchedProduct = await withRollback((client) => productService.getById(client, created.id, SYSTEM_USER, null));
    expect(refetchedProduct.hasRecipe).toBe(true);

    // Full-replace semantics: a second PUT with a different single line drops the first.
    const secondPut = await withRollback((client) =>
      recipeService.putRecipe(
        client,
        created.id,
        { yieldQty: '2.000', lines: [{ itemId: fixtures.itemId2, qty: '1.000', unitId: fixtures.baseUnitId }] },
        ACTOR,
      ),
    );
    expect(secondPut.lines).toHaveLength(1);
    expect(secondPut.lines[0]!.itemId).toBe(fixtures.itemId2);
    expect(secondPut.lines.some((l) => l.itemId === fixtures.itemId)).toBe(false);

    // DB-backed explosion wrapper (loads the just-persisted recipe, then explodes it) — FR-POS-06.
    const usage = await withRollback((client) => recipeService.explodeForSale(client, created.id, '4.000'));
    expect(usage).toEqual([{ itemId: fixtures.itemId2, qty: '2.000' }]); // yieldQty=2, qtySold=4 → ratio 2 → 1.000×2 = 2.000
  });

  describe('RBAC (CONTRACTS.md §3) — negative checks (both directions)', () => {
    it('product.read is granted to kasir but denied to hr_admin and driver', () => {
      expect(can(RoleKey.KASIR, 'product.read')).toBe(true);
      expect(can(RoleKey.HR_ADMIN, 'product.read')).toBe(false);
      expect(can(RoleKey.DRIVER, 'product.read')).toBe(false);
    });

    it('product.manage is granted only to owner/manager', () => {
      const granted = [RoleKey.OWNER, RoleKey.MANAGER];
      const denied = Object.values(RoleKey).filter((r) => !granted.includes(r));
      for (const role of granted) expect(can(role, 'product.manage')).toBe(true);
      for (const role of denied) expect(can(role, 'product.manage')).toBe(false);
    });

    it('recipe.read is granted to kepala_gudang but denied to supervisor/leader_outlet/kasir (recipe = cost structure)', () => {
      expect(can(RoleKey.KEPALA_GUDANG, 'recipe.read')).toBe(true);
      expect(can(RoleKey.SUPERVISOR, 'recipe.read')).toBe(false);
      expect(can(RoleKey.LEADER_OUTLET, 'recipe.read')).toBe(false);
      expect(can(RoleKey.KASIR, 'recipe.read')).toBe(false);
    });

    it('recipe.manage is granted only to owner/manager', () => {
      expect(can(RoleKey.OWNER, 'recipe.manage')).toBe(true);
      expect(can(RoleKey.MANAGER, 'recipe.manage')).toBe(true);
      expect(can(RoleKey.KEPALA_GUDANG, 'recipe.manage')).toBe(false);
    });
  });
});
