import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Fixture planting for the anomaly detector specs. Every helper writes through
 * an OWNER connection inside a transaction the spec rolls back, in a window in
 * the year 2099 so no seeded row can fall inside it. Nothing here consumes
 * seeded rows: products, items and sales are minted (`ZZANOM-…`), and the
 * outlets are picked, never modified.
 */

let seq = 0;
const tag = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 4)}`;

export async function pickUser(client: PoolClient): Promise<string> {
  return (await client.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`))
    .rows[0]!.id;
}

/**
 * Active outlets that have NO journal lines at all, so a ledger detector's
 * all-time totals are exactly what the spec planted.
 */
export async function pickCleanOutlets(client: PoolClient, n: number): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT l.id FROM locations l
      WHERE l.type = 'outlet' AND l.is_active
        AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.location_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.location_id = l.id)
      ORDER BY l.code LIMIT $1`,
    [n],
  );
  if (res.rows.length < n) throw new Error(`need ${n} outlets without journal lines`);
  return res.rows.map((r) => r.id);
}

export async function mintProduct(
  client: PoolClient,
  o: { price: number; priceGofood?: number | null; priceShopeefood?: number | null; name?: string },
): Promise<string> {
  const category = (
    await client.query<{ id: string }>(
      `INSERT INTO product_categories (name) VALUES ($1) RETURNING id`,
      [`ZZANOM cat ${tag()}`],
    )
  ).rows[0]!.id;
  const t = tag();
  return (
    await client.query<{ id: string }>(
      `INSERT INTO products (code, name, category_id, price, price_gofood, price_shopeefood)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        `ZZANOM-${t}`,
        o.name ?? `ZZANOM product ${t}`,
        category,
        o.price,
        o.priceGofood ?? null,
        o.priceShopeefood ?? null,
      ],
    )
  ).rows[0]!.id;
}

export async function mintShift(
  client: PoolClient,
  location: string,
  user: string,
  day: string,
): Promise<string> {
  return (
    await client.query<{ id: string }>(
      `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, status, client_id)
       VALUES ($1, $2, $3, ($4::date + time '08:00') AT TIME ZONE 'Asia/Makassar', 'open', gen_random_uuid())
       RETURNING id`,
      [`ZZANOM-S-${tag()}`, location, user, day],
    )
  ).rows[0]!.id;
}

export interface PlantedSale {
  id: string;
  paymentIds: string[];
}

export interface SaleSpec {
  location: string;
  shift: string;
  user: string;
  /** WITA business date. */
  day: string;
  /** WITA clock time, default 12:00. */
  time?: string;
  channel?: string;
  status?: 'completed' | 'voided' | 'refunded';
  lines: { product: string; qty: number; price: number }[];
  payments?: { method: 'cash' | 'qris' | 'bank_transfer'; amount: number }[];
}

export async function plantSale(client: PoolClient, s: SaleSpec): Promise<PlantedSale> {
  const total = s.lines.reduce((n, l) => n + l.qty * l.price, 0);
  const sale = (
    await client.query<{ id: string }>(
      `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, status,
                          subtotal, total, paid_amount, occurred_at, channel)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $6, $6,
               ($7::date + $8::time) AT TIME ZONE 'Asia/Makassar', $9)
       RETURNING id`,
      [
        `ZZA-${tag()}`,
        s.location,
        s.shift,
        s.user,
        s.status ?? 'completed',
        total,
        s.day,
        s.time ?? '12:00',
        s.channel ?? 'walk_in',
      ],
    )
  ).rows[0]!.id;
  let order = 0;
  for (const l of s.lines) {
    await client.query(
      `INSERT INTO sale_lines (sale_id, product_id, qty, unit_price, line_total, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sale, l.product, l.qty, l.price, l.qty * l.price, order++],
    );
  }
  const paymentIds: string[] = [];
  for (const p of s.payments ?? [{ method: 'cash' as const, amount: total }]) {
    paymentIds.push(
      (
        await client.query<{ id: string }>(
          `INSERT INTO sale_payments (sale_id, method, amount, payment_status)
           VALUES ($1, $2, $3, 'paid') RETURNING id`,
          [sale, p.method, p.amount],
        )
      ).rows[0]!.id,
    );
  }
  return { id: sale, paymentIds };
}

/** The same session setup `RlsContextGuard` does per request, applied to an already-open (owner) transaction — so the code under test runs as `app_user` under real RLS over rows the owner just planted. */
export async function becomeAppUser(
  client: PoolClient,
  ctx: { role: string; userId: string; locationIds: readonly string[] },
): Promise<void> {
  await client.query('SET LOCAL ROLE app_user');
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
  await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    ctx.locationIds.join(','),
  ]);
}

export async function mintItem(
  client: PoolClient,
  o: { avgCost: number; name?: string },
): Promise<string> {
  const unit = (await client.query<{ id: string }>(`SELECT id FROM units ORDER BY code LIMIT 1`))
    .rows[0]!.id;
  const t = tag();
  return (
    await client.query<{ id: string }>(
      `INSERT INTO items (sku, name, base_unit_id, storage_type, avg_cost)
       VALUES ($1, $2, $3, 'dry', $4) RETURNING id`,
      [`ZZANOM-${t}`, o.name ?? `ZZANOM item ${t}`, unit, o.avgCost],
    )
  ).rows[0]!.id;
}

export async function mintStorageArea(client: PoolClient, location: string): Promise<string> {
  return (
    await client.query<{ id: string }>(
      `INSERT INTO storage_areas (location_id, code, name, type)
       VALUES ($1, $2, 'ZZANOM area', 'dry_store') RETURNING id`,
      [location, `ZZ${tag()}`.slice(0, 20)],
    )
  ).rows[0]!.id;
}

export interface OpnameSpec {
  location: string;
  area: string;
  user: string;
  /** WITA date the count was taken (at 10:00). */
  day: string;
  lines: { item: string; system: number; counted: number }[];
  /** Stock adjustments to book against the count: `qty` signed, valued at `unitCost`. */
  adjustments?: { item: string; qty: number; unitCost: number }[];
}

export async function plantAdjustedOpname(client: PoolClient, o: OpnameSpec): Promise<string> {
  const id = (
    await client.query<{ id: string }>(
      `INSERT INTO stock_opname (opname_number, location_id, storage_area_id, status, counted_by,
                                 started_at, submitted_at)
       VALUES ($1, $2, $3, 'adjusted', $4,
               ($5::date + time '09:00') AT TIME ZONE 'Asia/Makassar',
               ($5::date + time '10:00') AT TIME ZONE 'Asia/Makassar')
       RETURNING id`,
      [`ZZANOM-OPN-${tag()}`, o.location, o.area, o.user, o.day],
    )
  ).rows[0]!.id;
  for (const l of o.lines) {
    await client.query(
      `INSERT INTO stock_opname_lines (opname_id, storage_area_id, item_id, system_qty, counted_qty, diff_qty)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $5::numeric - $4::numeric)`,
      [id, o.area, l.item, l.system, l.counted],
    );
  }
  for (const a of o.adjustments ?? []) {
    await client.query(
      `INSERT INTO stock_adjustments (adjustment_number, location_id, storage_area_id, item_id, qty_delta,
                                      unit_cost, reason, source, opname_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'ZZANOM', 'opname', $7, $8)`,
      [`ZZANOM-ADJ-${tag()}`, o.location, o.area, a.item, a.qty, a.unitCost, id, o.user],
    );
  }
  return id;
}

/** A recipe-driven `usage_out` as the POS sale posting books it (`ref_type = 'sale'`). */
export async function plantSaleUsage(
  client: PoolClient,
  o: { location: string; area: string; item: string; qty: number; day: string; time?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (location_id, storage_area_id, item_id, movement_type, qty, ref_type, ref_id, occurred_at)
     VALUES ($1, $2, $3, 'usage_out', $4, 'sale', gen_random_uuid(),
             ($5::date + $6::time) AT TIME ZONE 'Asia/Makassar')`,
    [o.location, o.area, o.item, o.qty, o.day, o.time ?? '11:00'],
  );
}
