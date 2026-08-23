/**
 * OPERATING HISTORY — months of trading across the whole chain, not a demo day.
 *
 * Owner, 2026-08-23: "need full seeding to simulate real operation."
 *
 * ## Why this exists alongside the other seeds
 *
 * `seed.ts` + `seed-extended.ts` + `seed-gaps.ts` answer "does every table have
 * a row and every screen something to render". They do that well, and this file
 * does not repeat it. What they do NOT produce is VOLUME OR TIME DEPTH: the
 * demo box held 631 sales for 20 outlets and 129 attendance rows for 291
 * employees — roughly one busy day at one branch, spread thin across a chain.
 *
 * That gap is not cosmetic. Most of what the owner bought the system for reads
 * across time:
 *
 *   - trend charts and month-over-month comparisons have nothing to compare
 *   - `mv_item_usage_daily` drives reorder points from consumption history
 *   - variance on a stock opname only means something against a run of usage
 *   - the payroll period, the KPI view and the delivery recap are all daily
 *     rollups of days that did not exist
 *   - and NFR-01 (report p95 under load) cannot be measured against a table
 *     that fits in one page of shared buffers
 *
 * So this script writes a real operating history: every outlet, every shift,
 * every day, for as far back as you ask.
 *
 * ## What it generates, per outlet per day
 *
 *   - three POS shifts (Pagi / Siang / Malam), opened and closed by the kasir
 *     rostered to that shift, with counted cash and a realistic variance
 *   - sales shaped by demand: a per-shift bulge, weekends heavier than midweek,
 *     and a per-outlet size factor so the chain has strong and weak branches
 *     instead of twenty identical ones
 *   - sale lines from the real product list, priced from `products`, weighted so
 *     the cheap bestsellers actually sell best
 *   - payments split cash / QRIS / transfer, with transfers left `pending`
 *     exactly as the real flow leaves them for finance to verify
 *   - attendance for the crew rostered to each shift, with lateness and the
 *     occasional sick day
 *   - one aggregated `usage_out` stock movement per item per outlet per day,
 *     exploded through the real recipes
 *
 * And across the chain: deliveries from Gudang Pusat on a Mon/Wed/Fri rhythm,
 * one Surat Jalan per city route with a drop per outlet, moving stock out of the
 * warehouse and into the branch that received it.
 *
 * ## Two deliberate omissions, so nothing here is quietly wrong
 *
 * **1. No journal entries.** The posting rules live in the accounting engine and
 * `POST /api/accounting/daily-posting` is the supported way to produce entries
 * for a business day. Reimplementing those rules here would create a second
 * source of truth for the general ledger that could only ever agree with the
 * first by accident. Generate the history, then back-post the days you care
 * about through the API; `GET /api/accounting/gl-coverage` reports what is still
 * unposted.
 *
 * **2. Nothing in `audit_log`, `sessions`, `sync_events` or `notifications`.**
 * Those are records of things people and devices DID. Fabricating them puts
 * fiction in the evidence trail, which is the one place fiction is never
 * acceptable. `seed-gaps.ts` made the same call and it still holds.
 *
 * ## Determinism and idempotency
 *
 * There is no `Math.random()` here. Every value comes from a PRNG seeded from
 * the thing it describes (`BPP01-2026-06-14-p-sale-37`), so the same arguments
 * always produce byte-identical data. That is what makes re-running safe: every
 * insert carries a stable id and `ON CONFLICT DO NOTHING`, so a second run over
 * the same window is a no-op rather than a doubling, and widening the window
 * writes only the new days.
 *
 * Stock balances are the exception, and are handled by REPLAYING rather than
 * incrementing: after the movements are written, every affected balance is
 * recomputed from the full `stock_movements` history for that cell. An
 * increment would double on a re-run; a recompute cannot.
 *
 * ## Usage
 *
 *   npx tsx database/seed-history.ts --days=90
 *   npx tsx database/seed-history.ts --days=180 --orders=160
 *   npx tsx database/seed-history.ts --days=30 --outlets=BPP01,BPP02
 *   npx tsx database/seed-history.ts --days=90 --dry-run
 *
 *   --days=N      how far back to generate (default 90). Excludes today, which
 *                 belongs to whoever is using the system right now.
 *   --orders=N    average orders per outlet per DAY at a mid-size branch
 *                 (default 120). The per-outlet factor swings this ±40%.
 *   --outlets=... comma-separated codes; default is every active outlet.
 *   --dry-run     report what it would write, then ROLLBACK. Commits nothing.
 *
 * Environment: DATABASE_MIGRATION_URL — the DDL-owning role. Like `seed.ts`,
 * this writes to every table without setting any `app.*` session variable, so it
 * must NOT run as `mimi_app` (D-21/D-22).
 *
 * ## Cost
 *
 * 90 days × 20 outlets × 120 orders is around 216,000 sales and 400,000 sale
 * lines. That is the point — it is what a quarter of trading looks like — but it
 * is not free: expect minutes and a few hundred MB. Try `--days=7` against a
 * throwaway database first if you want to see the shape.
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** Stable UUID from any string — same convention as `seed.ts`. */
function stableUuid(seed: string): string {
  const h = createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A PRNG seeded from a STRING, not from a shared global counter.
 *
 * The distinction matters more than it looks. With one shared generator every
 * value depends on how many values were drawn before it, so adding a single
 * waste record in the middle of a run shifts every subsequent sale and the
 * re-run stops matching the original. Seeding per-thing — this sale, at this
 * branch, on this date — makes each draw independent of everything around it,
 * which is what lets the window be widened later without rewriting history.
 */
function rngFor(seed: string): () => number {
  let a = parseInt(createHash('md5').update(seed).digest('hex').slice(0, 8), 16);
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intBetween = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

/** Pick from a list of `[value, weight]` pairs. */
function weighted<T>(r: () => number, pairs: [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) {
    x -= w;
    if (x <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------------------
// WITA dates
// ---------------------------------------------------------------------------

/**
 * The business day is `Asia/Makassar` (UTC+8) and every WITA-keyed index in the
 * schema agrees, so timestamps are built as UTC instants that land on the
 * intended WITA wall-clock hour: 08:00 WITA is 00:00Z. Building them in machine
 * local time would make the data depend on where the script ran, and this runs
 * from Windows against a Linux server.
 */
const WITA_OFFSET_HOURS = 8;

/** The WITA business date `n` days before today, as `YYYY-MM-DD`. */
function witaDate(daysAgo: number): string {
  const wita = new Date(Date.now() + WITA_OFFSET_HOURS * 3600_000);
  wita.setUTCDate(wita.getUTCDate() - daysAgo);
  return wita.toISOString().slice(0, 10);
}

/** An instant that reads as `hour:minute` WITA on the given business date. */
function witaInstant(date: string, hour: number, minute: number): Date {
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      hour - WITA_OFFSET_HOURS,
      minute,
    ),
  );
}

/** 0 = Sunday. Read off the date string, so it is not machine-dependent. */
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The Monday of this date's week, as `YYYY-MM-DD`. Sunday belongs to the week before. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/** `n` days before a `YYYY-MM-DD` date. */
function dateMinus(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The shape of a trading day
// ---------------------------------------------------------------------------

interface ShiftDef {
  /** Username suffix in the org model: `kasir_bpp01_p`. */
  slot: 'p' | 's' | 'm';
  label: string;
  openHour: number;
  closeHour: number;
  /** Share of the day's orders. Dinner outsells lunch outsells late. */
  demandShare: number;
}

const SHIFTS: ShiftDef[] = [
  { slot: 'p', label: 'Pagi', openHour: 8, closeHour: 14, demandShare: 0.3 },
  { slot: 's', label: 'Siang', openHour: 14, closeHour: 20, demandShare: 0.45 },
  { slot: 'm', label: 'Malam', openHour: 20, closeHour: 23, demandShare: 0.25 },
];

/** Indexed by `getUTCDay()`. Friday and Saturday carry a fried-chicken outlet. */
const WEEKDAY_FACTOR = [0.95, 0.85, 0.9, 0.95, 1.0, 1.25, 1.3];

const OPENING_FLOAT = 300_000;

/** Movement types that ADD to a balance; everything else subtracts. */
const INBOUND_MOVEMENTS = [
  'opening_balance',
  'purchase_in',
  'transfer_in',
  'return_in',
  'adjustment_in',
];

// ---------------------------------------------------------------------------
// Bulk insert
// ---------------------------------------------------------------------------

/**
 * Multi-row INSERT, chunked.
 *
 * Row-at-a-time is the natural way to write a seed, and it is why the existing
 * seeds stop at a few hundred rows: 216,000 sales is 216,000 round trips, which
 * over a forwarded connection is hours rather than minutes. Chunked multi-row
 * inserts turn it into a few hundred statements. The chunk size keeps the bind
 * parameter count under Postgres's 65,535 limit with room to spare.
 */
async function bulkInsert(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const perChunk = Math.max(1, Math.floor(60000 / columns.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const res = await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict}`,
      params,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

interface Outlet {
  id: string;
  code: string;
  /** 0.6 .. 1.4, derived from the code so a branch is the same size every run. */
  sizeFactor: number;
  /** storage area code -> id. */
  areas: Record<string, string>;
  /** storage area TYPE -> id, which is how items address their home. */
  areasByType: Record<string, string>;
  /** shift slot -> kasir user id. */
  kasir: Record<string, string>;
  crew: { userId: string; employeeId: string; slot: string; position: string }[];
}

interface Product {
  id: string;
  price: number;
  /** Sales weight. */
  popularity: number;
  /** Exploded recipe: qty of each item consumed per ONE product sold. */
  items: { itemId: string; qty: number }[];
}

interface ItemMeta {
  cost: number;
  storageType: string;
  unitId: string;
}

async function loadReference(client: pg.Client, only: string[] | null) {
  const locRes = await client.query(
    `SELECT id, code, type FROM locations WHERE is_active ORDER BY code`,
  );
  const gudang = locRes.rows.find((l) => l.type === 'warehouse');
  if (!gudang) throw new Error('No warehouse location — run seed.ts first.');

  const areaRes = await client.query(`SELECT id, location_id, code, type FROM storage_areas`);
  const areasByLoc = new Map<string, Record<string, string>>();
  const areasByType = new Map<string, Record<string, string>>();
  for (const a of areaRes.rows) {
    if (!areasByLoc.has(a.location_id)) areasByLoc.set(a.location_id, {});
    if (!areasByType.has(a.location_id)) areasByType.set(a.location_id, {});
    areasByLoc.get(a.location_id)![a.code] = a.id;
    // First area of a type wins; the seed gives each location one of each.
    areasByType.get(a.location_id)![a.type] ??= a.id;
  }

  const userRes = await client.query(`SELECT id, username FROM users WHERE is_active`);
  const userByName = new Map<string, string>(userRes.rows.map((u) => [u.username, u.id]));

  const empRes = await client.query(`SELECT id, user_id FROM employees WHERE user_id IS NOT NULL`);
  const empByUser = new Map<string, string>(empRes.rows.map((e) => [e.user_id, e.id]));

  const outlets: Outlet[] = [];
  for (const l of locRes.rows) {
    if (l.type !== 'outlet') continue;
    if (only && !only.includes(l.code)) continue;
    const lc = l.code.toLowerCase();
    const kasir: Record<string, string> = {};
    const crew: Outlet['crew'] = [];
    for (const s of SHIFTS) {
      const kasirId = userByName.get(`kasir_${lc}_${s.slot}`);
      if (kasirId) kasir[s.slot] = kasirId;
      for (const position of ['spv', 'kasir', 'koki1', 'koki2']) {
        const userId = userByName.get(`${position}_${lc}_${s.slot}`);
        const employeeId = userId ? empByUser.get(userId) : undefined;
        if (userId && employeeId) crew.push({ userId, employeeId, slot: s.slot, position });
      }
    }
    if (Object.keys(kasir).length === 0) {
      console.warn(`  ! ${l.code}: no kasir user (kasir_${lc}_p …) — skipped`);
      continue;
    }
    outlets.push({
      id: l.id,
      code: l.code,
      sizeFactor: 0.6 + rngFor(`size-${l.code}`)() * 0.8,
      areas: areasByLoc.get(l.id) ?? {},
      areasByType: areasByType.get(l.id) ?? {},
      kasir,
      crew,
    });
  }
  if (outlets.length === 0) throw new Error('No outlets matched — check --outlets and the seed.');

  // Products, with their recipes exploded once up front. `yield_qty` is the
  // batch the recipe produces, so per-unit consumption is qty / yield — the same
  // scaling `packages/shared/src/recipe/explosion.ts` applies.
  const prodRes = await client.query(
    `SELECT p.id, p.price, r.yield_qty
       FROM products p
       LEFT JOIN recipes r ON r.product_id = p.id AND r.is_active
      WHERE p.is_active`,
  );
  const lineRes = await client.query(
    `SELECT r.product_id, rl.item_id, rl.qty
       FROM recipe_lines rl
       JOIN recipes r ON r.id = rl.recipe_id
      WHERE r.is_active`,
  );
  const linesByProduct = new Map<string, { item_id: string; qty: string }[]>();
  for (const l of lineRes.rows) {
    if (!linesByProduct.has(l.product_id)) linesByProduct.set(l.product_id, []);
    linesByProduct.get(l.product_id)!.push(l);
  }
  const products: Product[] = prodRes.rows.map((p) => {
    const yieldQty = Number(p.yield_qty ?? 1) || 1;
    const price = Number(p.price);
    return {
      id: p.id,
      price,
      // Cheap things sell more. A flat mix makes every branch's top-seller
      // report identical noise.
      popularity: Math.max(1, Math.round(120000 / Math.max(5000, price))),
      items: (linesByProduct.get(p.id) ?? []).map((l) => ({
        itemId: l.item_id,
        qty: Number(l.qty) / yieldQty,
      })),
    };
  });
  if (products.length === 0) throw new Error('No active products — run seed.ts first.');

  const itemRes = await client.query(
    `SELECT id, avg_cost, storage_type, base_unit_id FROM items WHERE is_active`,
  );
  const itemMeta = new Map<string, ItemMeta>(
    itemRes.rows.map((i) => [
      i.id,
      {
        cost: Number(i.avg_cost ?? 0),
        storageType: i.storage_type ?? 'dry_store',
        unitId: i.base_unit_id,
      },
    ]),
  );

  // Who supplies what, and at what price. `is_preferred` first, then whichever
  // supplier the seed happens to list — a real warehouse has one habitual
  // source per item and only shops around when it has to.
  const supplierRes = await client.query(
    `SELECT id, payment_terms_days FROM suppliers WHERE is_active ORDER BY code`,
  );
  const supplierItemRes = await client.query(
    `SELECT supplier_id, item_id, current_price, is_preferred FROM supplier_items
      ORDER BY is_preferred DESC, supplier_id`,
  );
  const supplierForItem = new Map<string, string>();
  const supplierPrice = new Map<string, number>();
  for (const si of supplierItemRes.rows) {
    if (!supplierForItem.has(si.item_id)) supplierForItem.set(si.item_id, si.supplier_id);
    supplierPrice.set(`${si.supplier_id}|${si.item_id}`, Number(si.current_price ?? 0));
  }

  const driverRes = await client.query(`SELECT id FROM drivers ORDER BY id`);
  const vehicleRes = await client.query(`SELECT id FROM vehicles ORDER BY plate_number`);
  const shipRes = await client.query(`SELECT id FROM shipment_types ORDER BY name`);

  return {
    gudang,
    outlets,
    products,
    itemMeta,
    gudangAreasByType: areasByType.get(gudang.id) ?? {},
    userByName,
    suppliers: supplierRes.rows as { id: string; payment_terms_days: number }[],
    supplierForItem,
    supplierPrice,
    drivers: driverRes.rows.map((d) => d.id as string),
    vehicles: vehicleRes.rows.map((v) => v.id as string),
    shipmentTypes: shipRes.rows.map((s) => s.id as string),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function argNumber(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.split('=')[1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return Math.floor(n);
}

async function main(): Promise<void> {
  const days = argNumber('days', 90);
  const ordersPerDay = argNumber('orders', 120);
  const dryRun = process.argv.includes('--dry-run');
  const outletArg = process.argv.find((a) => a.startsWith('--outlets='));
  const only = outletArg
    ? outletArg
        .split('=')[1]
        .split(',')
        .map((c) => c.trim().toUpperCase())
    : null;

  const connectionString =
    process.env.DATABASE_MIGRATION_URL || 'postgresql://mimi:mimi_secret@localhost:5432/mimi';
  // No statement timeout: the balance replay and the matview refresh are both
  // legitimately long on a quarter of history, and being killed halfway is
  // worse than being slow.
  const client = new Client({ connectionString, statement_timeout: 0 });
  await client.connect();

  const started = Date.now();
  try {
    await client.query('BEGIN');
    const ref = await loadReference(client, only);

    console.log(
      `\nOperating history — ${dryRun ? 'DRY RUN, nothing will be committed' : 'writing'}\n`,
    );
    console.log(`  window     last ${days} days, excluding today`);
    console.log(
      `  outlets    ${ref.outlets.length}  (${ref.outlets.map((o) => o.code).join(', ')})`,
    );
    console.log(`  demand     ~${ordersPerDay} orders/day at a mid-size branch, ±40% by branch`);
    console.log(`  products   ${ref.products.length}\n`);

    const counts: Record<string, number> = {};
    const bump = (k: string, n: number): void => {
      counts[k] = (counts[k] ?? 0) + n;
    };
    /** Every (location, area, item) cell this run touched, for the balance replay. */
    const touched = new Set<string>();
    /** `${outletId}|${itemId}` -> total qty consumed across the whole window. */
    const usageTotals = new Map<string, number>();

    // -----------------------------------------------------------------------
    // Trading: shifts, sales, lines, payments, attendance, usage
    // -----------------------------------------------------------------------
    //
    // Batched a DAY at a time rather than accumulating the whole window: a
    // quarter's sales held in one array before the first insert is hundreds of
    // MB of JS objects, and the run would look frozen until the end.
    for (let d = days; d >= 1; d--) {
      const date = witaDate(d);
      const dayFactor = WEEKDAY_FACTOR[dayOfWeek(date)];

      const shiftRows: unknown[][] = [];
      const saleRows: unknown[][] = [];
      const lineRows: unknown[][] = [];
      const payRows: unknown[][] = [];
      const attRows: unknown[][] = [];
      const moveRows: unknown[][] = [];

      for (const outlet of ref.outlets) {
        /** item id -> qty consumed at this outlet today, across all three shifts. */
        const usage = new Map<string, number>();

        for (const shift of SHIFTS) {
          const kasirId = outlet.kasir[shift.slot];
          if (!kasirId) continue;

          const shiftKey = `${outlet.code}-${date}-${shift.slot}`;
          const shiftId = stableUuid(`shift-${shiftKey}`);
          const shiftRng = rngFor(shiftKey);

          const target = Math.max(
            1,
            Math.round(
              ordersPerDay *
                outlet.sizeFactor *
                dayFactor *
                shift.demandShare *
                (0.85 + shiftRng() * 0.3),
            ),
          );

          let gross = 0;
          let seq = 0;
          for (let s = 0; s < target; s++) {
            const saleKey = `${shiftKey}-sale-${s}`;
            const saleId = stableUuid(saleKey);
            const saleRng = rngFor(saleKey);

            const lineCount = weighted(saleRng, [
              [1, 30],
              [2, 35],
              [3, 22],
              [4, 9],
              [5, 4],
            ]);
            let subtotal = 0;
            let written = 0;
            const chosen = new Set<string>();
            for (let l = 0; l < lineCount; l++) {
              const product = weighted(
                rngFor(`${saleKey}-pick-${l}`),
                ref.products.map((p) => [p, p.popularity] as [Product, number]),
              );
              // One row per product per receipt. `sale_lines` has no uniqueness
              // constraint to stop a repeat, but a receipt listing the same item
              // on two lines is a POS bug, not a realistic receipt.
              if (chosen.has(product.id)) continue;
              chosen.add(product.id);
              const qty = weighted(rngFor(`${saleKey}-qty-${l}`), [
                [1, 70],
                [2, 22],
                [3, 8],
              ]);
              const lineTotal = product.price * qty;
              subtotal += lineTotal;
              lineRows.push([
                stableUuid(`${saleKey}-line-${product.id}`),
                saleId,
                product.id,
                qty,
                product.price.toFixed(2),
                lineTotal.toFixed(2),
                written,
              ]);
              written += 1;
              for (const ing of product.items) {
                usage.set(ing.itemId, (usage.get(ing.itemId) ?? 0) + ing.qty * qty);
              }
            }
            if (written === 0) continue;
            seq += 1;
            gross += subtotal;

            // Spread across the shift with a bulge in the middle: averaging two
            // uniform draws is a crude triangular distribution, which puts the
            // rush where a rush belongs instead of smearing orders evenly from
            // open to close.
            const span = shift.closeHour - shift.openHour;
            const frac = (rngFor(`${saleKey}-t1`)() + rngFor(`${saleKey}-t2`)()) / 2;
            const minutesIn = Math.floor(frac * span * 60);
            const occurredAt = witaInstant(
              date,
              shift.openHour + Math.floor(minutesIn / 60),
              minutesIn % 60,
            );

            const method = weighted(rngFor(`${saleKey}-pay`), [
              ['cash', 55],
              ['qris', 35],
              ['bank_transfer', 10],
            ] as [string, number][]);
            // Cash customers hand over a round note and take change; QRIS and
            // transfer are always exact.
            const paid = method === 'cash' ? Math.ceil(subtotal / 5000) * 5000 : subtotal;

            saleRows.push([
              saleId,
              `${outlet.code}-${date.replace(/-/g, '')}-${shift.slot.toUpperCase()}${String(seq).padStart(3, '0')}`,
              stableUuid(`${saleKey}-client`),
              outlet.id,
              shiftId,
              kasirId,
              subtotal.toFixed(2),
              subtotal.toFixed(2),
              paid.toFixed(2),
              (paid - subtotal).toFixed(2),
              occurredAt,
            ]);
            payRows.push([
              stableUuid(`${saleKey}-payment`),
              saleId,
              method,
              subtotal.toFixed(2),
              // Transfers sit unverified, because that is where the real flow
              // leaves them. A verification queue that is always empty is how a
              // verification step quietly stops being tested.
              method === 'cash' ? 'paid' : method === 'qris' ? 'verified' : 'pending',
            ]);
          }

          // Cash reconciliation. Three shifts in four balance exactly; the rest
          // are a little short, occasionally over. Always-zero variance would
          // leave the variance report and its approval chain with nothing to
          // show.
          const cashRng = rngFor(`${shiftKey}-cash`);
          const expected = OPENING_FLOAT + gross * 0.55;
          const variance =
            cashRng() < 0.75 ? 0 : Math.round(((cashRng() - 0.6) * 120_000) / 500) * 500;
          shiftRows.push([
            shiftId,
            `${outlet.code}-POS1-${date.replace(/-/g, '')}-${shift.slot.toUpperCase()}`,
            outlet.id,
            kasirId,
            witaInstant(date, shift.openHour, 0),
            OPENING_FLOAT,
            kasirId,
            witaInstant(date, shift.closeHour, intBetween(cashRng, 5, 35)),
            (expected + variance).toFixed(2),
            expected.toFixed(2),
            variance.toFixed(2),
            'closed',
            seq,
            gross.toFixed(2),
            stableUuid(`${shiftKey}-client`),
          ]);

          // Attendance for the crew rostered to this shift.
          for (const member of outlet.crew) {
            if (member.slot !== shift.slot) continue;
            const attRng = rngFor(`${shiftKey}-att-${member.position}`);
            const roll = attRng();
            const status =
              roll < 0.02 ? 'sick' : roll < 0.035 ? 'permission' : roll < 0.16 ? 'late' : 'present';
            const away = status === 'sick' || status === 'permission';
            const lateMinutes = status === 'late' ? intBetween(attRng, 6, 40) : 0;
            const inAt = away
              ? null
              : witaInstant(date, shift.openHour, lateMinutes - intBetween(attRng, 0, 10));
            const outAt = away
              ? null
              : witaInstant(date, shift.closeHour, intBetween(attRng, 0, 25));
            attRows.push([
              stableUuid(`att-${shiftKey}-${member.employeeId}`),
              member.employeeId,
              outlet.id,
              date,
              inAt,
              outAt,
              status,
              lateMinutes,
              inAt && outAt ? Math.round((outAt.getTime() - inAt.getTime()) / 60000) : null,
              stableUuid(`att-${shiftKey}-${member.employeeId}-client`),
            ]);
          }
        }

        // One aggregated usage_out per item per outlet per day. Per-SALE
        // movements would be the literal truth and would also be several million
        // rows for a quarter — and every consumer of this data
        // (mv_item_usage_daily, reorder points, opname variance) reads it at the
        // daily grain anyway. `ref_type + ref_id` is the idempotency key that
        // `uq_stock_movements_natural_key` already enforces.
        const usageRefId = stableUuid(`usage-${outlet.code}-${date}`);
        for (const [itemId, qty] of usage) {
          if (qty <= 0) continue;
          const meta = ref.itemMeta.get(itemId);
          const areaId =
            (meta && outlet.areasByType[meta.storageType]) ??
            outlet.areas['DRY'] ??
            Object.values(outlet.areas)[0];
          if (!areaId) continue;
          moveRows.push([
            outlet.id,
            areaId,
            itemId,
            'usage_out',
            qty.toFixed(3),
            (meta?.cost ?? 0).toFixed(2),
            'sales_day',
            usageRefId,
            witaInstant(date, 23, 30),
          ]);
          touched.add(`${outlet.id}|${areaId}|${itemId}`);
          // Carried into the replenishment pass below. Sizing deliveries from
          // what a branch ACTUALLY consumed is the only way the two halves of
          // the simulation stay in balance — see the note there.
          const usageKey = `${outlet.id}|${itemId}`;
          usageTotals.set(usageKey, (usageTotals.get(usageKey) ?? 0) + qty);
        }
      }

      // Order matters: sales reference the shift, lines and payments reference
      // the sale.
      bump(
        'pos_shifts',
        await bulkInsert(
          client,
          'pos_shifts',
          [
            'id',
            'shift_number',
            'location_id',
            'opened_by',
            'opened_at',
            'opening_cash',
            'closed_by',
            'closed_at',
            'closing_cash_counted',
            'expected_cash',
            'cash_variance',
            'status',
            'sales_count',
            'gross_sales',
            'client_id',
          ],
          shiftRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'sales',
        await bulkInsert(
          client,
          'sales',
          [
            'id',
            'receipt_number',
            'client_id',
            'location_id',
            'shift_id',
            'kasir_id',
            'subtotal',
            'total',
            'paid_amount',
            'change_amount',
            'occurred_at',
          ],
          saleRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'sale_lines',
        await bulkInsert(
          client,
          'sale_lines',
          ['id', 'sale_id', 'product_id', 'qty', 'unit_price', 'line_total', 'sort_order'],
          lineRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'sale_payments',
        await bulkInsert(
          client,
          'sale_payments',
          ['id', 'sale_id', 'method', 'amount', 'payment_status'],
          payRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'attendance',
        await bulkInsert(
          client,
          'attendance',
          [
            'id',
            'employee_id',
            'location_id',
            'date',
            'check_in_at',
            'check_out_at',
            'status',
            'late_minutes',
            'work_minutes',
            'client_id',
          ],
          attRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'stock_movements',
        await bulkInsert(
          client,
          'stock_movements',
          [
            'location_id',
            'storage_area_id',
            'item_id',
            'movement_type',
            'qty',
            'unit_cost',
            'ref_type',
            'ref_id',
            'occurred_at',
          ],
          moveRows,
          'ON CONFLICT DO NOTHING',
        ),
      );

      if (d % 15 === 0 || d === 1) {
        const pct = Math.round(((days - d + 1) / days) * 100);
        console.log(`  ${date}  ${String(pct).padStart(3)}%   ${counts.sales ?? 0} sales`);
      }
    }

    // -----------------------------------------------------------------------
    // Replenishment: Gudang Pusat -> the outlets, Mon / Wed / Fri
    // -----------------------------------------------------------------------
    if (ref.drivers.length && ref.vehicles.length && ref.shipmentTypes.length) {
      // One route per city, because that is how the trucks actually run: a
      // driver loads a van, visits every branch in one city, and comes back.
      const cities = new Map<string, Outlet[]>();
      for (const o of ref.outlets) {
        const city = o.code.replace(/\d+$/, '');
        if (!cities.has(city)) cities.set(city, []);
        cities.get(city)!.push(o);
      }
      // Worth restocking: the items the recipes actually consume.
      const consumed = [...new Set(ref.products.flatMap((p) => p.items.map((i) => i.itemId)))];
      const dispatcher = ref.userByName.get('gudang1') ?? ref.userByName.get('owner');

      // Mon/Wed/Fri is a 7/3-day cycle on average. Each trip carries a shade
      // MORE than one cycle of consumption, so a branch drifts slowly upwards
      // rather than slowly to zero.
      //
      // The first cut of this sized deliveries from a random 8–60 units and left
      // 48% of every stock cell clamped at zero after a single week — a chain
      // that reads "out of stock" on half its item list is not a simulation of
      // real operation, it is a simulation of a collapse. Consumption is the
      // only figure that makes the two halves agree.
      const DELIVERY_CYCLE_DAYS = 7 / 3;
      const COVER_FACTOR = 1.08;
      const perTrip = (outletId: string, itemId: string, jitter: number): number => {
        const total = usageTotals.get(`${outletId}|${itemId}`) ?? 0;
        if (total <= 0) return 0;
        return Math.ceil((total / days) * DELIVERY_CYCLE_DAYS * COVER_FACTOR * jitter);
      };

      const sjRows: unknown[][] = [];
      const dropRows: unknown[][] = [];
      const sjLineRows: unknown[][] = [];
      const deliveryMoves: unknown[][] = [];
      /** ISO week start -> item id -> qty leaving the warehouse that week. */
      const outboundByWeek = new Map<string, Map<string, number>>();

      for (let d = days; d >= 1; d--) {
        const date = witaDate(d);
        if (![1, 3, 5].includes(dayOfWeek(date))) continue;
        // The Monday this delivery belongs to. Warehouse purchasing below buys
        // a week at a time, which is how a warehouse actually orders — you do
        // not raise a purchase order per van.
        const weekKey = mondayOf(date);
        let routeSeq = 0;
        for (const [city, branches] of cities) {
          routeSeq += 1;
          const key = `sj-${city}-${date}`;
          const routeRng = rngFor(key);
          const sjId = stableUuid(key);
          const dispatchedAt = witaInstant(date, 6, 0);
          sjRows.push([
            sjId,
            `SJ-${date.replace(/-/g, '')}-${city}-${String(routeSeq).padStart(2, '0')}`,
            ref.gudang.id,
            ref.shipmentTypes[routeSeq % ref.shipmentTypes.length],
            ref.drivers[routeSeq % ref.drivers.length],
            ref.vehicles[routeSeq % ref.vehicles.length],
            'completed',
            date,
            dispatchedAt,
            witaInstant(date, 6 + branches.length, 30),
            dispatcher,
          ]);

          let seq = 0;
          for (const branch of branches) {
            seq += 1;
            const dropId = stableUuid(`${key}-drop-${branch.code}`);
            const arrivedAt = witaInstant(date, 6 + seq, intBetween(routeRng, 0, 50));
            const receiver =
              branch.crew.find((c) => c.position === 'spv' && c.slot === 'p')?.userId ??
              branch.kasir['p'];
            dropRows.push([
              dropId,
              sjId,
              seq,
              branch.id,
              'completed',
              dispatchedAt,
              arrivedAt,
              receiver,
              arrivedAt,
              stableUuid(`${key}-drop-${branch.code}-client`),
            ]);

            // One cycle of this branch's real consumption, jittered. NOT an
            // exact refill: a replenishment is a judgement made against a min
            // rule, and a perfectly balanced one would never trip the stock-out
            // warnings the reorder screens exist to show.
            for (const itemId of consumed) {
              const meta = ref.itemMeta.get(itemId);
              if (!meta) continue;
              const fromArea =
                ref.gudangAreasByType[meta.storageType] ?? Object.values(ref.gudangAreasByType)[0];
              const toArea =
                branch.areasByType[meta.storageType] ??
                branch.areas['DRY'] ??
                Object.values(branch.areas)[0];
              if (!fromArea || !toArea) continue;
              const jitter = 0.85 + rngFor(`${key}-${branch.code}-qty-${itemId}`)() * 0.4;
              const qty = perTrip(branch.id, itemId, jitter);
              // An item this branch does not use, or uses in traces too small to
              // fill a unit, does not go on the truck.
              if (qty < 1) continue;
              if (!outboundByWeek.has(weekKey)) outboundByWeek.set(weekKey, new Map());
              const week = outboundByWeek.get(weekKey)!;
              week.set(itemId, (week.get(itemId) ?? 0) + qty);
              sjLineRows.push([
                stableUuid(`${key}-${branch.code}-line-${itemId}`),
                sjId,
                dropId,
                itemId,
                meta.unitId,
                qty,
                qty,
                toArea,
              ]);
              deliveryMoves.push([
                ref.gudang.id,
                fromArea,
                itemId,
                'transfer_out',
                qty,
                meta.cost.toFixed(2),
                'surat_jalan',
                dropId,
                branch.id,
                toArea,
                dispatchedAt,
              ]);
              deliveryMoves.push([
                branch.id,
                toArea,
                itemId,
                'transfer_in',
                qty,
                meta.cost.toFixed(2),
                'surat_jalan',
                dropId,
                ref.gudang.id,
                fromArea,
                arrivedAt,
              ]);
              touched.add(`${ref.gudang.id}|${fromArea}|${itemId}`);
              touched.add(`${branch.id}|${toArea}|${itemId}`);
            }
          }
        }
      }

      bump(
        'surat_jalan',
        await bulkInsert(
          client,
          'surat_jalan',
          [
            'id',
            'sj_number',
            'origin_location_id',
            'shipment_type_id',
            'driver_id',
            'vehicle_id',
            'status',
            'planned_date',
            'dispatched_at',
            'completed_at',
            'created_by',
          ],
          sjRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'sj_drops',
        await bulkInsert(
          client,
          'sj_drops',
          [
            'id',
            'sj_id',
            'drop_seq',
            'location_id',
            'status',
            'departed_at',
            'arrived_at',
            'received_by',
            'received_at',
            'client_id',
          ],
          dropRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'sj_lines',
        await bulkInsert(
          client,
          'sj_lines',
          [
            'id',
            'sj_id',
            'drop_id',
            'item_id',
            'unit_id',
            'qty',
            'qty_received',
            'received_storage_area_id',
          ],
          sjLineRows,
          'ON CONFLICT DO NOTHING',
        ),
      );
      bump(
        'stock_movements',
        await bulkInsert(
          client,
          'stock_movements',
          [
            'location_id',
            'storage_area_id',
            'item_id',
            'movement_type',
            'qty',
            'unit_cost',
            'ref_type',
            'ref_id',
            'counterparty_location_id',
            'counterparty_storage_area_id',
            'occurred_at',
          ],
          deliveryMoves,
          'ON CONFLICT DO NOTHING',
        ),
      );

      // ---------------------------------------------------------------------
      // Purchasing: the warehouse buys what it is about to ship out
      // ---------------------------------------------------------------------
      //
      // Without this the chain has an outflow and no inflow: Gudang Pusat ships
      // to twenty branches three times a week against a fixed opening balance
      // and grinds to zero, which is what the first run did — a third of the
      // warehouse's cells clamped at zero inside one week.
      //
      // Modelled as a real document chain (purchase order -> receipt -> receipt
      // lines -> purchase_in) rather than a bare stock movement, for two
      // reasons. Stock that appears with no document behind it is exactly the
      // shape of the fraud the receiving controls exist to catch, so it should
      // not be seedable. And the purchasing screens need a history to show:
      // supplier price comparison and the payment ladder both read it.
      //
      // One PO per supplier per week, ordered the Friday before and received the
      // Monday morning ahead of that week's first van.
      if (ref.suppliers.length > 0) {
        const poRows: unknown[][] = [];
        const poLineRows: unknown[][] = [];
        const receiptRows: unknown[][] = [];
        const receiptLineRows: unknown[][] = [];
        const purchaseMoves: unknown[][] = [];
        let poSeq = 0;

        for (const [week, items] of [...outboundByWeek].sort()) {
          // Group the week's demand by who supplies each item.
          const bySupplier = new Map<string, [string, number][]>();
          for (const [itemId, qty] of items) {
            const supplierId = ref.supplierForItem.get(itemId) ?? ref.suppliers[0].id;
            if (!bySupplier.has(supplierId)) bySupplier.set(supplierId, []);
            bySupplier.get(supplierId)!.push([itemId, qty]);
          }

          for (const [supplierId, lines] of bySupplier) {
            poSeq += 1;
            const key = `po-${week}-${supplierId}`;
            const poId = stableUuid(key);
            const orderedOn = dateMinus(week, 3);
            const receivedAt = witaInstant(week, 5, 0);
            const supplier = ref.suppliers.find((s) => s.id === supplierId);

            let subtotal = 0;
            const built: [string, string, number, number][] = [];
            for (const [itemId, qty] of lines) {
              const meta = ref.itemMeta.get(itemId);
              if (!meta) continue;
              const area =
                ref.gudangAreasByType[meta.storageType] ?? Object.values(ref.gudangAreasByType)[0];
              if (!area) continue;
              // A little over the week's outbound: a warehouse buys a buffer,
              // and buying exactly what leaves would leave nothing on the shelf
              // for an outlet's unscheduled ask.
              const ordered = Math.ceil(qty * 1.1);
              const price = ref.supplierPrice.get(`${supplierId}|${itemId}`) ?? meta.cost;
              subtotal += ordered * price;
              built.push([itemId, area, ordered, price]);
            }
            if (built.length === 0) continue;

            const tax = Math.round(subtotal * 0.11);
            poRows.push([
              poId,
              `PO-${week.replace(/-/g, '')}-${String(poSeq).padStart(4, '0')}`,
              supplierId,
              ref.gudang.id,
              'received',
              orderedOn,
              week,
              supplier?.payment_terms_days ?? 14,
              subtotal.toFixed(2),
              tax.toFixed(2),
              (subtotal + tax).toFixed(2),
              dispatcher,
            ]);
            const receiptId = stableUuid(`${key}-receipt`);
            receiptRows.push([
              receiptId,
              `GRN-${week.replace(/-/g, '')}-${String(poSeq).padStart(4, '0')}`,
              poId,
              dispatcher,
              receivedAt,
              'verified',
            ]);

            for (const [itemId, area, ordered, price] of built) {
              const poLineId = stableUuid(`${key}-line-${itemId}`);
              poLineRows.push([
                poLineId,
                poId,
                itemId,
                ref.itemMeta.get(itemId)!.unitId,
                ordered,
                price.toFixed(2),
                (ordered * price).toFixed(2),
                ordered,
              ]);
              receiptLineRows.push([
                stableUuid(`${key}-rline-${itemId}`),
                receiptId,
                poLineId,
                area,
                ordered,
              ]);
              purchaseMoves.push([
                ref.gudang.id,
                area,
                itemId,
                'purchase_in',
                ordered,
                price.toFixed(2),
                'po_receipt',
                receiptId,
                receivedAt,
              ]);
              touched.add(`${ref.gudang.id}|${area}|${itemId}`);
            }
          }
        }

        // Order matters: lines and receipts reference the PO.
        bump(
          'purchase_orders',
          await bulkInsert(
            client,
            'purchase_orders',
            [
              'id',
              'po_number',
              'supplier_id',
              'location_id',
              'status',
              'order_date',
              'expected_date',
              'payment_terms_days',
              'subtotal',
              'tax',
              'total',
              'created_by',
            ],
            poRows,
            'ON CONFLICT DO NOTHING',
          ),
        );
        bump(
          'po_lines',
          await bulkInsert(
            client,
            'po_lines',
            [
              'id',
              'po_id',
              'item_id',
              'unit_id',
              'qty_ordered',
              'unit_price',
              'line_total',
              'qty_received',
            ],
            poLineRows,
            'ON CONFLICT DO NOTHING',
          ),
        );
        bump(
          'po_receipts',
          await bulkInsert(
            client,
            'po_receipts',
            ['id', 'receipt_number', 'po_id', 'received_by', 'received_at', 'status'],
            receiptRows,
            'ON CONFLICT DO NOTHING',
          ),
        );
        bump(
          'po_receipt_lines',
          await bulkInsert(
            client,
            'po_receipt_lines',
            ['id', 'po_receipt_id', 'po_line_id', 'storage_area_id', 'qty_received'],
            receiptLineRows,
            'ON CONFLICT DO NOTHING',
          ),
        );
        bump(
          'stock_movements',
          await bulkInsert(
            client,
            'stock_movements',
            [
              'location_id',
              'storage_area_id',
              'item_id',
              'movement_type',
              'qty',
              'unit_cost',
              'ref_type',
              'ref_id',
              'occurred_at',
            ],
            purchaseMoves,
            'ON CONFLICT DO NOTHING',
          ),
        );
      } else {
        console.warn('  ! no suppliers — the warehouse will drain with nothing restocking it');
      }
    } else {
      console.warn('  ! no drivers / vehicles / shipment types — deliveries skipped');
    }

    // -----------------------------------------------------------------------
    // Stock balances: REPLAYED, never incremented
    // -----------------------------------------------------------------------
    //
    // `kernel/stock-ledger` is the application's only writer of
    // `stock_balances`, and this script is deliberately outside it (so is
    // `seed.ts`). The safe way to stay consistent with a ledger you are not
    // going through is to recompute from that ledger rather than add to its
    // output: a recompute is idempotent, an increment doubles on the second run.
    //
    // Clamped at zero. A branch CAN go negative here — usage is generated from
    // demand and replenishment from a rule, and the two are not solved against
    // each other on purpose — but a negative on-hand is a state the application
    // treats as impossible, so it must not be seeded into existence.
    console.log(`\n  replaying ${touched.size} stock balance cells from the movement ledger`);
    const cells = [...touched].map((k) => k.split('|'));
    for (let i = 0; i < cells.length; i += 500) {
      await client.query(
        `WITH cells(location_id, storage_area_id, item_id) AS (
           SELECT (v->>0)::uuid, (v->>1)::uuid, (v->>2)::uuid
             FROM jsonb_array_elements($1::jsonb) v
         ),
         totals AS (
           SELECT c.location_id, c.storage_area_id, c.item_id,
                  COALESCE(SUM(
                    CASE WHEN m.movement_type = ANY($2::text[]) THEN m.qty ELSE -m.qty END
                  ), 0) AS qty
             FROM cells c
             LEFT JOIN stock_movements m
               ON m.location_id = c.location_id
              AND m.storage_area_id = c.storage_area_id
              AND m.item_id = c.item_id
            GROUP BY 1, 2, 3
         )
         INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand, updated_at)
         SELECT location_id, storage_area_id, item_id, GREATEST(qty, 0), now() FROM totals
         ON CONFLICT (location_id, storage_area_id, item_id)
         DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, updated_at = now()`,
        [JSON.stringify(cells.slice(i, i + 500)), INBOUND_MOVEMENTS],
      );
    }

    // -----------------------------------------------------------------------
    console.log('\nWrote\n');
    for (const [table, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(9)}  ${table}`);
    }
    const seconds = Math.round((Date.now() - started) / 1000);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`\nDRY RUN — rolled back after ${seconds}s. Nothing was written.\n`);
      return;
    }

    await client.query('COMMIT');
    console.log(`\nCommitted in ${seconds}s.`);

    // REFRESH ... CONCURRENTLY cannot run inside a transaction, so this is after
    // the commit. It is also the slow part on a large history: these views are
    // daily rollups over every row just written.
    for (const view of [
      'mv_sales_daily',
      'mv_item_usage_daily',
      'mv_employee_kpi_daily',
      'mv_delivery_recap_daily',
    ]) {
      process.stdout.write(`  refreshing ${view} … `);
      await client.query('SELECT refresh_dashboard_matview($1)', [view]);
      console.log('done');
    }
    // Without this the planner is still costing queries against the row counts
    // it had before, which is exactly the wrong baseline for a perf run.
    process.stdout.write('  ANALYZE … ');
    await client.query('ANALYZE');
    console.log('done');

    console.log('\n  Next: back-post the general ledger for the days you care about via');
    console.log('  POST /api/accounting/daily-posting, then GET /api/accounting/gl-coverage.\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
