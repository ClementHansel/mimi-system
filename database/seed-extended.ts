/**
 * Extended Seed — Mimi Chicken Operational System
 *
 * `seed.ts` covers the master data and the happy-path transactional spine
 * (locations, items, recipes, employees, sales, shifts, surat jalan, a payroll
 * period, an accounting set). It stops there, which left 32 tables with zero
 * rows — and an empty table is indistinguishable from a broken feature when
 * you sit down to test. This module fills the rest so every surface has
 * something to render and every flow has a state to exercise.
 *
 * What it adds, and why each matters for a full test pass:
 *
 *  1. STATUTORY PAYROLL CONFIG (pph21_ter_rates, pph21_ptkp, bpjs_configs,
 *     employee_tax_profiles). Without these, `statutory.service.ts` fails
 *     closed with ERR_STATUTORY_NOT_READY and PPh21/BPJS cannot be exercised
 *     at all. See the provenance warning on TER_RATES below — these are demo
 *     values, not a compliance source.
 *  2. PER-EMPLOYEE PAY STRUCTURE (employee_salary_components,
 *     employee_loan_payments) so a payroll run has inputs to compute from
 *     rather than the pre-baked payroll_lines seed.ts writes directly.
 *  3. SCHEDULING (work_shifts, shift_assignments).
 *  4. THE PURCHASING CHAIN (purchase_requests -> goods_receipts/po_receipts).
 *     seed.ts creates a PO but nothing downstream, so requisition -> receive
 *     -> stock-in could never be walked end to end.
 *  5. STOCK DEPLETION BACKFILL. seed.ts sells 400+ orders without ever taking
 *     anything out of stock, so stock_movements held only opening_balance rows
 *     and mv_item_usage_daily refreshed to nothing. This posts the usage_out
 *     movements those sales should always have produced.
 *  6. STOCK OPERATIONS (stock_opname_lines, stock_adjustments,
 *     stock_reconciliations) including a deliberate three-tier divergence.
 *  7. POS EXCEPTIONS (void_refunds) in both approved and pending states.
 *  8. FINANCE (payment_verifications, petty_cash_lines, attachments).
 *  9. ASSETS (maintenance_jobs, service_history).
 * 10. SYNC/DEVICE RUNTIME (branch_nodes, pairing_tokens, discovered_devices,
 *     sync_cursors, sync_batches, sync_conflicts, offline_credentials,
 *     offline_authorizations). NOTE: these are normally produced by real
 *     device traffic. They are seeded here at the owner's explicit request so
 *     the sync/device console has content; treat any row whose client_id or
 *     number contains 'SEED' as fixture data, not as evidence a device ever
 *     actually connected.
 *
 * Idempotent on the same terms as seed.ts: every insert upserts on a natural
 * key, and anything that allocates a document number checks for its own prior
 * row FIRST (allocate_document_number() increments a counter and is not itself
 * idempotent).
 *
 * Runs as part of `pnpm seed` (called at the end of seed.ts). It can also be
 * run standalone — it resolves every id it needs by querying the database
 * rather than taking them from seed.ts's scope.
 *
 * Environment: DATABASE_MIGRATION_URL (owner/superuser), same as seed.ts —
 * it writes directly to every table without setting app.* RLS session vars.
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { businessDateOf } from '@mimi/shared';

// Local copies of seed.ts's helpers. Duplicated rather than exported across
// files so this module stays runnable on its own; they are three lines each
// and their behaviour is fixed by the seed's idempotency contract.
function stableUuid(seed: string): string {
  const hash = createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
function rnd(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[rnd(0, arr.length - 1)]!;
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
/** WITA calendar date, not UTC — see the long note on `seed.ts`'s copy. */
function isoDate(d: Date): string {
  return businessDateOf(d.toISOString());
}

/** The ONE mechanism that may produce a document number — mirrors seed.ts's
 * wrapper around migration 215's allocate_document_number(). Callers must
 * check for an existing row before calling: this increments a counter. */
async function nextDocNumber(
  client: pg.Client,
  docType: string,
  period = '202608',
): Promise<string> {
  const res = await client.query('SELECT allocate_document_number($1, $2) AS num', [
    docType,
    period,
  ]);
  return res.rows[0].num;
}

async function rows<T = any>(client: pg.Client, sql: string, params: any[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}
async function one<T = any>(
  client: pg.Client,
  sql: string,
  params: any[] = [],
): Promise<T | undefined> {
  return (await client.query(sql, params)).rows[0] as T | undefined;
}
/** True when a row already exists — the guard in front of every
 * document-number allocation, so a re-run never burns a new counter value. */
async function exists(client: pg.Client, sql: string, params: any[] = []): Promise<boolean> {
  return (await client.query(sql, params)).rows.length > 0;
}

// ---------------------------------------------------------------------------
// Statutory reference data
// ---------------------------------------------------------------------------

const STATUTORY_FROM = '2024-01-01';

/**
 * PTKP (Penghasilan Tidak Kena Pajak) per PMK 101/2016, with the TER category
 * each code maps to under PP 58/2023.
 */
const PTKP: { code: string; annual: number; ter: 'A' | 'B' | 'C' }[] = [
  { code: 'TK/0', annual: 54_000_000, ter: 'A' },
  { code: 'TK/1', annual: 58_500_000, ter: 'A' },
  { code: 'TK/2', annual: 63_000_000, ter: 'B' },
  { code: 'TK/3', annual: 67_500_000, ter: 'B' },
  { code: 'K/0', annual: 58_500_000, ter: 'A' },
  { code: 'K/1', annual: 63_000_000, ter: 'B' },
  { code: 'K/2', annual: 67_500_000, ter: 'B' },
  { code: 'K/3', annual: 72_000_000, ter: 'C' },
];

/**
 * ⚠ PROVENANCE — READ BEFORE ANY REAL PAYROLL RUN.
 *
 * Monthly TER (Tarif Efektif Rata-rata) ladders, categories A/B/C, per
 * PP 58/2023 / PMK 168/2023. These are transcribed DEMO values whose purpose
 * is to get `statutory.service.ts` past its readiness gate so PPh21 can be
 * exercised end to end. They have NOT been verified line-by-line against the
 * current lampiran, and the statutory tables are effective-dated precisely so
 * finance can supersede them through the admin UI
 * (`POST /api/settings/statutory/...`) without a code change.
 *
 * Do not treat this array as a source of tax truth. Before running payroll
 * for real money, have finance confirm the ladder and enter the authoritative
 * figures with a new effective_from.
 *
 * Each tuple is [bracket_min, bracket_max | null, rate_pct]; brackets are
 * contiguous and the final one is open-ended.
 */
const TER_RATES: Record<'A' | 'B' | 'C', [number, number | null, number][]> = {
  A: [
    [0, 5_400_000, 0],
    [5_400_000, 5_650_000, 0.25],
    [5_650_000, 5_950_000, 0.5],
    [5_950_000, 6_300_000, 0.75],
    [6_300_000, 6_750_000, 1],
    [6_750_000, 7_500_000, 1.25],
    [7_500_000, 8_550_000, 1.5],
    [8_550_000, 9_650_000, 1.75],
    [9_650_000, 10_050_000, 2],
    [10_050_000, 10_350_000, 2.25],
    [10_350_000, 10_700_000, 2.5],
    [10_700_000, 11_050_000, 3],
    [11_050_000, 11_600_000, 3.5],
    [11_600_000, 12_500_000, 4],
    [12_500_000, 13_750_000, 5],
    [13_750_000, 15_100_000, 6],
    [15_100_000, 16_950_000, 7],
    [16_950_000, 19_750_000, 8],
    [19_750_000, 24_150_000, 9],
    [24_150_000, 26_450_000, 10],
    [26_450_000, 28_000_000, 11],
    [28_000_000, 30_050_000, 12],
    [30_050_000, 32_400_000, 13],
    [32_400_000, 35_400_000, 14],
    [35_400_000, 39_100_000, 15],
    [39_100_000, 43_850_000, 16],
    [43_850_000, 47_800_000, 17],
    [47_800_000, 51_400_000, 18],
    [51_400_000, 56_300_000, 19],
    [56_300_000, 62_200_000, 20],
    [62_200_000, 68_600_000, 21],
    [68_600_000, 77_500_000, 22],
    [77_500_000, 89_000_000, 23],
    [89_000_000, 103_000_000, 24],
    [103_000_000, 125_000_000, 25],
    [125_000_000, 157_000_000, 26],
    [157_000_000, 206_000_000, 27],
    [206_000_000, 337_000_000, 28],
    [337_000_000, 454_000_000, 29],
    [454_000_000, 550_000_000, 30],
    [550_000_000, 695_000_000, 31],
    [695_000_000, 910_000_000, 32],
    [910_000_000, 1_400_000_000, 33],
    [1_400_000_000, null, 34],
  ],
  B: [
    [0, 6_200_000, 0],
    [6_200_000, 6_500_000, 0.25],
    [6_500_000, 6_850_000, 0.5],
    [6_850_000, 7_300_000, 0.75],
    [7_300_000, 9_200_000, 1],
    [9_200_000, 10_750_000, 1.5],
    [10_750_000, 11_250_000, 2],
    [11_250_000, 11_600_000, 2.5],
    [11_600_000, 12_600_000, 3],
    [12_600_000, 13_600_000, 4],
    [13_600_000, 14_950_000, 5],
    [14_950_000, 16_400_000, 6],
    [16_400_000, 18_450_000, 7],
    [18_450_000, 21_850_000, 8],
    [21_850_000, 26_000_000, 9],
    [26_000_000, 27_700_000, 10],
    [27_700_000, 29_350_000, 11],
    [29_350_000, 31_450_000, 12],
    [31_450_000, 33_950_000, 13],
    [33_950_000, 37_100_000, 14],
    [37_100_000, 41_100_000, 15],
    [41_100_000, 45_800_000, 16],
    [45_800_000, 49_500_000, 17],
    [49_500_000, 53_800_000, 18],
    [53_800_000, 58_500_000, 19],
    [58_500_000, 64_000_000, 20],
    [64_000_000, 71_000_000, 21],
    [71_000_000, 80_000_000, 22],
    [80_000_000, 93_000_000, 23],
    [93_000_000, 109_000_000, 24],
    [109_000_000, 129_000_000, 25],
    [129_000_000, 163_000_000, 26],
    [163_000_000, 211_000_000, 27],
    [211_000_000, 374_000_000, 28],
    [374_000_000, 459_000_000, 29],
    [459_000_000, 555_000_000, 30],
    [555_000_000, 704_000_000, 31],
    [704_000_000, 957_000_000, 32],
    [957_000_000, 1_405_000_000, 33],
    [1_405_000_000, null, 34],
  ],
  C: [
    [0, 6_600_000, 0],
    [6_600_000, 6_950_000, 0.25],
    [6_950_000, 7_350_000, 0.5],
    [7_350_000, 7_800_000, 0.75],
    [7_800_000, 8_850_000, 1],
    [8_850_000, 9_800_000, 1.25],
    [9_800_000, 10_950_000, 1.5],
    [10_950_000, 11_200_000, 1.75],
    [11_200_000, 12_050_000, 2],
    [12_050_000, 12_950_000, 3],
    [12_950_000, 14_150_000, 4],
    [14_150_000, 15_550_000, 5],
    [15_550_000, 17_050_000, 6],
    [17_050_000, 19_500_000, 7],
    [19_500_000, 22_700_000, 8],
    [22_700_000, 26_600_000, 9],
    [26_600_000, 28_100_000, 10],
    [28_100_000, 30_100_000, 11],
    [30_100_000, 32_600_000, 12],
    [32_600_000, 35_400_000, 13],
    [35_400_000, 38_900_000, 14],
    [38_900_000, 43_000_000, 15],
    [43_000_000, 47_400_000, 16],
    [47_400_000, 51_200_000, 17],
    [51_200_000, 55_800_000, 18],
    [55_800_000, 60_400_000, 19],
    [60_400_000, 66_700_000, 20],
    [66_700_000, 74_500_000, 21],
    [74_500_000, 83_200_000, 22],
    [83_200_000, 95_600_000, 23],
    [95_600_000, 110_000_000, 24],
    [110_000_000, 134_000_000, 25],
    [134_000_000, 169_000_000, 26],
    [169_000_000, 221_000_000, 27],
    [221_000_000, 390_000_000, 28],
    [390_000_000, 463_000_000, 29],
    [463_000_000, 561_000_000, 30],
    [561_000_000, 709_000_000, 31],
    [709_000_000, 965_000_000, 32],
    [965_000_000, 1_419_000_000, 33],
    [1_419_000_000, null, 34],
  ],
};

/** BPJS programmes. Same provenance caveat as TER_RATES — the JP salary cap in
 * particular is re-set annually and must be confirmed before a real run. */
const BPJS: {
  program: string;
  employer: number;
  employee: number;
  floor: number | null;
  cap: number | null;
  notes: string;
}[] = [
  {
    program: 'kesehatan',
    employer: 4,
    employee: 1,
    floor: null,
    cap: 12_000_000,
    notes: 'BPJS Kesehatan — cap upah 12jt',
  },
  { program: 'jht', employer: 3.7, employee: 2, floor: null, cap: null, notes: 'Jaminan Hari Tua' },
  {
    program: 'jp',
    employer: 2,
    employee: 1,
    floor: null,
    cap: 10_547_400,
    notes: 'Jaminan Pensiun — cap disesuaikan tiap tahun',
  },
  {
    program: 'jkk',
    employer: 0.24,
    employee: 0,
    floor: null,
    cap: null,
    notes: 'Jaminan Kecelakaan Kerja — tingkat risiko I (rendah)',
  },
  { program: 'jkm', employer: 0.3, employee: 0, floor: null, cap: null, notes: 'Jaminan Kematian' },
];

export async function seedExtended(client: pg.Client): Promise<void> {
  console.log('\n→ Extended seed (statutory, purchasing, stock ops, finance, assets, sync)...\n');

  // ---------------------------------------------------------------------
  // Shared lookups — resolved from the DB so this module runs standalone.
  // ---------------------------------------------------------------------
  const locations = await rows(client, `SELECT id, code, type FROM locations ORDER BY code`);
  const locByCode = Object.fromEntries(locations.map((l) => [l.code, l.id])) as Record<
    string,
    string
  >;
  const outlets = locations.filter((l) => l.code !== 'GDG');
  const gdg = locByCode['GDG'];
  if (!gdg) {
    console.log('  ! no GDG location found — run seed.ts first; skipping extended seed');
    return;
  }

  const users = await rows(client, `SELECT id, username FROM users`);
  const userByName = Object.fromEntries(users.map((u) => [u.username, u.id])) as Record<
    string,
    string
  >;
  const owner = userByName['owner'];
  const kepalaGudang = userByName['kepalagudang1'] ?? owner;
  const hrAdmin = userByName['hradmin1'] ?? owner;
  const finance = userByName['finance1'] ?? owner;

  const employees = await rows(
    client,
    `SELECT id, name, location_id FROM employees ORDER BY employee_number`,
  );
  const items = await rows(
    client,
    `SELECT id, name, storage_type, avg_cost FROM items ORDER BY sku`,
  );
  const storageAreas = await rows(client, `SELECT id, location_id, type FROM storage_areas`);
  const areaFor = (locationId: string, storageType: string | null): string | undefined => {
    const want =
      storageType === 'frozen' ? 'freezer' : storageType === 'chilled' ? 'chiller' : 'dry_store';
    const inLoc = storageAreas.filter((a) => a.location_id === locationId);
    return (
      inLoc.find((a) => a.type === want) ??
      inLoc.find((a) => a.type === 'dry_store') ??
      inLoc[0]
    )?.id;
  };

  // =====================================================================
  // 1. STATUTORY PAYROLL CONFIG
  // =====================================================================
  for (const p of PTKP) {
    await client.query(
      `INSERT INTO pph21_ptkp (ptkp_code, annual_amount, ter_category, effective_from)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ptkp_code, effective_from)
       DO UPDATE SET annual_amount = EXCLUDED.annual_amount, ter_category = EXCLUDED.ter_category`,
      [p.code, p.annual, p.ter, STATUTORY_FROM],
    );
  }
  let terCount = 0;
  for (const [category, brackets] of Object.entries(TER_RATES)) {
    for (const [min, max, rate] of brackets) {
      await client.query(
        `INSERT INTO pph21_ter_rates (category, bracket_min, bracket_max, rate_pct, effective_from)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (category, bracket_min, effective_from)
         DO UPDATE SET bracket_max = EXCLUDED.bracket_max, rate_pct = EXCLUDED.rate_pct`,
        [category, min, max, rate, STATUTORY_FROM],
      );
      terCount++;
    }
  }
  for (const b of BPJS) {
    await client.query(
      `INSERT INTO bpjs_configs (program, employer_pct, employee_pct, salary_floor, salary_cap, notes, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (program, effective_from)
       DO UPDATE SET employer_pct = EXCLUDED.employer_pct, employee_pct = EXCLUDED.employee_pct,
                     salary_floor = EXCLUDED.salary_floor, salary_cap = EXCLUDED.salary_cap, notes = EXCLUDED.notes`,
      [b.program, b.employer, b.employee, b.floor, b.cap, b.notes, STATUTORY_FROM],
    );
  }
  console.log(
    `  - statutory: ${PTKP.length} PTKP codes, ${terCount} TER brackets (A/B/C), ${BPJS.length} BPJS programmes`,
  );

  // =====================================================================
  // 2. PER-EMPLOYEE TAX PROFILE + SALARY STRUCTURE
  // =====================================================================
  // Deterministic spread across PTKP codes (index-based, not rnd) so a re-run
  // does not reshuffle every employee's tax status and silently change their
  // computed PPh21 between runs.
  let profiles = 0;
  for (const [i, emp] of employees.entries()) {
    const ptkp = PTKP[i % PTKP.length]!;
    const employment = await one(
      client,
      `SELECT base_salary FROM employments WHERE employee_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [emp.id],
    );
    const base = Number(employment?.base_salary ?? 3_500_000);
    await client.query(
      `INSERT INTO employee_tax_profiles (employee_id, npwp, ptkp_code, dependants_count, bpjs_enrollments, bpjs_salary_base, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (employee_id) DO UPDATE SET ptkp_code = EXCLUDED.ptkp_code,
         dependants_count = EXCLUDED.dependants_count, bpjs_enrollments = EXCLUDED.bpjs_enrollments,
         bpjs_salary_base = EXCLUDED.bpjs_salary_base`,
      [
        emp.id,
        // Roughly a third have no NPWP on file — a real and testable condition.
        i % 3 === 0
          ? null
          : `${String(10 + (i % 80)).padStart(2, '0')}.${String(100 + i).slice(0, 3)}.${String(200 + i).slice(0, 3)}.${i % 9}-000.000`,
        ptkp.code,
        Number(ptkp.code.split('/')[1] ?? 0),
        JSON.stringify({ kesehatan: true, jht: true, jp: base >= 3_000_000, jkk: true, jkm: true }),
        base,
        hrAdmin,
      ],
    );
    profiles++;
  }

  const components = await rows(
    client,
    `SELECT id, code, type, calc_method FROM salary_components`,
  );
  const compByCode = Object.fromEntries(components.map((c) => [c.code, c.id])) as Record<
    string,
    string
  >;
  // Only the FIXED earnings get a per-employee amount row. Formula/statutory
  // components (PPh21, BPJS, overtime, late deductions) are computed by the
  // payroll engine from the statutory config above and from attendance —
  // writing amounts for those here would fabricate an answer the engine is
  // supposed to derive, and mask a broken calculation during testing.
  let compRows = 0;
  for (const emp of employees) {
    const employment = await one(
      client,
      `SELECT base_salary, position FROM employments WHERE employee_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [emp.id],
    );
    const base = Number(employment?.base_salary ?? 3_500_000);
    const fixed: [string, number][] = [
      ['base_salary', base],
      ['position_allowance', Math.round((base * 0.1) / 50_000) * 50_000],
    ];
    for (const [code, amount] of fixed) {
      const cid = compByCode[code];
      if (!cid) continue;
      await client.query(
        `INSERT INTO employee_salary_components (employee_id, component_id, amount, effective_from)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (employee_id, component_id, effective_from) DO UPDATE SET amount = EXCLUDED.amount`,
        [emp.id, cid, amount, STATUTORY_FROM],
      );
      compRows++;
    }
  }
  console.log(
    `  - payroll inputs: ${profiles} employee tax profiles, ${compRows} fixed salary-component rows`,
  );

  // Loan repayments against the seeded kasbon, so the loan has a history and a
  // decreasing outstanding rather than a static figure.
  const loan = await one(
    client,
    `SELECT id, principal, monthly_installment, outstanding FROM employee_loans ORDER BY created_at LIMIT 1`,
  );
  if (loan) {
    const installment = Number(loan.monthly_installment);
    for (let m = 3; m >= 1; m--) {
      const marker = `SEED-LOANPAY-${loan.id}-${m}`;
      if (await exists(client, `SELECT 1 FROM employee_loan_payments WHERE notes = $1`, [marker]))
        continue;
      await client.query(
        `INSERT INTO employee_loan_payments (loan_id, amount, method, paid_at, notes)
         VALUES ($1,$2,'payroll_deduction',$3,$4)`,
        [loan.id, installment, daysAgo(m * 30), marker],
      );
    }
    const paid = await one(
      client,
      `SELECT COALESCE(SUM(amount),0) AS total FROM employee_loan_payments WHERE loan_id = $1`,
      [loan.id],
    );
    await client.query(
      `UPDATE employee_loans SET outstanding = GREATEST(principal - $2, 0) WHERE id = $1`,
      [loan.id, Number(paid?.total ?? 0)],
    );
    console.log('  - loans: 3 payroll-deduction repayments, outstanding recomputed');
  }

  // =====================================================================
  // 3. WORK SHIFTS + ASSIGNMENTS
  // =====================================================================
  const shiftDefs = [
    { name: 'Pagi', start: '08:00', end: '16:00', brk: 60 },
    { name: 'Siang', start: '14:00', end: '22:00', brk: 60 },
    { name: 'Malam', start: '16:00', end: '23:30', brk: 45 },
  ];
  const shiftIdByLoc: Record<string, string[]> = {};
  for (const loc of locations) {
    shiftIdByLoc[loc.id] = [];
    for (const s of shiftDefs) {
      const found = await one(
        client,
        `SELECT id FROM work_shifts WHERE location_id = $1 AND name = $2`,
        [loc.id, s.name],
      );
      if (found) {
        shiftIdByLoc[loc.id]!.push(found.id);
        continue;
      }
      const ins = await one(
        client,
        `INSERT INTO work_shifts (location_id, name, start_time, end_time, break_minutes, is_active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [loc.id, s.name, s.start, s.end, s.brk],
      );
      shiftIdByLoc[loc.id]!.push(ins!.id);
    }
  }
  let assignments = 0;
  for (const [i, emp] of employees.entries()) {
    if (!emp.location_id || !shiftIdByLoc[emp.location_id]?.length) continue;
    // 14 days of rota. Unique key is (employee_id, date), so re-runs upsert.
    for (let d = 0; d < 14; d++) {
      const date = isoDate(daysAgo(d));
      const shiftId =
        shiftIdByLoc[emp.location_id]![(i + d) % shiftIdByLoc[emp.location_id]!.length];
      await client.query(
        `INSERT INTO shift_assignments (employee_id, work_shift_id, location_id, date, assigned_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, date) DO UPDATE SET work_shift_id = EXCLUDED.work_shift_id`,
        [emp.id, shiftId, emp.location_id, date, hrAdmin],
      );
      assignments++;
    }
  }
  console.log(
    `  - scheduling: ${locations.length * shiftDefs.length} work shifts, ${assignments} shift assignments (14 days)`,
  );

  // =====================================================================
  // 4. PURCHASING CHAIN
  // =====================================================================
  const suppliers = await rows(client, `SELECT id, name FROM suppliers ORDER BY name`);
  const units = await rows(client, `SELECT id, code FROM units`);
  const kgUnit = units.find((u) => u.code === 'kg')?.id ?? units[0]?.id;
  const prStatuses: { status: string; note: string }[] = [
    { status: 'draft', note: 'Draf permintaan mingguan, belum diajukan' },
    { status: 'submitted', note: 'Menunggu persetujuan kepala gudang' },
    { status: 'approved', note: 'Disetujui, menunggu konversi ke PO' },
    { status: 'converted', note: 'Sudah dikonversi menjadi PO' },
    { status: 'rejected', note: 'Ditolak — stok masih mencukupi' },
  ];
  let prCount = 0;
  for (const [i, def] of prStatuses.entries()) {
    const marker = `SEED-PR-${i}`;
    if (await exists(client, `SELECT 1 FROM purchase_requests WHERE notes = $1`, [marker]))
      continue;
    const prNumber = await nextDocNumber(client, 'PR');
    const loc = i % 2 === 0 ? gdg : outlets[i % outlets.length]!.id;
    const pr = await one(
      client,
      `INSERT INTO purchase_requests (pr_number, location_id, status, requested_by, needed_by, rejection_reason, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        prNumber,
        loc,
        def.status,
        kepalaGudang,
        isoDate(daysAgo(-7)),
        def.status === 'rejected' ? 'Stok gudang masih mencukupi untuk 2 minggu' : null,
        marker,
      ],
    );
    for (const item of items.slice(i * 2, i * 2 + 3)) {
      await client.query(
        `INSERT INTO purchase_request_lines (pr_id, item_id, unit_id, qty, est_price, suggested_supplier_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (pr_id, item_id) DO NOTHING`,
        [
          pr!.id,
          item.id,
          kgUnit,
          rnd(10, 60),
          Number(item.avg_cost ?? 20000),
          pick(suppliers)?.id ?? null,
        ],
      );
    }
    prCount++;
  }
  console.log(
    `  - purchasing: ${prCount} purchase requests across draft/submitted/approved/converted/rejected`,
  );

  // PO receipts against the existing PO lines — the "goods arrived against a
  // PO we raised" path, including one short delivery so a discrepancy exists.
  const poLines = await rows(
    client,
    `SELECT pl.id, pl.po_id, pl.item_id, pl.qty_ordered, i.storage_type
                                      FROM po_lines pl JOIN items i ON i.id = pl.item_id`,
  );
  if (poLines.length) {
    const poId = poLines[0]!.po_id;
    const po = await one(client, `SELECT location_id FROM purchase_orders WHERE id = $1`, [poId]);
    const marker = 'SEED-POR-1';
    if (!(await exists(client, `SELECT 1 FROM po_receipts WHERE notes = $1`, [marker]))) {
      const receiptNumber = await nextDocNumber(client, 'POR');
      const rec = await one(
        client,
        `INSERT INTO po_receipts (receipt_number, po_id, received_by, received_at, status, notes)
         VALUES ($1,$2,$3,$4,'verified',$5) RETURNING id`,
        [receiptNumber, poId, kepalaGudang, daysAgo(2), marker],
      );
      for (const [i, line] of poLines.filter((l) => l.po_id === poId).entries()) {
        const areaId = areaFor(po!.location_id, line.storage_type);
        if (!areaId) continue;
        // Line 0 arrives short — a real receiving discrepancy to test against.
        const received = i === 0 ? Number(line.qty_ordered) * 0.8 : Number(line.qty_ordered);
        await client.query(
          `INSERT INTO po_receipt_lines (po_receipt_id, po_line_id, storage_area_id, qty_received, condition_notes)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (po_receipt_id, po_line_id, storage_area_id) DO NOTHING`,
          [
            rec!.id,
            line.id,
            areaId,
            received,
            i === 0 ? 'Kurang 20% — supplier kirim sebagian' : null,
          ],
        );
      }
      console.log('  - purchasing: 1 PO receipt (verified) with a short-delivery line');
    }
  }

  // Goods receipts — both allowed receipt_types.
  const grDefs: { type: string; note: string }[] = [
    { type: 'supplier_direct', note: 'Kiriman langsung supplier ke outlet' },
    { type: 'unmatched_delivery', note: 'Barang datang tanpa SJ / PO — perlu ditelusuri' },
  ];
  let grCount = 0;
  for (const [i, def] of grDefs.entries()) {
    const clientId = stableUuid(`seed-gr-${i}`);
    if (await exists(client, `SELECT 1 FROM goods_receipts WHERE client_id = $1`, [clientId]))
      continue;
    const receiptNumber = await nextDocNumber(client, 'GRN');
    const loc = outlets[i % outlets.length]!.id;
    const gr = await one(
      client,
      `INSERT INTO goods_receipts (receipt_number, receipt_type, location_id, received_by, received_at, status, notes, client_id)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7) RETURNING id`,
      [receiptNumber, def.type, loc, kepalaGudang, daysAgo(i + 1), def.note, clientId],
    );
    for (const item of items.slice(i * 3, i * 3 + 3)) {
      const areaId = areaFor(loc, item.storage_type);
      if (!areaId) continue;
      const expected = rnd(20, 80);
      await client.query(
        `INSERT INTO goods_receipt_lines (receipt_id, item_id, storage_area_id, qty_expected, qty_received, discrepancy_reason)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (receipt_id, item_id, storage_area_id) DO NOTHING`,
        [
          gr!.id,
          item.id,
          areaId,
          expected,
          def.type === 'unmatched_delivery' ? expected - 5 : expected,
          def.type === 'unmatched_delivery'
            ? 'Jumlah tidak cocok dengan surat jalan supplier'
            : null,
        ],
      );
    }
    grCount++;
  }
  console.log(`  - purchasing: ${grCount} goods receipts (supplier_direct + unmatched_delivery)`);

  // =====================================================================
  // 5. STOCK DEPLETION BACKFILL — sales must consume their recipe
  //
  // seed.ts posts opening_balance movements and then sells 400+ orders without
  // ever taking anything out of stock. The result: stock_movements held nothing
  // but opening_balance rows, balances never moved, and mv_item_usage_daily was
  // permanently empty — the deploy's REFRESH dutifully produced zero rows, so
  // every consumption report rendered blank against a database that looked
  // full. That is the worst failure mode: a working-looking system reporting
  // nothing, rather than an obviously broken one.
  //
  // This runs as a BACKFILL rather than inline in the sales loop because any
  // database seeded before this change already has its sales; an inline hook
  // would only ever fire for newly inserted ones and would never repair an
  // existing deployment. Idempotency comes from the ref_type/ref_id key: a sale
  // that already has usage_out movements is skipped. (A sale left half-posted
  // by an interrupted run is therefore skipped too, under-counting slightly
  // rather than double-drawing stock — the safe direction to err.)
  // =====================================================================
  {
    const recipeByProduct = new Map<
      string,
      { itemId: string; qty: number; storageType: string | null; avgCost: number }[]
    >();
    for (const r of await rows(
      client,
      `SELECT r.product_id, rl.item_id, rl.qty, i.storage_type, i.avg_cost
         FROM recipe_lines rl
         JOIN recipes r ON r.id = rl.recipe_id
         JOIN items i ON i.id = rl.item_id`,
    )) {
      const list = recipeByProduct.get(r.product_id) ?? [];
      list.push({
        itemId: r.item_id,
        qty: Number(r.qty),
        storageType: r.storage_type,
        avgCost: Number(r.avg_cost ?? 0),
      });
      recipeByProduct.set(r.product_id, list);
    }

    const pending = await rows(
      client,
      `SELECT s.id, s.location_id, s.occurred_at
         FROM sales s
        WHERE s.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM stock_movements m
             WHERE m.ref_type = 'sale' AND m.ref_id = s.id AND m.movement_type = 'usage_out')
        ORDER BY s.occurred_at`,
    );

    let depleted = 0;
    let movements = 0;
    let skippedShort = 0;
    for (const sale of pending) {
      const saleLines = await rows(
        client,
        `SELECT product_id, qty FROM sale_lines WHERE sale_id = $1`,
        [sale.id],
      );

      // Aggregate the whole sale before posting anything. stock_movements has a
      // natural-key unique index on (ref_type, ref_id, item_id, storage_area_id,
      // movement_type), so two lines on the same receipt that share an
      // ingredient — ayam goreng and ayam geprek both drawing chicken — must
      // become ONE movement for their combined qty, not two.
      const draws = new Map<
        string,
        { itemId: string; areaId: string; qty: number; avgCost: number }
      >();
      for (const line of saleLines) {
        for (const ing of recipeByProduct.get(line.product_id) ?? []) {
          const areaId = areaFor(sale.location_id, ing.storageType);
          if (!areaId) continue;
          const used = ing.qty * Number(line.qty);
          if (used <= 0) continue;
          const key = `${ing.itemId}|${areaId}`;
          const acc = draws.get(key);
          if (acc) acc.qty += used;
          else draws.set(key, { itemId: ing.itemId, areaId, qty: used, avgCost: ing.avgCost });
        }
      }

      // One transaction per sale. The decrement and its movement must land
      // together: crash between them and the balance no longer equals the sum
      // of its movements, which is precisely the corruption the reconciliation
      // console would later report as a real-world discrepancy. (An earlier
      // draft of this backfill did exactly that when it hit a unique violation
      // mid-sale.) seed.ts runs no outer transaction, so this is safe to open.
      let postedForSale = 0;
      await client.query('BEGIN');
      try {
        for (const draw of draws.values()) {
          const used = Number(draw.qty.toFixed(3));
          if (used <= 0) continue;
          // Guarded decrement: only move stock that is actually on hand, so a
          // balance can never go negative and the ledger invariant
          // (balance === sum of movements) holds. If the balance row is missing
          // or too short, post NO movement rather than an unbacked one — an
          // unbacked movement would break the very invariant the reconciliation
          // console is built to trust.
          const dec = await client.query(
            `UPDATE stock_balances SET qty_on_hand = qty_on_hand - $4
            WHERE location_id=$1 AND storage_area_id=$2 AND item_id=$3 AND qty_on_hand >= $4`,
            [sale.location_id, draw.areaId, draw.itemId, used],
          );
          if (dec.rowCount !== 1) {
            skippedShort++;
            continue;
          }
          await client.query(
            `INSERT INTO stock_movements (location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at)
           VALUES ($1,$2,$3,'usage_out',$4,$5,'sale',$6,$7)`,
            [
              sale.location_id,
              draw.areaId,
              draw.itemId,
              used,
              draw.avgCost,
              sale.id,
              sale.occurred_at,
            ],
          );
          movements++;
          postedForSale++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      if (postedForSale > 0) depleted++;
    }
    console.log(
      `  - stock depletion: ${movements} usage_out movements across ${depleted} sales` +
        (skippedShort
          ? ` (${skippedShort} ingredient draws skipped — no balance or insufficient stock)`
          : ''),
    );
  }

  // =====================================================================
  // 6. STOCK OPERATIONS
  // =====================================================================
  const opname = await one(
    client,
    `SELECT id, location_id, storage_area_id FROM stock_opname ORDER BY created_at LIMIT 1`,
  );
  if (opname) {
    let lines = 0;
    // Drive off the balances that actually exist rather than off the first N
    // items: seed.ts only stocks its 30 "core" items, and only into the storage
    // area matching each item's storage_type, so picking items blindly yielded
    // an opname with zero lines.
    //
    // stock_opname.storage_area_id is NULLABLE and means "count the whole
    // location" when unset. Filtering on `= $2` against NULL matched nothing,
    // so the area filter is applied only when set, and each line carries the
    // area its own balance sits in (the LINE's storage_area_id is NOT NULL
    // even when the header's is).
    //
    // The header may also point at an area that holds nothing — on the
    // production box it targeted the chiller, and no core item at that
    // location is `chilled`, so a correct count produced zero lines and the
    // opname flow could not be exercised at all. When that happens, re-point
    // the header at the area in the same location holding the most stock so
    // header and lines still agree, rather than silently emitting nothing.
    let countedArea: string | null = opname.storage_area_id;
    if (countedArea) {
      const hasStock = await exists(
        client,
        `SELECT 1 FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2`,
        [opname.location_id, countedArea],
      );
      if (!hasStock) {
        const fallback = await one(
          client,
          `SELECT storage_area_id FROM stock_balances WHERE location_id = $1
           GROUP BY storage_area_id ORDER BY count(*) DESC LIMIT 1`,
          [opname.location_id],
        );
        if (fallback) {
          countedArea = fallback.storage_area_id;
          await client.query(`UPDATE stock_opname SET storage_area_id = $2 WHERE id = $1`, [
            opname.id,
            countedArea,
          ]);
          console.log('    (opname header re-pointed: its storage area held no stock)');
        }
      }
    }
    const counted = await rows(
      client,
      `SELECT item_id, storage_area_id, qty_on_hand FROM stock_balances
       WHERE location_id = $1 AND ($2::uuid IS NULL OR storage_area_id = $2)
       ORDER BY item_id LIMIT 12`,
      [opname.location_id, countedArea],
    );
    for (const bal of counted) {
      const item = { id: bal.item_id };
      const lineArea = bal.storage_area_id;
      const systemQty = Number(bal.qty_on_hand);
      // Most lines tally; a few diverge — an opname where everything matches
      // exercises nothing.
      const diff = lines % 4 === 0 ? -rnd(1, 5) : 0;
      await client.query(
        `INSERT INTO stock_opname_lines (opname_id, storage_area_id, item_id, system_qty, counted_qty, diff_qty, variance_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (opname_id, storage_area_id, item_id) DO UPDATE
           SET system_qty = EXCLUDED.system_qty, counted_qty = EXCLUDED.counted_qty, diff_qty = EXCLUDED.diff_qty`,
        [
          opname.id,
          lineArea,
          item.id,
          systemQty,
          systemQty + diff,
          diff,
          diff !== 0 ? 'Selisih hasil hitung fisik — kemungkinan susut penyimpanan' : null,
        ],
      );
      lines++;
    }
    console.log(`  - stock: ${lines} opname lines (with variances)`);

    // Adjustments arising from those variances, plus one manual correction.
    let adj = 0;
    const variances = await rows(
      client,
      `SELECT item_id, diff_qty, storage_area_id FROM stock_opname_lines WHERE opname_id = $1 AND diff_qty <> 0`,
      [opname.id],
    );
    for (const v of variances) {
      const marker = `SEED-ADJ-${opname.id}-${v.item_id}`;
      if (await exists(client, `SELECT 1 FROM stock_adjustments WHERE reason = $1`, [marker]))
        continue;
      const number = await nextDocNumber(client, 'ADJ');
      const item = items.find((it) => it.id === v.item_id);
      await client.query(
        `INSERT INTO stock_adjustments (adjustment_number, location_id, storage_area_id, item_id, qty_delta, unit_cost,
                                        reason, source, opname_id, created_by, approved_by, applied_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'opname',$8,$9,$10,$11)`,
        [
          number,
          opname.location_id,
          v.storage_area_id,
          v.item_id,
          v.diff_qty,
          Number(item?.avg_cost ?? 0),
          marker,
          opname.id,
          kepalaGudang,
          owner,
          daysAgo(1),
        ],
      );
      adj++;
    }
    console.log(`  - stock: ${adj} opname-sourced adjustments`);
  }

  // Three-tier divergence rows — the condition the reconciliation console
  // exists to surface. Seeded open so it is visible, not pre-resolved.
  let recon = 0;
  for (const [i, loc] of outlets.slice(0, 3).entries()) {
    const item = items[i]!;
    const areaId = areaFor(loc.id, item.storage_type);
    if (!areaId) continue;
    const tier = (['device', 'node', 'cloud'] as const)[i % 3]!;
    const expected = rnd(40, 90);
    const stored = expected - rnd(1, 6);
    const marker = `seed-recon-${loc.code}-${item.id}`;
    if (
      await exists(client, `SELECT 1 FROM stock_reconciliations WHERE detail->>'marker' = $1`, [
        marker,
      ])
    )
      continue;
    await client.query(
      `INSERT INTO stock_reconciliations (location_id, storage_area_id, item_id, tier, expected_qty, stored_qty, divergence, detail, status, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
      [
        loc.id,
        areaId,
        item.id,
        tier,
        expected,
        stored,
        stored - expected,
        JSON.stringify({
          marker,
          note: `Divergensi tier ${tier} terdeteksi saat rekonsiliasi harian`,
        }),
        daysAgo(1),
      ],
    );
    recon++;
  }
  console.log(`  - stock: ${recon} open three-tier reconciliation divergences`);

  // =====================================================================
  // 7. POS EXCEPTIONS — void / refund
  // =====================================================================
  const saleRows = await rows(
    client,
    `SELECT id, total, location_id, kasir_id, occurred_at FROM sales ORDER BY occurred_at DESC LIMIT 6`,
  );
  const vrDefs: { type: string; status: string; reason: string }[] = [
    {
      type: 'void',
      status: 'approved',
      reason: 'Salah input menu — dibatalkan sebelum diserahkan',
    },
    { type: 'refund', status: 'approved', reason: 'Pesanan salah, pelanggan minta pengembalian' },
    { type: 'void', status: 'pending', reason: 'Struk dobel, menunggu persetujuan supervisor' },
    { type: 'refund', status: 'rejected', reason: 'Pengajuan lewat batas waktu' },
  ];
  let vr = 0;
  for (const [i, def] of vrDefs.entries()) {
    const sale = saleRows[i];
    if (!sale) break;
    const clientId = stableUuid(`seed-voidrefund-${sale.id}-${def.type}`);
    if (await exists(client, `SELECT 1 FROM void_refunds WHERE client_id = $1`, [clientId]))
      continue;
    const approved = def.status === 'approved';
    await client.query(
      `INSERT INTO void_refunds (sale_id, type, amount, reason, status, requested_by, approved_by, approved_at,
                                 offline_authorized, reverification_status, rejection_reason, client_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        sale.id,
        def.type,
        sale.total,
        def.reason,
        def.status,
        sale.kasir_id,
        approved ? owner : null,
        approved ? sale.occurred_at : null,
        // One approved void carries an offline authorization awaiting re-verification.
        i === 0,
        i === 0 ? 'verified' : null,
        def.status === 'rejected' ? 'Melewati batas 24 jam' : null,
        clientId,
        sale.occurred_at,
      ],
    );
    vr++;
  }
  console.log(`  - POS: ${vr} void/refund records (approved, pending, rejected)`);

  // =====================================================================
  // 8. FINANCE — attachments, payment verifications, petty cash lines
  // =====================================================================
  // Attachments are metadata rows only: no object is uploaded to MinIO, so
  // any download in the UI will 404. That is deliberate — a fake object would
  // hide a broken storage wiring. object_key is unique, hence the upsert.
  const attachmentIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const key = `seed/proof/transfer-${i + 1}.jpg`;
    const found = await one(client, `SELECT id FROM attachments WHERE object_key = $1`, [key]);
    if (found) {
      attachmentIds.push(found.id);
      continue;
    }
    const ins = await one(
      client,
      `INSERT INTO attachments (bucket, object_key, file_name, mime_type, size_bytes, kind, entity_type, location_id, uploaded_by)
       VALUES ('mimi',$1,$2,'image/jpeg',$3,'payment_proof','payment_verification',$4,$5) RETURNING id`,
      [
        key,
        `bukti-transfer-${i + 1}.jpg`,
        rnd(80_000, 400_000),
        outlets[i % outlets.length]!.id,
        finance,
      ],
    );
    attachmentIds.push(ins!.id);
  }

  const payrollRun = await one(client, `SELECT id FROM payroll_runs ORDER BY created_at LIMIT 1`);
  const pettyCash = await one(
    client,
    `SELECT id, location_id, total_amount FROM petty_cash ORDER BY created_at LIMIT 1`,
  );
  const purchaseOrder = await one(
    client,
    `SELECT id, total, supplier_id, location_id FROM purchase_orders ORDER BY created_at LIMIT 1`,
  );

  const pvDefs: {
    ref: string;
    refId: string | null;
    payeeType: string;
    payeeId: string | null;
    amount: number;
    status: string;
    loc: string | null;
  }[] = [];
  if (purchaseOrder)
    pvDefs.push({
      ref: 'purchase_order',
      refId: purchaseOrder.id,
      payeeType: 'supplier',
      payeeId: purchaseOrder.supplier_id,
      amount: Number(purchaseOrder.total),
      status: 'paid',
      loc: purchaseOrder.location_id,
    });
  if (payrollRun)
    pvDefs.push({
      ref: 'payroll_run',
      refId: payrollRun.id,
      payeeType: 'employee',
      payeeId: null,
      amount: 45_000_000,
      status: 'verified',
      loc: gdg,
    });
  if (pettyCash)
    pvDefs.push({
      ref: 'petty_cash',
      refId: pettyCash.id,
      payeeType: 'other',
      payeeId: null,
      amount: Number(pettyCash.total_amount),
      status: 'pending',
      loc: pettyCash.location_id,
    });
  pvDefs.push({
    ref: 'other',
    refId: null,
    payeeType: 'platform',
    payeeId: null,
    amount: 2_500_000,
    status: 'rejected',
    loc: outlets[0]!.id,
  });

  let pvCount = 0;
  const pvIdByRef: Record<string, string> = {};
  for (const [i, def] of pvDefs.entries()) {
    const marker = `SEED-PV-${def.ref}-${i}`;
    const existing = await one(client, `SELECT id FROM payment_verifications WHERE notes = $1`, [
      marker,
    ]);
    if (existing) {
      pvIdByRef[def.ref] = existing.id;
      continue;
    }
    const pvNumber = await nextDocNumber(client, 'PV');
    const isPaid = def.status === 'paid';
    const isVerified = isPaid || def.status === 'verified';
    const ins = await one(
      client,
      `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, status,
         proof_attachment_id, reference_number, submitted_by, verified_by, verified_at, paid_by, paid_at, paid_via,
         rejection_reason, location_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        pvNumber,
        def.ref,
        def.refId,
        def.payeeType,
        def.payeeId,
        def.amount,
        def.status,
        attachmentIds[i % attachmentIds.length] ?? null,
        isPaid ? `TRX${rnd(100000, 999999)}` : null,
        finance,
        isVerified ? owner : null,
        isVerified ? daysAgo(2) : null,
        isPaid ? finance : null,
        isPaid ? daysAgo(1) : null,
        isPaid ? 'bank_transfer' : null,
        def.status === 'rejected' ? 'Bukti transfer tidak terbaca' : null,
        def.loc,
        marker,
      ],
    );
    pvIdByRef[def.ref] = ins!.id;
    pvCount++;
  }
  console.log(
    `  - finance: ${pvCount} payment verifications (paid/verified/pending/rejected) + ${attachmentIds.length} proof attachments`,
  );

  if (pettyCash) {
    const pcLines: [string, number, string][] = [
      ['Gas LPG 12kg', 2, 'operasional'],
      ['Sabun cuci piring', 4, 'operasional'],
      ['Kantong plastik ukuran besar', 10, 'operasional'],
      ['Ongkos kirim tambahan', 1, 'transportasi'],
    ];
    let added = 0;
    for (const [desc, qty, category] of pcLines) {
      if (
        await exists(
          client,
          `SELECT 1 FROM petty_cash_lines WHERE petty_cash_id = $1 AND description = $2`,
          [pettyCash.id, desc],
        )
      )
        continue;
      await client.query(
        `INSERT INTO petty_cash_lines (petty_cash_id, description, qty, amount, expense_category)
         VALUES ($1,$2,$3,$4,$5)`,
        [pettyCash.id, desc, qty, rnd(15_000, 220_000), category],
      );
      added++;
    }
    // Keep the header consistent with its lines — a header total that does not
    // equal the sum of its lines is exactly the kind of quiet inconsistency a
    // finance test should not have to chase down to a seed bug.
    await client.query(
      `UPDATE petty_cash SET total_amount = (SELECT COALESCE(SUM(amount),0) FROM petty_cash_lines WHERE petty_cash_id = $1) WHERE id = $1`,
      [pettyCash.id],
    );
    if (pvIdByRef['petty_cash']) {
      await client.query(
        `UPDATE petty_cash SET payment_verification_id = $2 WHERE id = $1 AND payment_verification_id IS NULL`,
        [pettyCash.id, pvIdByRef['petty_cash']],
      );
    }
    console.log(`  - finance: ${added} petty-cash lines, header total recomputed`);
  }

  // =====================================================================
  // 9. ASSETS — maintenance jobs + service history
  // =====================================================================
  const assets = await rows(
    client,
    `SELECT id, name, location_id FROM assets ORDER BY asset_number`,
  );
  const schedules = await rows(client, `SELECT id, asset_id, name FROM maintenance_schedules`);
  const jobDefs: { type: string; status: string; offsetDays: number }[] = [
    { type: 'scheduled', status: 'done', offsetDays: 10 },
    { type: 'scheduled', status: 'scheduled', offsetDays: -14 },
    { type: 'corrective', status: 'in_progress', offsetDays: 1 },
    { type: 'scheduled', status: 'verified', offsetDays: 30 },
    { type: 'corrective', status: 'due', offsetDays: -1 },
  ];
  let jobs = 0;
  const jobIds: string[] = [];
  for (const [i, def] of jobDefs.entries()) {
    const asset = assets[i % Math.max(assets.length, 1)];
    if (!asset) break;
    const marker = `SEED-MJ-${i}`;
    const existing = await one(client, `SELECT id FROM maintenance_jobs WHERE notes = $1`, [
      marker,
    ]);
    if (existing) {
      jobIds.push(existing.id);
      continue;
    }
    const jobNumber = await nextDocNumber(client, 'MJ');
    const done = def.status === 'done' || def.status === 'verified';
    const verified = def.status === 'verified';
    const ins = await one(
      client,
      `INSERT INTO maintenance_jobs (job_number, asset_id, schedule_id, type, status, due_date, assigned_to,
         completed_by, completed_at, cost, verified_by, verified_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      // NOTE: assigned_to references EMPLOYEES, while completed_by/verified_by
      // reference USERS — the one place in this module where a "who did it"
      // column is not a user id.
      [
        jobNumber,
        asset.id,
        schedules.find((s) => s.asset_id === asset.id)?.id ?? null,
        def.type,
        def.status,
        isoDate(daysAgo(def.offsetDays)),
        employees[i % Math.max(employees.length, 1)]?.id ?? null,
        done ? kepalaGudang : null,
        done ? daysAgo(Math.max(def.offsetDays - 1, 0)) : null,
        done ? rnd(150_000, 2_500_000) : null,
        verified ? owner : null,
        verified ? daysAgo(Math.max(def.offsetDays - 2, 0)) : null,
        marker,
      ],
    );
    jobIds.push(ins!.id);
    jobs++;
  }
  let history = 0;
  for (const [i, jobId] of jobIds.entries()) {
    const job = await one(
      client,
      `SELECT asset_id, completed_at, cost FROM maintenance_jobs WHERE id = $1`,
      [jobId],
    );
    if (!job?.completed_at) continue;
    if (await exists(client, `SELECT 1 FROM service_history WHERE job_id = $1`, [jobId])) continue;
    await client.query(
      `INSERT INTO service_history (asset_id, job_id, service_date, description, vendor, cost, condition_after, odometer_km, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        job.asset_id,
        jobId,
        isoDate(new Date(job.completed_at)),
        'Servis rutin: pembersihan, penggantian sparepart aus, uji fungsi',
        pick(['Bengkel Sinar Jaya', 'CV Teknik Mandiri', 'Service Center Resmi']),
        Number(job.cost ?? 0),
        pick(['good', 'fair']),
        rnd(10_000, 90_000),
        kepalaGudang,
      ],
    );
    history++;
  }
  console.log(
    `  - assets: ${jobs} maintenance jobs across the status range, ${history} service-history entries`,
  );

  // =====================================================================
  // 10. SYNC / DEVICE RUNTIME
  //
  // Fixture data, seeded on request. These tables normally fill from real
  // device traffic; nothing below implies a device ever connected.
  // =====================================================================
  const devices = await rows(
    client,
    `SELECT id, location_id, category FROM devices ORDER BY created_at`,
  );

  let nodes = 0;
  for (const [locIndex, loc] of locations.entries()) {
    // NOT every outlet gets a branch node, on purpose. Nodes are Phase 1.5
    // hardware (BUILD-PLAN RISK-P5) and D-13's topology tree is explicitly
    // required to "degrade gracefully" to a node-less outlet — a state that
    // cannot be exercised, or even seen, if the seed installs a node
    // everywhere. Roughly every third outlet is deliberately left without one.
    // (The device-registry topology suite asserts exactly this, and started
    // failing the moment this seed gave all 21 locations a node.)
    if (loc.code !== 'GDG' && locIndex % 3 === 2) continue;
    const status =
      loc.code === 'GDG'
        ? 'online'
        : nodes % 4 === 3
          ? 'stale'
          : nodes % 5 === 4
            ? 'unpaired'
            : 'online';
    const paired = status !== 'unpaired';
    await client.query(
      `INSERT INTO branch_nodes (location_id, name, status, version, hostname, ip_address, os_info, last_seen_at, paired_at, paired_by, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (location_id) DO UPDATE SET status = EXCLUDED.status, version = EXCLUDED.version,
         last_seen_at = EXCLUDED.last_seen_at`,
      [
        loc.id,
        `Node ${loc.code}`,
        status,
        '1.4.2',
        `node-${loc.code.toLowerCase()}`,
        `10.20.${30 + nodes}.10`,
        JSON.stringify({ os: 'Debian 12', arch: 'arm64', kernel: '6.1.0' }),
        status === 'stale' ? daysAgo(2) : new Date(),
        paired ? daysAgo(40) : null,
        paired ? owner : null,
        JSON.stringify({ syncIntervalSec: 30, discoveryEnabled: true }),
      ],
    );
    nodes++;
  }
  const nodeRows = await rows(client, `SELECT id, location_id FROM branch_nodes`);
  const nodeByLoc = Object.fromEntries(nodeRows.map((n) => [n.location_id, n.id])) as Record<
    string,
    string
  >;

  // Pairing tokens: one live, one already used, one expired.
  const tokenDefs: { target: string; state: 'live' | 'used' | 'expired' }[] = [
    { target: 'device', state: 'live' },
    { target: 'device', state: 'used' },
    { target: 'node', state: 'expired' },
  ];
  let tokens = 0;
  for (const [i, def] of tokenDefs.entries()) {
    // Hash of a throwaway string — never a real token. Pairing tokens are
    // stored hashed, so there is no usable secret here by construction.
    const hash = createHash('sha256').update(`seed-pairing-token-${i}`).digest('hex');
    if (await exists(client, `SELECT 1 FROM pairing_tokens WHERE token_hash = $1`, [hash]))
      continue;
    await client.query(
      `INSERT INTO pairing_tokens (token_hash, display_code, target_type, location_id, suggested_category, created_by, expires_at, used_at, used_by_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        hash,
        `${String(rnd(100, 999))}-${String(rnd(100, 999))}`,
        def.target,
        outlets[i % outlets.length]!.id,
        def.target === 'device' ? 'pos_tablet' : null,
        owner,
        def.state === 'expired' ? daysAgo(1) : daysAgo(-1),
        def.state === 'used' ? daysAgo(3) : null,
        def.state === 'used' ? (devices[0]?.id ?? null) : null,
      ],
    );
    tokens++;
  }

  // Devices spotted on the LAN but not yet confirmed into the fleet.
  const discDefs: {
    source: string;
    category: string;
    vendor: string;
    model: string;
    status: string;
  }[] = [
    { source: 'mdns', category: 'printer', vendor: 'Epson', model: 'TM-T82X', status: 'new' },
    {
      source: 'onvif',
      category: 'cctv',
      vendor: 'Hikvision',
      model: 'DS-2CD1043G2',
      status: 'new',
    },
    {
      source: 'tcp_probe',
      category: 'pos_tablet',
      vendor: 'Samsung',
      model: 'Galaxy Tab A9',
      status: 'ignored',
    },
    {
      source: 'ssdp',
      category: 'printer',
      vendor: 'Brother',
      model: 'QL-820NWB',
      status: 'confirmed',
    },
  ];
  let discovered = 0;
  for (const [i, def] of discDefs.entries()) {
    const loc = outlets[i % outlets.length]!;
    const nodeId = nodeByLoc[loc.id];
    if (!nodeId) continue;
    const ip = `10.20.${30 + (i % 5)}.${100 + i}`;
    const mac = `AA:BB:CC:${String(10 + i).padStart(2, '0')}:${String(20 + i).padStart(2, '0')}:01`;
    await client.query(
      `INSERT INTO discovered_devices (node_id, source, ip_address, mac_address, vendor, model, suggested_category, suggested_name, status, confirmed_device_id, first_seen_at, last_seen_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (node_id, ip_address, mac_address) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, status = EXCLUDED.status`,
      [
        nodeId,
        def.source,
        ip,
        mac,
        def.vendor,
        def.model,
        def.category,
        `${def.vendor} ${def.model}`,
        def.status,
        def.status === 'confirmed'
          ? (devices.find((d) => d.location_id === loc.id)?.id ?? null)
          : null,
        daysAgo(5),
        daysAgo(0),
        JSON.stringify({ discoveredBy: def.source, ttl: 120 }),
      ],
    );
    discovered++;
  }
  console.log(
    `  - devices: ${nodes} branch nodes, ${tokens} pairing tokens, ${discovered} discovered devices`,
  );

  // Sync cursors + batches. Sequences are derived from the real sync_events
  // high-water mark so the fixtures cannot claim a cursor ahead of the log.
  const maxSeq = Number(
    (await one(client, `SELECT COALESCE(MAX(server_seq),0) AS s FROM sync_events`))?.s ?? 0,
  );
  let cursors = 0;
  for (const [i, d] of devices.slice(0, 12).entries()) {
    await client.query(
      `INSERT INTO sync_cursors (subscriber_type, subscriber_id, stream, cursor)
       VALUES ('device',$1,'main',$2)
       ON CONFLICT (subscriber_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor`,
      [d.id, Math.max(maxSeq - (i % 5), 0)],
    );
    cursors++;
  }
  for (const n of nodeRows) {
    await client.query(
      `INSERT INTO sync_cursors (subscriber_type, subscriber_id, stream, cursor)
       VALUES ('node',$1,'main',$2)
       ON CONFLICT (subscriber_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor`,
      [n.id, maxSeq],
    );
    cursors++;
  }

  let batches = 0;
  const batchStates: { status: string; events: number }[] = [
    { status: 'applied', events: 12 },
    { status: 'applied', events: 8 },
    { status: 'partial', events: 6 },
    { status: 'failed', events: 3 },
    { status: 'received', events: 5 },
  ];
  for (const [i, def] of batchStates.entries()) {
    const d = devices[i % Math.max(devices.length, 1)];
    if (!d) break;
    const id = stableUuid(`seed-sync-batch-${i}`);
    if (await exists(client, `SELECT 1 FROM sync_batches WHERE id = $1`, [id])) continue;
    const first = Math.max(maxSeq - def.events * (i + 1), 1);
    await client.query(
      `INSERT INTO sync_batches (id, origin_tier, origin_device_id, location_id, event_count, first_seq, last_seq, status, result, received_at, processed_at)
       VALUES ($1,'device',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        d.id,
        d.location_id,
        def.events,
        first,
        first + def.events - 1,
        def.status,
        JSON.stringify(
          def.status === 'failed'
            ? { error: 'schema_version_mismatch', applied: 0 }
            : def.status === 'partial'
              ? { applied: def.events - 2, rejected: 2, reason: 'duplicate_client_id' }
              : { applied: def.events },
        ),
        daysAgo(i),
        def.status === 'received' ? null : daysAgo(i),
      ],
    );
    batches++;
  }

  // Open conflicts across the queues the console routes by.
  const conflictDefs: {
    kind: string;
    queue: string;
    entity: string;
    assignee: string;
    physical: boolean;
  }[] = [
    {
      kind: 'double_count',
      queue: 'conflict',
      entity: 'stock_opname',
      assignee: 'kepala_gudang',
      physical: true,
    },
    {
      kind: 'duplicate_receipt',
      queue: 'exception',
      entity: 'goods_receipts',
      assignee: 'kepala_gudang',
      physical: true,
    },
    {
      kind: 'attendance_overlap',
      queue: 'hr',
      entity: 'attendance',
      assignee: 'hr_admin',
      physical: false,
    },
    {
      kind: 'offline_auth',
      queue: 'finance',
      entity: 'void_refunds',
      assignee: 'finance',
      physical: false,
    },
    {
      kind: 'decision_race',
      queue: 'conflict',
      entity: 'approvals',
      assignee: 'manager',
      physical: false,
    },
  ];
  let conflicts = 0;
  for (const [i, def] of conflictDefs.entries()) {
    const marker = `seed-conflict-${i}`;
    if (await exists(client, `SELECT 1 FROM sync_conflicts WHERE detail->>'marker' = $1`, [marker]))
      continue;
    await client.query(
      `INSERT INTO sync_conflicts (kind, queue, entity, location_id, detail, physical_effect_suspected, assignee_role, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
      [
        def.kind,
        def.queue,
        def.entity,
        outlets[i % outlets.length]!.id,
        JSON.stringify({
          marker,
          note: `Konflik ${def.kind} terdeteksi saat menerapkan batch sinkronisasi`,
        }),
        def.physical,
        def.assignee,
      ],
    );
    conflicts++;
  }
  console.log(
    `  - sync: ${cursors} cursors, ${batches} batches (applied/partial/failed/received), ${conflicts} open conflicts`,
  );

  // Offline credentials + the authorizations minted against them.
  //
  // SECURITY: binding_secret_enc and pin_verifier below are NOT usable
  // credentials — they are random bytes and a hash of a throwaway string, so
  // no seeded PIN can authorise anything. Every row is also already expired.
  // The point is to give the offline-authorization review screen rows to show,
  // not to create a working offline login.
  let creds = 0;
  const credIds: { id: string; userId: string; deviceId: string | null; locId: string }[] = [];
  for (const [i, d] of devices.slice(0, 4).entries()) {
    const credentialId = stableUuid(`seed-offline-cred-${i}`);
    const userId = [owner, kepalaGudang, hrAdmin, finance][i % 4]!;
    credIds.push({ id: credentialId, userId, deviceId: d.id, locId: d.location_id });
    if (
      await exists(client, `SELECT 1 FROM offline_credentials WHERE credential_id = $1`, [
        credentialId,
      ])
    )
      continue;
    await client.query(
      `INSERT INTO offline_credentials (credential_id, user_id, device_id, role_key, location_ids, scopes,
         binding_secret_enc, pin_verifier, selfie_required_above, volume_cap, use_count, minted_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        credentialId,
        userId,
        d.id,
        ['owner', 'kepala_gudang', 'hr_admin', 'finance'][i % 4],
        [d.location_id],
        JSON.stringify({ void: { maxIdr: '500000' }, discount: { maxIdr: '100000' } }),
        Buffer.from(createHash('sha256').update(`seed-binding-${i}`).digest('hex').slice(0, 32)),
        createHash('sha256').update(`seed-pin-verifier-${i}`).digest('hex'),
        200_000,
        20,
        rnd(0, 12),
        daysAgo(10),
        // Already expired: a seeded credential must never be usable.
        daysAgo(3),
        i === 3 ? daysAgo(4) : null,
      ],
    );
    creds++;
  }
  let auths = 0;
  const authOutcomes: { outcome: string; verdict: string | null }[] = [
    { outcome: 'verified', verdict: 'upheld' },
    { outcome: 'pending_verification', verdict: null },
    { outcome: 'failed', verdict: 'rejected' },
    { outcome: 'unprovable', verdict: null },
  ];
  for (const [i, def] of authOutcomes.entries()) {
    const cred = credIds[i % credIds.length];
    if (!cred?.deviceId) continue;
    const id = stableUuid(`seed-offline-auth-${i}`);
    if (await exists(client, `SELECT 1 FROM offline_authorizations WHERE id = $1`, [id])) continue;
    const reviewed = def.verdict !== null;
    await client.query(
      `INSERT INTO offline_authorizations (id, credential_id, user_id, device_id, location_id, document_type, document_id,
         action, amount, binding_hmac, pin_attempts_before_success, granted_at, relay_received_at, synced_at,
         outcome, failure_reason, verdict, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        cred.id,
        cred.userId,
        cred.deviceId,
        cred.locId,
        'void_refund',
        saleRows[i % Math.max(saleRows.length, 1)]?.id ?? stableUuid(`seed-auth-doc-${i}`),
        'approve_void',
        rnd(50_000, 450_000),
        createHash('sha256').update(`seed-auth-hmac-${i}`).digest('hex'),
        rnd(0, 2),
        daysAgo(i + 2),
        daysAgo(i + 2),
        def.outcome === 'pending_verification' ? null : daysAgo(i + 1),
        def.outcome,
        def.outcome === 'failed'
          ? 'Binding HMAC tidak cocok saat diverifikasi ulang'
          : def.outcome === 'unprovable'
            ? 'Perangkat di-reset sebelum bukti tersinkron'
            : null,
        def.verdict,
        reviewed ? owner : null,
        reviewed ? daysAgo(i) : null,
      ],
    );
    auths++;
  }
  console.log(
    `  - offline: ${creds} (expired) offline credentials, ${auths} offline authorizations across the review outcomes`,
  );

  console.log('\n✓ Extended seed completed.\n');
}
