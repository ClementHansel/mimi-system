/**
 * Seed pass for the tables a full `seed.ts` + `seed-extended.ts` run still left
 * empty — the ones whose emptiness makes a WORKING screen look broken.
 *
 * Owner, 2026-08-21: "we also need to fully seed this app properly." Auditing a
 * freshly migrated + seeded database (every table, row-counted) turned up 18
 * empty tables. Most of them SHOULD be empty on a fresh box:
 *
 *   sessions, sync_events, device_events, notifications,
 *   notification_outbox, approval_codes, auth_lockouts, audit_log
 *
 * Those are runtime artifacts — a login, a heartbeat, a code someone was
 * issued. Fabricating them would put fiction in the audit trail, and
 * `audit_log` in particular is evidence: it fills the moment anyone uses the
 * system, and my PR-history feature reads it. Left alone deliberately.
 *
 * What this file fills is the other kind — domain data whose absence makes a
 * built feature look unbuilt:
 *
 *  1. `approvals` + `approval_steps`. THE big one. Every seeded document past
 *     `draft` carried `approval_id = NULL` and there were zero approvals, so
 *     "Persetujuan Saya" was empty on a fresh box and no PR, PO, replenishment,
 *     loan or leave showed an approval timeline — a whole subsystem invisible.
 *     Chains are built from the REAL `approval_chain_steps` config (including
 *     its amount thresholds), so a PO above Rp10 juta genuinely has an owner
 *     step and one below it genuinely does not.
 *  2. `chat_conversations` + `chat_messages`. WhatsApp is now reachable from
 *     every interface, so an empty inbox is a visible hole in six places.
 *  3. `stock_opname` + `stock_opname_lines` — the Gudang opname tab, including
 *     one submitted count with a real variance awaiting approval.
 *  4. `returns` + `return_lines` — both directions (outlet→gudang,
 *     gudang→supplier).
 *  5. `sj_positions` — breadcrumbs for the in-transit Surat Jalan, so the
 *     dispatcher's live map has a truck on it.
 *  6. `voucher_batches` + `vouchers` + `voucher_redemptions` — the voucher
 *     domain shipped with no seed at all, so the Voucher screen was empty,
 *     the POS voucher field had no valid code to type, and the voucher
 *     DESIGNER previewed a card that could not be printed against anything
 *     real.
 *  7. `chat_participants` + internal (`kind` `'direct'`/`'group'`)
 *     conversations. Migration 243 added staff-to-staff chat; the seed only
 *     ever wrote WhatsApp threads, so `chat_participants` was empty and the
 *     whole internal-messaging feature looked unbuilt.
 *
 * Idempotent like the other passes: every insert is guarded, so re-running the
 * seed neither duplicates nor throws.
 */
import { createHash, randomInt } from 'node:crypto';
import { VOUCHER_CODE_ALPHABET, VOUCHER_CODE_BODY_LENGTH, formatVoucherCode } from '@mimi/shared';
import type pg from 'pg';

interface Row {
  [key: string]: unknown;
}

async function rows(client: pg.Client, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await client.query(sql, params)).rows as Row[];
}

async function one(client: pg.Client, sql: string, params: unknown[] = []): Promise<Row | null> {
  const res = await client.query(sql, params);
  return (res.rows[0] as Row) ?? null;
}

/**
 * A deterministic UUID from a text key — the same trick `seed-extended.ts`
 * uses. Needed because `client_id` columns are UUIDs (they are the offline
 * idempotency key), so a readable string like `seed-sjpos-3` cannot be written
 * into one; re-running the seed has to produce the SAME id or the
 * ON CONFLICT guard stops guarding.
 */
function stableUuid(seed: string): string {
  const hash = createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Allocates a document number THROUGH `document_counters`, exactly as the
 * repositories do (`stock-opname.repository.ts`, `return.repository.ts`, …).
 *
 * Hardcoding `OPN/202608/0001` here instead cost a CI run: the counter stayed at
 * zero, so the FIRST real `opname.create()` in the test suite generated that
 * same number and died on `stock_opname_opname_number_key` — 15 failures, none
 * of them in the code under test. A seeded document that skips the counter is a
 * landmine for whatever runs next; the payroll suite already carries a
 * hand-written workaround for the same mistake made with loans.
 */
async function nextDocNumber(client: pg.Client, prefix: string): Promise<string> {
  const period = new Date().toISOString().slice(0, 7).replace('-', '');
  const res = await client.query<{ last_number: number }>(
    `INSERT INTO document_counters (doc_type, period, last_number) VALUES ($1, $2, 1)
     ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
     RETURNING last_number`,
    [prefix, period],
  );
  const seq = String(res.rows[0]!.last_number).padStart(4, '0');
  return `${prefix}/${period}/${seq}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Which approval state a document's own status implies.
 *
 * The mapping is the point: a `submitted` PR must leave a PENDING approval (it
 * is what makes it appear in someone's inbox), while an `approved`/`converted`
 * one must leave a decided chain with real actors and timestamps. Getting this
 * backwards would either fill the inbox with settled work or hide work that
 * needs a decision — both worse than the empty table this replaces.
 */
type ApprovalOutcome = 'pending' | 'approved' | 'rejected' | null;

function outcomeFor(status: string): ApprovalOutcome {
  switch (status) {
    case 'draft':
      return null; // never submitted — correctly has no approval
    case 'submitted':
    case 'awaiting_approval':
    case 'pending':
      return 'pending';
    case 'rejected':
      return 'rejected';
    default:
      // approved / converted / processing / shipped / received / completed /
      // issued / active — all of these are downstream of a decision.
      return 'approved';
  }
}

export async function seedGaps(client: pg.Client): Promise<void> {
  console.log('\n→ Gap seed (approvals, chat, opname, returns, truck positions)...\n');

  const users = await rows(
    client,
    `SELECT u.id, u.username, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id`,
  );
  const userByRole = new Map<string, string>();
  for (const u of users)
    if (!userByRole.has(u.role as string)) userByRole.set(u.role as string, u.id as string);
  const owner = userByRole.get('owner');
  if (!owner) {
    console.log('  ! no owner user — run seed.ts first; skipping gap seed');
    return;
  }

  const chainSteps = await rows(
    client,
    `SELECT document_type, step_no, approver_role, min_amount FROM approval_chain_steps ORDER BY document_type, step_no`,
  );

  // ── 1. WhatsApp threads ───────────────────────────────────────────────────
  const outletRow = await one(
    client,
    `SELECT id, name FROM locations WHERE type = 'outlet' ORDER BY code LIMIT 1`,
  );
  const supplierRow = await one(
    client,
    `SELECT id, name, phone FROM suppliers ORDER BY name LIMIT 1`,
  );
  const staff =
    users.find((u) => u.role === 'kasir') ?? users.find((u) => u.role === 'leader_outlet');

  const threads: {
    phone: string;
    name: string;
    supplierId: string | null;
    userId: string | null;
    locationId: string | null;
    messages: { direction: 'inbound' | 'outbound'; body: string; agoDays: number }[];
  }[] = [
    {
      phone: '+6281100000001',
      name: (staff?.username as string) ?? 'Kasir Outlet',
      supplierId: null,
      userId: (staff?.id as string) ?? null,
      locationId: (outletRow?.id as string) ?? null,
      messages: [
        {
          direction: 'inbound',
          body: 'Pak, stok ayam fillet tinggal 3 kg. Minta kirim hari ini bisa?',
          agoDays: 1,
        },
        {
          direction: 'outbound',
          body: 'Sudah dibuatkan permintaan ke gudang. Perkiraan sampai sore ini.',
          agoDays: 1,
        },
        { direction: 'inbound', body: 'Siap, terima kasih.', agoDays: 1 },
      ],
    },
    {
      phone: (supplierRow?.phone as string) ?? '+6281100000002',
      name: (supplierRow?.name as string) ?? 'Supplier Ayam',
      supplierId: (supplierRow?.id as string) ?? null,
      userId: null,
      locationId: null,
      messages: [
        {
          direction: 'outbound',
          body: 'Selamat pagi, PO minggu ini sudah kami kirim lewat email. Mohon konfirmasi.',
          agoDays: 2,
        },
        { direction: 'inbound', body: 'Sudah kami terima. Pengiriman Kamis pagi ya.', agoDays: 2 },
      ],
    },
  ];

  let threadsMade = 0;
  let messagesMade = 0;
  for (const thread of threads) {
    const last = thread.messages[thread.messages.length - 1]!;
    const unread = thread.messages.filter((m) => m.direction === 'inbound').length;
    const conversation = await one(
      client,
      `INSERT INTO chat_conversations
         (contact_phone, contact_name, supplier_id, user_id, location_id, status,
          last_message_at, last_message_preview, unread_count)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8)
       ON CONFLICT (contact_phone) DO NOTHING
       RETURNING id`,
      [
        thread.phone,
        thread.name,
        thread.supplierId,
        thread.userId,
        thread.locationId,
        daysAgo(last.agoDays),
        last.body.slice(0, 120),
        unread,
      ],
    );
    if (!conversation) continue;
    threadsMade++;
    for (const [i, message] of thread.messages.entries()) {
      await client.query(
        `INSERT INTO chat_messages
           (conversation_id, direction, body, sender_user_id, external_id, delivery_status, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (external_id) DO NOTHING`,
        [
          conversation.id,
          message.direction,
          message.body,
          message.direction === 'outbound' ? owner : null,
          `seed-wa-${thread.phone}-${i}`,
          // `sent`, not `delivered`: the CHECK allows only
          // pending/sent/failed/received, and a mock channel (wa.enabled=false)
          // never gets a delivery receipt back to claim more than "sent".
          message.direction === 'outbound' ? 'sent' : 'received',
          daysAgo(message.agoDays),
        ],
      );
      messagesMade++;
    }
  }
  console.log(`  - chat: ${threadsMade} WhatsApp threads, ${messagesMade} messages`);

  // ── 2. Stock opname, including one real variance ──────────────────────────
  const gdg = await one(client, `SELECT id FROM locations WHERE code = 'GDG'`);
  /**
   * The storage area that actually HOLDS stock, not the first one by code.
   *
   * The obvious `ORDER BY code LIMIT 1` picks CHL (chiller), which the seed
   * leaves empty — everything lands in DRY and FRZ. Both the opname and the
   * return below then found zero balances and skipped silently, so this whole
   * pass reported success while inserting nothing. Choosing by "has the most
   * stock" makes the pass self-correcting if the seed's storage mix changes.
   */
  const area = gdg
    ? await one(
        client,
        `SELECT sa.id
           FROM storage_areas sa
           JOIN stock_balances sb ON sb.storage_area_id = sa.id AND sb.qty_on_hand > 0
          WHERE sa.location_id = $1
          GROUP BY sa.id
          ORDER BY COUNT(*) DESC, sa.id
          LIMIT 1`,
        [gdg.id],
      )
    : null;
  const kepalaGudang = userByRole.get('kepala_gudang') ?? owner;

  let opnameMade = 0;
  if (gdg && area) {
    const balances = await rows(
      client,
      `SELECT item_id, qty_on_hand FROM stock_balances
        WHERE location_id = $1 AND storage_area_id = $2 AND qty_on_hand > 0
        ORDER BY item_id LIMIT 4`,
      [gdg.id, area.id],
    );
    if (balances.length > 0) {
      const existing = await one(client, `SELECT id FROM stock_opname WHERE notes = $1`, [
        'seed:opname-submitted',
      ]);
      if (!existing) {
        const opname = await one(
          client,
          `INSERT INTO stock_opname
             (opname_number, location_id, storage_area_id, status, counted_by, started_at, submitted_at, notes)
           VALUES ($1,$2,$3,'submitted',$4,$5,$6,'seed:opname-submitted')
           RETURNING id`,
          [
            await nextDocNumber(client, 'OPN'),
            gdg.id,
            area.id,
            kepalaGudang,
            daysAgo(1),
            daysAgo(1),
          ],
        );
        for (const [i, balance] of balances.entries()) {
          const system = Number(balance.qty_on_hand);
          // One line short, one over, the rest exact — a count where every line
          // matches teaches nobody what the variance flow looks like.
          const counted = i === 0 ? system - 2 : i === 1 ? system + 1 : system;
          await client.query(
            `INSERT INTO stock_opname_lines
               (opname_id, storage_area_id, item_id, system_qty, counted_qty, diff_qty, variance_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              opname!.id,
              area.id,
              balance.item_id,
              system.toFixed(3),
              counted.toFixed(3),
              (counted - system).toFixed(3),
              i === 0 ? 'Susut saat thawing' : i === 1 ? 'Sisa hitung ulang' : null,
            ],
          );
        }
        opnameMade = 1;
      }
    }
  }
  if (opnameMade === 0 && !area) {
    // A zero here used to be indistinguishable from "already seeded". If the
    // warehouse has no stocked area at all, that is a seed ordering problem
    // worth shouting about rather than skipping quietly.
    console.log('  ! opname skipped: no storage area at GDG holds stock — check seed order');
  }
  console.log(`  - opname: ${opnameMade} submitted count with a real variance`);

  // ── 3. Returns, both directions ───────────────────────────────────────────
  let returnsMade = 0;
  if (gdg && area && outletRow) {
    const item = await one(
      client,
      // Enough on hand to cover the 2-unit return line below, with the
      // largest balance chosen so the return never drives a balance negative.
      `SELECT item_id FROM stock_balances
         WHERE location_id = $1 AND storage_area_id = $2 AND qty_on_hand > 2
         ORDER BY qty_on_hand DESC LIMIT 1`,
      [gdg.id, area.id],
    );
    const outletArea = await one(
      client,
      `SELECT id FROM storage_areas WHERE location_id = $1 ORDER BY code LIMIT 1`,
      [outletRow.id],
    );
    const supervisor = userByRole.get('supervisor') ?? owner;

    const defs = [
      {
        marker: 'seed:return-outlet-to-gudang',
        direction: 'outlet_to_warehouse',
        from: outletRow.id as string,
        to: gdg.id as string,
        supplierId: null,
        // 'submitted', not 'requested': the CHECK's vocabulary is
        // draft/submitted/approved/rejected/in_transit/received/completed/cancelled.
        status: 'submitted',
        requestedBy: supervisor,
        areaId: (outletArea?.id as string) ?? area.id,
        condition: 'quality',
        reason: 'Warna daging berubah sebelum tanggal kedaluwarsa',
      },
      {
        marker: 'seed:return-gudang-to-supplier',
        direction: 'warehouse_to_supplier',
        from: gdg.id as string,
        to: null,
        supplierId: (supplierRow?.id as string) ?? null,
        status: 'approved',
        requestedBy: kepalaGudang,
        areaId: area.id as string,
        condition: 'damaged',
        reason: 'Kemasan rusak saat diterima dari supplier',
      },
    ];

    for (const [i, def] of defs.entries()) {
      if (!item) break;
      const existing = await one(client, `SELECT id FROM returns WHERE notes = $1`, [def.marker]);
      if (existing) continue;
      const ret = await one(
        client,
        `INSERT INTO returns
           (return_number, direction, from_location_id, to_location_id, supplier_id, status,
            requested_by, approved_by, approved_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          await nextDocNumber(client, 'RET'),
          def.direction,
          def.from,
          def.to,
          def.supplierId,
          def.status,
          def.requestedBy,
          def.status === 'approved' ? owner : null,
          def.status === 'approved' ? daysAgo(1) : null,
          def.marker,
        ],
      );
      await client.query(
        `INSERT INTO return_lines (return_id, item_id, storage_area_id, qty, condition, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ret!.id, item.item_id, def.areaId, '2.000', def.condition, def.reason],
      );
      returnsMade++;
    }
  }
  if (returnsMade === 0 && !area) {
    console.log('  ! returns skipped: no stocked storage area at GDG — check seed order');
  }
  console.log(`  - returns: ${returnsMade} (outlet→gudang and gudang→supplier)`);

  // ── 4. Truck breadcrumbs for the in-transit Surat Jalan ───────────────────
  let positionsMade = 0;
  const sj = await one(
    client,
    `SELECT sj.id, sj.driver_id, l.latitude, l.longitude
       FROM surat_jalan sj
       JOIN locations l ON l.id = sj.origin_location_id
      WHERE sj.status IN ('in_transit', 'dispatched')
      ORDER BY sj.created_at DESC LIMIT 1`,
  );
  if (sj?.latitude && sj?.longitude) {
    // A short line of fixes walking away from the warehouse, one every ten
    // minutes — enough for the dispatcher map to draw a trail rather than a
    // single dot, without pretending to be a real GPS trace.
    for (let i = 0; i < 6; i++) {
      const clientId = stableUuid(`seed-sjpos-${sj.id}-${i}`);
      // rowCount, not a blind increment: with ON CONFLICT DO NOTHING a re-run
      // inserts nothing, and a counter that still said "6" would report work
      // that did not happen.
      const inserted = await client.query(
        `INSERT INTO sj_positions
           (sj_id, driver_id, latitude, longitude, accuracy_m, speed_kph, heading_deg, recorded_at, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (client_id) DO NOTHING`,
        [
          sj.id,
          sj.driver_id,
          (Number(sj.latitude) + i * 0.004).toFixed(6),
          (Number(sj.longitude) + i * 0.003).toFixed(6),
          12,
          i === 0 ? 0 : 34,
          45,
          new Date(Date.now() - (6 - i) * 10 * 60_000),
          clientId,
        ],
      );
      positionsMade += inserted.rowCount ?? 0;
    }
  }
  console.log(`  - truck positions: ${positionsMade} fixes on the in-transit Surat Jalan`);

  // ── 5. Approvals for every document that implies one — LAST on purpose ──
  //
  // This runs AFTER the documents above exist, so the opname and the returns
  // this pass just created get their chains in the same run. Ordering it first
  // (the obvious reading order) left a freshly seeded box with a `submitted`
  // opname that appeared in nobody’s inbox — a document waiting forever on a
  // decision that could never arrive, which is worse than the empty table.
  //
  // `stock_opname` and `return` are configured document types too
  // (`approval_chain_steps`), so the opname and returns this pass creates below
  // are included — a `submitted` count that sits in NOBODY's inbox would be a
  // worse lie than the empty table, since the screen would show a document
  // waiting on a decision that can never arrive.
  const documents: { table: string; docType: string; amountSql: string }[] = [
    {
      table: 'purchase_requests',
      docType: 'purchase_request',
      // PR carries no total column; the chain's threshold reads the estimate.
      amountSql: `(SELECT COALESCE(SUM(qty * est_price), 0) FROM purchase_request_lines l WHERE l.pr_id = d.id)`,
    },
    { table: 'purchase_orders', docType: 'purchase_order', amountSql: 'd.total' },
    { table: 'replenishment_requests', docType: 'replenishment_request', amountSql: 'NULL' },
    { table: 'employee_loans', docType: 'employee_loan', amountSql: 'd.principal' },
    { table: 'leave_requests', docType: 'leave_request', amountSql: 'NULL' },
    {
      table: 'stock_opname',
      docType: 'stock_opname',
      // The threshold reads the VALUE of the variance, not the count size:
      // §5.4 escalates on how much money the discrepancy represents.
      amountSql: `(SELECT COALESCE(SUM(ABS(l.diff_qty) * i.avg_cost), 0)
                     FROM stock_opname_lines l JOIN items i ON i.id = l.item_id
                    WHERE l.opname_id = d.id)`,
    },
    {
      table: 'returns',
      docType: 'return',
      amountSql: `(SELECT COALESCE(SUM(l.qty * COALESCE(l.unit_cost, i.avg_cost)), 0)
                     FROM return_lines l JOIN items i ON i.id = l.item_id
                    WHERE l.return_id = d.id)`,
    },
  ];

  let approvalsMade = 0;
  let stepsMade = 0;

  for (const doc of documents) {
    const hasLocation = await one(
      client,
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'location_id'`,
      [doc.table],
    );
    const locationExpr = hasLocation ? 'd.location_id' : 'NULL::uuid';
    const requesterExpr = await requesterColumn(client, doc.table);

    const docRows = await rows(
      client,
      `SELECT d.id, d.status, ${locationExpr} AS location_id, ${requesterExpr} AS requested_by,
              ${doc.amountSql} AS amount
         FROM ${doc.table} d
        WHERE d.approval_id IS NULL`,
    );

    for (const row of docRows) {
      const outcome = outcomeFor(row.status as string);
      if (!outcome) continue;

      const amount = row.amount === null ? null : String(row.amount);
      // Only the steps this document's amount actually triggers — a Rp2 juta PO
      // must NOT get the owner step that starts at Rp10 juta.
      const steps = chainSteps.filter(
        (s) =>
          s.document_type === doc.docType &&
          (s.min_amount === null || (amount !== null && Number(amount) >= Number(s.min_amount))),
      );
      if (steps.length === 0) continue;

      const requestedBy = (row.requested_by as string) ?? owner;
      const decidedAt = outcome === 'pending' ? null : daysAgo(2);
      const approval = await one(
        client,
        `INSERT INTO approvals (document_type, document_id, state, current_step, amount, location_id,
                                requested_by, requested_at, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (document_type, document_id) DO NOTHING
         RETURNING id`,
        [
          doc.docType,
          row.id,
          outcome,
          // `current_step` is the step awaiting a decision, and NULL is the
          // documented "chain finished" signal the UI keys off.
          outcome === 'pending' ? 1 : null,
          amount,
          row.location_id,
          requestedBy,
          daysAgo(3),
          decidedAt,
        ],
      );
      if (!approval) continue;
      approvalsMade++;

      for (const step of steps) {
        const stepNo = Number(step.step_no);
        const role = step.approver_role as string;
        const actor = userByRole.get(role) ?? owner;
        // A pending chain has step 1 waiting and later steps untouched; a
        // rejected chain stops AT the step that rejected it.
        const stepState =
          outcome === 'pending'
            ? 'pending'
            : outcome === 'rejected'
              ? stepNo === 1
                ? 'rejected'
                : 'pending'
              : 'approved';
        const acted = stepState === 'pending' ? null : daysAgo(2);
        await client.query(
          `INSERT INTO approval_steps (approval_id, step_no, approver_role, state, acted_by, acted_at, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            approval.id,
            stepNo,
            role,
            stepState,
            acted ? actor : null,
            acted,
            stepState === 'rejected' ? 'Harga di atas anggaran bulan ini' : null,
          ],
        );
        stepsMade++;
      }

      await client.query(`UPDATE ${doc.table} SET approval_id = $2 WHERE id = $1`, [
        row.id,
        approval.id,
      ]);
    }
  }
  console.log(
    `  - approvals: ${approvalsMade} chains (${stepsMade} steps) linked to their documents — "Persetujuan Saya" is no longer empty`,
  );

  // -- 6. Vouchers (batches + issued codes + real redemptions) ---------------
  //
  // The voucher domain shipped with the document designers and had NO seed at
  // all: an owner opening "Voucher" saw an empty list, the POS voucher field
  // had nothing valid to type, and the voucher DESIGNER previewed a card that
  // could never be printed against a real code. Three tables, one dead
  // feature.
  //
  // Codes are minted with `formatVoucherCode` from `@mimi/shared` -- the same
  // function the API uses -- rather than hand-written strings, so a seeded
  // coupon is normalised and typeable exactly like a real one. `randomInt`
  // from `node:crypto`, never `Math.random`: a forgeable voucher code is
  // money, and a seed that modelled forgeability would teach the wrong
  // pattern to the next person who copies it.
  const outletsForVouchers = await rows(
    client,
    `SELECT id FROM locations WHERE type = 'outlet' ORDER BY code LIMIT 3`,
  );
  const voucherBatchSpecs = [
    {
      code: 'PROMO-AGT-26',
      name: 'Promo Agustus - potongan Rp10.000',
      type: 'fixed',
      value: '10000.00',
      minSubtotal: '50000.00',
      maxDiscount: null as string | null,
      locationIds: null as string[] | null,
      terms: 'Berlaku untuk semua outlet. Satu voucher per transaksi.',
      status: 'issued',
      issue: 12,
    },
    {
      code: 'DISKON-10',
      name: 'Diskon 10% (maks Rp25.000)',
      type: 'percentage',
      value: '10.00',
      minSubtotal: '75000.00',
      maxDiscount: '25000.00',
      locationIds: outletsForVouchers.map((o) => o.id as string),
      terms: 'Hanya di outlet terpilih. Tidak digabung promo lain.',
      status: 'issued',
      issue: 8,
    },
    {
      // A batch still being prepared -- the `draft` state has its own UI path
      // (editable, cannot issue), and with no draft row nobody could see it.
      code: 'PROMO-SEP-26',
      name: 'Promo September (draf)',
      type: 'fixed',
      value: '15000.00',
      minSubtotal: '100000.00',
      maxDiscount: null as string | null,
      locationIds: null as string[] | null,
      terms: 'Draf - belum diterbitkan.',
      status: 'draft',
      issue: 0,
    },
  ];

  let batchesMade = 0;
  let vouchersMade = 0;
  let redemptionsMade = 0;

  for (const spec of voucherBatchSpecs) {
    const existing = await one(client, `SELECT id FROM voucher_batches WHERE code = $1`, [
      spec.code,
    ]);
    const created = existing
      ? null
      : await one(
          client,
          `INSERT INTO voucher_batches
             (code, name, type, value, min_subtotal, max_discount, valid_from, valid_until,
              location_ids, terms, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE - 7, CURRENT_DATE + 60, $7,$8,$9,$10)
           RETURNING id`,
          [
            spec.code,
            spec.name,
            spec.type,
            spec.value,
            spec.minSubtotal,
            spec.maxDiscount,
            spec.locationIds,
            spec.terms,
            spec.status,
            owner,
          ],
        );
    if (created) batchesMade++;
    const batchId = (existing?.id ?? created?.id) as string;

    const already = await one(
      client,
      `SELECT count(*)::int AS n FROM vouchers WHERE batch_id = $1`,
      [batchId],
    );
    for (let i = (already?.n as number) ?? 0; i < spec.issue; i++) {
      const code = formatVoucherCode(
        Array.from({ length: VOUCHER_CODE_BODY_LENGTH }, () =>
          randomInt(VOUCHER_CODE_ALPHABET.length),
        ),
      );
      await client.query(
        `INSERT INTO vouchers (batch_id, code, status) VALUES ($1,$2,'active')
         ON CONFLICT (code) DO NOTHING`,
        [batchId, code],
      );
      vouchersMade++;
    }
  }

  // Redeem a few against REAL seeded sales, so the redemption history, the
  // "sudah dipakai" filter and a sale's voucher line all have something true
  // behind them. `voucher_redemptions.voucher_id` is UNIQUE -- that constraint
  // IS the double-spend guard -- so each insert is guarded rather than blind.
  const redeemableVouchers = await rows(
    client,
    `SELECT v.id
       FROM vouchers v
       JOIN voucher_batches b ON b.id = v.batch_id AND b.code = 'PROMO-AGT-26'
      WHERE v.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM voucher_redemptions r WHERE r.voucher_id = v.id)
      ORDER BY v.created_at
      LIMIT 3`,
  );
  const salesForVouchers = await rows(
    client,
    `SELECT id, location_id, kasir_id FROM sales
      WHERE status = 'completed'
      ORDER BY occurred_at DESC
      LIMIT 3`,
  );
  for (let i = 0; i < Math.min(redeemableVouchers.length, salesForVouchers.length); i++) {
    const voucher = redeemableVouchers[i]!;
    const sale = salesForVouchers[i]!;
    const inserted = await one(
      client,
      `INSERT INTO voucher_redemptions
         (voucher_id, sale_id, location_id, discount_amount, redeemed_by, redeemed_at)
       VALUES ($1,$2,$3,'10000.00',$4, NOW() - ($5 || ' days')::interval)
       ON CONFLICT (voucher_id) DO NOTHING
       RETURNING id`,
      [voucher.id, sale.id, sale.location_id, sale.kasir_id, String(i + 1)],
    );
    if (inserted) {
      await client.query(`UPDATE vouchers SET status = 'redeemed' WHERE id = $1`, [voucher.id]);
      redemptionsMade++;
    }
  }
  console.log(
    `  - vouchers: ${batchesMade} batches, ${vouchersMade} codes issued, ${redemptionsMade} redeemed against real sales`,
  );

  // -- 7. Internal chat (staff threads, not WhatsApp) ------------------------
  //
  // Migration 243 added `kind IN ('whatsapp','direct','group')` and
  // `chat_participants`, but the seed only ever wrote WhatsApp threads -- so
  // `chat_participants` was empty and the internal messaging feature looked
  // unbuilt on a fresh box, in exactly the way this file exists to prevent.
  //
  // One group thread and one DM. `direct_key` is built the SAME way
  // `InternalChatService.openDirect` builds it (`[a,b].sort().join(':')`);
  // if these disagreed, opening that DM in the app would create a SECOND row
  // for the same pair instead of finding this one.
  const managerUser = userByRole.get('manager');
  const kepalaGudangUser = userByRole.get('kepala_gudang');
  const supervisorUser = userByRole.get('supervisor');
  let internalThreads = 0;

  if (managerUser && kepalaGudangUser) {
    const groupName = 'Koordinasi Gudang & Outlet';
    const groupExisting = await one(
      client,
      `SELECT id FROM chat_conversations WHERE kind = 'group' AND name = $1`,
      [groupName],
    );
    if (!groupExisting) {
      const group = await one(
        client,
        `INSERT INTO chat_conversations
           (kind, name, created_by, status, last_message_at, last_message_preview)
         VALUES ('group', $1, $2, 'open', NOW() - INTERVAL '2 hours', $3)
         RETURNING id`,
        [groupName, owner, 'Kiriman frozen besok pagi ya, truk berangkat 06.00.'],
      );
      const groupId = group?.id as string;
      const members: [string, string][] = [
        [owner, 'admin'],
        [managerUser, 'admin'],
        [kepalaGudangUser, 'member'],
      ];
      if (supervisorUser) members.push([supervisorUser, 'member']);
      for (const [userId, role] of members) {
        await client.query(
          `INSERT INTO chat_participants (conversation_id, user_id, role, joined_at, last_read_at)
           VALUES ($1,$2,$3, NOW() - INTERVAL '9 days', NOW() - INTERVAL '2 hours')`,
          [groupId, userId, role],
        );
      }
      const groupMessages: [string, string, string][] = [
        [kepalaGudangUser, 'Stok ayam fillet di gudang tinggal 120 kg.', '26'],
        [managerUser, 'Sudah saya buatkan PO ke supplier utama, masuk besok.', '25'],
        [owner, 'Kiriman frozen besok pagi ya, truk berangkat 06.00.', '2'],
      ];
      for (const [sender, body, hoursAgo] of groupMessages) {
        await client.query(
          `INSERT INTO chat_messages
             (conversation_id, direction, body, sender_user_id, delivery_status, occurred_at)
           VALUES ($1, 'outbound', $2, $3, 'sent', NOW() - ($4 || ' hours')::interval)`,
          [groupId, body, sender, hoursAgo],
        );
      }
      internalThreads++;
    }

    const directKey = [owner, managerUser].sort().join(':');
    const dmExisting = await one(
      client,
      `SELECT id FROM chat_conversations WHERE kind = 'direct' AND direct_key = $1`,
      [directKey],
    );
    if (!dmExisting) {
      const dm = await one(
        client,
        `INSERT INTO chat_conversations
           (kind, direct_key, created_by, status, last_message_at, last_message_preview)
         VALUES ('direct', $1, $2, 'open', NOW() - INTERVAL '30 minutes', $3)
         RETURNING id`,
        [directKey, owner, 'Laporan penjualan minggu ini sudah saya kirim.'],
      );
      const dmId = dm?.id as string;
      for (const userId of [owner, managerUser]) {
        await client.query(
          `INSERT INTO chat_participants (conversation_id, user_id, role, joined_at, last_read_at)
           VALUES ($1,$2,'member', NOW() - INTERVAL '3 days', NOW() - INTERVAL '30 minutes')`,
          [dmId, userId],
        );
      }
      await client.query(
        `INSERT INTO chat_messages
           (conversation_id, direction, body, sender_user_id, delivery_status, occurred_at)
         VALUES ($1,'outbound',$2,$3,'sent', NOW() - INTERVAL '40 minutes'),
                ($1,'outbound',$4,$5,'sent', NOW() - INTERVAL '30 minutes')`,
        [
          dmId,
          'Pak, minta laporan penjualan minggu ini.',
          owner,
          'Laporan penjualan minggu ini sudah saya kirim.',
          managerUser,
        ],
      );
      internalThreads++;
    }
  }
  console.log(
    `  - internal chat: ${internalThreads} staff thread(s) with participants and messages`,
  );

  console.log('\n\u2713 Gap seed completed.\n');
}

/**
 * Which column names the person who raised a document. The tables disagree
 * (`requested_by` vs `employee_id` vs `created_by`), and guessing one name for
 * all of them is how a seed silently writes NULLs into `approvals.requested_by`
 * — which is NOT NULL, so it would fail loudly, but only on some tables.
 */
async function requesterColumn(client: pg.Client, table: string): Promise<string> {
  const candidates = ['requested_by', 'created_by', 'counted_by'];
  for (const column of candidates) {
    const found = await one(
      client,
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (found) return `d.${column}`;
  }
  // `employee_loans`/`leave_requests` point at an employee, not a user.
  const viaEmployee = await one(
    client,
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'employee_id'`,
    [table],
  );
  if (viaEmployee) return `(SELECT e.user_id FROM employees e WHERE e.id = d.employee_id)`;
  return 'NULL::uuid';
}
