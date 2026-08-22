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
 *
 * Idempotent like the other passes: every insert is guarded, so re-running the
 * seed neither duplicates nor throws.
 */
import { createHash } from 'node:crypto';
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
            `OPN/${new Date().toISOString().slice(0, 7).replace('-', '')}/0001`,
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
          `RTN/${new Date().toISOString().slice(0, 7).replace('-', '')}/000${i + 1}`,
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

  console.log('\n✓ Gap seed completed.\n');
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
