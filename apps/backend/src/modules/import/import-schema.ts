/**
 * The pure half of the BFF bulk importer: CSV parsing, per-entity column
 * definitions, and row validation. No database, no `pg`, no Nest — so it is
 * unit-testable directly and a malformed file is rejected before an RLS
 * transaction is even opened.
 *
 * WHY A LOCAL COPY RATHER THAN IMPORTING `database/import-schema.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * That file is the origin of this one's shape — same `parseCsv` (verbatim:
 * it is already locale-neutral, nothing to adapt), same three entities'
 * column lists, kinds, `required` flags, enum values and decimal scales. It
 * was NOT pulled in as a workspace dependency because `@mimi/database` is a
 * dev-only CLI package (bcrypt, direct `pg.Client`, its own `tsx` toolchain)
 * with no `exports` map for backend consumption, and `apps/backend` adding it
 * would mean editing `package.json` / the pnpm lockfile while another agent
 * has this same checkout open on an unrelated feature (chat) — exactly the
 * kind of shared-file collision the task brief asked to avoid. Mirroring the
 * ~180 lines of pure schema here costs one now-two-places-to-update fact;
 * forking the *meaning* of "what is a valid items row" would have cost much
 * more, which is why this file's entity defs are transcribed from the
 * original, not re-derived. Follow-up worth doing later: give `@mimi/database`
 * a real `exports` map so this can become a real import.
 *
 * ONE DELIBERATE DIVERGENCE FROM THE CLI VERSION: every message here is
 * Bahasa Indonesia. The CLI's English console output is a developer tool;
 * this file's `message`s are rendered directly in the back-office preview
 * table for an Indonesian-speaking Owner/Manager, with no i18n layer in
 * between (the message text is inherently dynamic — "kolom X tidak
 * ditemukan" always mentions the actual bad value — so it cannot be a fixed
 * i18n key the way static UI copy is).
 *
 * A SECOND DIVERGENCE: `validate()` here returns `headerOk` explicitly
 * instead of the caller inferring "was this a header-level failure" from
 * `rows.length === 0`, which is genuinely ambiguous (a file whose header is
 * fine but every single data row is bad also ends with `rows: []`). The BFF
 * needs that distinction to answer "did the whole file fail, or just some
 * rows" — the CLI never needed it because it prints everything either way.
 */

export interface ParsedCsv {
  header: string[];
  /** 1-based FILE line numbers, so an error message matches what the editor shows. */
  rows: { line: number; values: string[] }[];
}

/**
 * RFC4180-ish CSV: double quotes around fields, `""` for a literal quote,
 * commas and newlines allowed inside quotes, CRLF or LF line endings.
 * Verbatim port of `database/import-schema.ts`'s `parseCsv` — this part of
 * the original has nothing locale-specific to adapt.
 */
export function parseCsv(text: string): ParsedCsv {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM from Excel
  const records: { line: number; values: string[] }[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // A blank trailing line is not a record.
    if (!(row.length === 1 && row[0]!.trim() === '')) {
      records.push({ line: rowStartLine, values: row });
    }
    row = [];
    rowStartLine = line;
  };

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      // handled by the \n that follows
    } else if (ch === '\n') {
      line++;
      pushRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) pushRow();

  const first = records.shift();
  return {
    header: (first?.values ?? []).map((h) => h.trim()),
    rows: records,
  };
}

/**
 * Serializes a header + rows back to CSV text (CRLF — what Excel exports,
 * and what `parseCsv` above is explicitly tested against). Used only for the
 * `GET .../template` response; quoting mirrors `parseCsv`'s own rules so a
 * downloaded-then-reuploaded template round-trips exactly.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const quote = (value: string): string => {
    if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  };
  return rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

/**
 * A CSV row whose FIRST cell (after trim) starts with `#` is the template's
 * own guidance row, not data — see `buildTemplate()`'s doc comment for why
 * guidance lives there instead of a separate "example" row. Both `preview`
 * and `commit` must strip these before validation, so a user who never
 * deletes the guidance row (a very likely thing to forget) does not get a
 * confusing "required column is empty" error pointing at row 2.
 */
export function stripGuidanceRows(csv: ParsedCsv): ParsedCsv {
  return {
    header: csv.header,
    rows: csv.rows.filter((r) => !(r.values[0] ?? '').trim().startsWith('#')),
  };
}

export type ColumnKind = 'text' | 'int' | 'decimal' | 'boolean' | 'enum' | 'date' | 'time';

export interface ColumnDef {
  name: string;
  kind: ColumnKind;
  required?: boolean;
  /** For `enum`. */
  values?: readonly string[];
  /** Decimal places for `decimal` — money is 2, quantity 3 (CONTRACTS §0). */
  scale?: number;
  /** One line, Indonesian, shown in the template's guidance row and folded into FK error messages. */
  hint: string;
  /** Set when this column is a foreign key carried as a human name/code rather than a UUID. */
  fk?: { table: string; column: string; label: string };
}

/**
 * `products` is back. It was dropped in 6c1ba04 because it resolved menu
 * categories against a `product_categories` table that did not exist and
 * passed a `categoryId` that `CreateProductDto` did not have — the model it
 * needed was unlanded work in another workstream. Migrations 239/240 landed
 * that model (the table, the `category_id` FK, and the DTO field), so the
 * entity compiles and runs against a real schema again.
 *
 * The sheet still carries a category NAME, not an id — a spreadsheet author
 * types "Ayam", never a UUID. `planProduct` resolves it and fails the row with
 * a line number when the category does not exist yet, rather than creating menu
 * categories as a side effect of a product import.
 *
 * FIVE MORE MASTER/REFERENCE ENTITIES landed in the same round `suppliers`
 * was requested for (owner ask, 2026-08-27) — see `import.module.ts`'s header
 * for the full per-entity reasoning: `chart_of_accounts`/`employees`/
 * `work_shifts`/`assets`/`salary_components`.
 *
 * `suppliers` was BLOCKED for most of that round and is now here. It looked
 * identical to every other entity on paper (`SupplierService` has both `create`
 * and `update`), but both of those unconditionally called
 * `SyncEmitService.emit(undefined, { entity: 'suppliers', ... })`, and
 * `suppliers` is class `X` with an EMPTY `ops` list in `@mimi/sync-protocol`'s
 * authority matrix (FR-SUP-06 role lock — supplier pricing must never reach a
 * device). `canOriginate` rejects an unknown op before it ever reaches the
 * cloud-tier exemption, so the call threw every time. That was never breakage
 * from this module: it was the same bug that made the hand-typed "Add
 * Supplier" screen fail too, hidden because every supplier test stubbed
 * `emit` as a no-op. The emits were the error, not the matrix — a class-X
 * event has no consumer — so they were removed from
 * `modules/supplier/supplier.service.ts` (see its constructor comment), which
 * unblocked both the screen and this importer.
 *
 * PRICES ARE NOT IMPORTABLE HERE, deliberately. This entity covers the supplier
 * RECORD only — contact, terms, bank. A supplier's per-item price lives in
 * `supplier_items` with an append-only `supplier_price_history` row per change
 * (FR-SUP-04), which is a different natural key (supplier + item) and a
 * different sheet. Folding it in would let one CSV column silently write
 * history rows nobody asked it to.
 *
 * `units`/`locations`/`recipes` are intentionally NOT here: `units` because
 * `UnitService` (the real domain service this module delegates every write
 * to, per this file's header comment) exposes no update method — only
 * `createUnit` — so an upsert-on-natural-key import could never update an
 * existing unit's name, unlike every other entity here; `recipes` and
 * `locations` are out of that ticket's scope.
 */
/**
 * `employment_contracts` — W7's CRUD/import/export follow-up (owner ask,
 * 2026-08-27: "the contract for employee need to be able to be made, signed
 * by all, and will be linked to each employee. (need crud), import and
 * export"). Natural key: `contract_number` ('KONTRAK/YYYYMM/nnnn') — the same
 * document number `ContractsService.nextContractNumber` mints, so this sheet
 * can genuinely round-trip an export back in as an update rather than minting
 * duplicates. `employee` resolves against `employees.employee_number`
 * (matching `assets.assigned_to`'s FK) and `location` against
 * `locations.code` (matching every other location column in this file) —
 * both fail the row with its line+column when unresolvable, never guessed.
 *
 * SIGNATURES ARE NOT IMPORTABLE HERE — DELIBERATELY, and this is worth being
 * blunt about. A CSV column that could mark a contract "signed by the
 * employee" or "signed by the company" would let anyone who can write a
 * spreadsheet cell manufacture the exact fact — who signed, when — that
 * migration 252's `contract_signatures` table and its activation trigger
 * exist to make trustworthy. That is a forged signature, not a bulk edit.
 * `POST /hr/contracts/:id/sign` (`hr.contract.manage` only) is the ONLY path
 * that may ever create a `contract_signatures` row, and this importer does
 * not call it. A consequence worth stating: because 252's trigger refuses
 * `status = 'active'` on a contract with no recorded signatures, and this
 * importer only ever calls `ContractsService.create`/`update` (never `sign`),
 * an imported row that requests `status: active` will be rejected by that
 * trigger exactly like a hand-typed one would — this importer inherits the
 * same guarantee, it does not work around it.
 */
export type ImportEntityName =
  | 'item_categories'
  | 'items'
  | 'products'
  | 'chart_of_accounts'
  | 'employees'
  | 'work_shifts'
  | 'assets'
  | 'salary_components'
  | 'suppliers'
  | 'employment_contracts';

export interface ImportEntityDef {
  name: ImportEntityName;
  table: string;
  naturalKey: string;
  /** `@mimi/shared` `PermissionKey` — kept as `string` here to avoid a runtime import just for a type. */
  permission: string;
  columns: ColumnDef[];
  /**
   * Columns whose COMBINED value must be unique within one file — defaults to
   * `[naturalKey]` when omitted (every entity before `work_shifts`). Exists
   * for `work_shifts`, whose real natural key is (name, location): two
   * different outlets are allowed to each have a shift named "Pagi" in the
   * same sheet without the generic single-column dedupe in `validate()`
   * below mistaking them for the same row twice.
   */
  dedupeColumns?: readonly string[];
}

const STORAGE_TYPES = ['frozen', 'chilled', 'dry'] as const;
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const NORMAL_BALANCES = ['debit', 'credit'] as const;
const ASSET_CATEGORIES = [
  'machine',
  'vehicle',
  'equipment',
  'electronics',
  'furniture',
  'other',
] as const;
// `CreateComponentDto`/`UpdateComponentDto` (`modules/payroll/dto/payroll.dto.ts`) only ever accept
// 'earning'/'deduction' — 'employer_cost' is a real `salary_components.type` value (BPJS employer
// shares, Amendment 1) but nothing in the payroll module's own DTOs lets it be CREATED that way, so
// it is deliberately not offered here either: this importer can never do something the hand-typed
// screen cannot.
const COMPONENT_TYPES = ['earning', 'deduction'] as const;
const CALC_METHODS = ['fixed', 'per_day', 'per_hour', 'formula', 'manual'] as const;
const CONTRACT_TYPES = ['pkwt', 'pkwtt', 'probation', 'internship'] as const;

/**
 * Entities in DEPENDENCY ORDER — `item_categories` before `items` (an item
 * may reference one), `products` after both, matching `database/import-schema.ts`'s
 * own ordering; then the five master/reference entities added 2026-08-27:
 * `chart_of_accounts` (self-referential via `parent_code`, so a parent row
 * must appear before its children in the SAME file — no other entity here
 * depends on it), `employees` before `work_shifts`/`assets` (both can
 * reference an employee: a shift roster names nobody, but `assets.assigned_to`
 * does), `work_shifts`, `assets`, `salary_components` (standalone).
 * `units`/`locations`/`recipes` are intentionally NOT here: `units` because
 * `UnitService` (the real domain service this module delegates every write
 * to, per this file's header comment) exposes no update method — only
 * `createUnit` — so an upsert-on-natural-key import could never update an
 * existing unit's name, unlike every other entity here; `recipes` and
 * `locations` are out of THIS ticket's scope. `suppliers` is excluded for a
 * different reason — see the `ImportEntityName` doc comment above.
 */
export const IMPORT_ENTITIES: readonly ImportEntityDef[] = [
  {
    name: 'item_categories',
    table: 'item_categories',
    naturalKey: 'name',
    permission: 'item.manage',
    columns: [
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "Ayam"' },
      {
        name: 'sort_order',
        kind: 'int',
        hint: 'opsional · angka bulat, urutan tampil · contoh: "10"',
      },
    ],
  },
  {
    name: 'items',
    table: 'items',
    naturalKey: 'sku',
    permission: 'item.manage',
    columns: [
      {
        name: 'sku',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode unik · contoh: "BPP01"',
      },
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "Dada Ayam"' },
      {
        name: 'category',
        kind: 'text',
        hint: 'opsional · nama kategori item yang SUDAH ADA (buat dulu di Master Data > Kategori Item) · contoh: "Ayam"',
        fk: { table: 'item_categories', column: 'name', label: 'kategori item' },
      },
      {
        name: 'base_unit',
        kind: 'text',
        required: true,
        hint: 'wajib · kode satuan yang SUDAH ADA (Master Data > Satuan) · contoh: "kg"',
        fk: { table: 'units', column: 'code', label: 'satuan' },
      },
      {
        name: 'storage_type',
        kind: 'enum',
        values: STORAGE_TYPES,
        required: true,
        hint: `wajib · salah satu dari: ${STORAGE_TYPES.join(' | ')} · contoh: "frozen"`,
      },
      {
        name: 'is_sellable',
        kind: 'boolean',
        hint: 'opsional · ya/tidak (boleh juga yes/no/y/n/1/0) · contoh: "tidak"',
      },
      {
        name: 'shelf_life_days',
        kind: 'int',
        hint: 'opsional · angka bulat, umur simpan dalam hari · contoh: "7"',
      },
      { name: 'barcode', kind: 'text', hint: 'opsional · teks · contoh: "8991234567890"' },
    ],
  },
  {
    name: 'products',
    table: 'products',
    naturalKey: 'code',
    permission: 'product.manage',
    columns: [
      {
        name: 'code',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode unik · contoh: "PRD01"',
      },
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "Ayam Geprek"' },
      {
        name: 'category',
        kind: 'text',
        required: true,
        hint: 'wajib · nama kategori menu yang SUDAH ADA (buat dulu di Master Data > Kategori Menu POS) · contoh: "Ayam"',
        fk: { table: 'product_categories', column: 'name', label: 'kategori menu' },
      },
      {
        name: 'price',
        kind: 'decimal',
        scale: 2,
        required: true,
        hint: 'wajib · angka desimal (harga dalam Rupiah), titik atau koma keduanya boleh · contoh: "18500"',
      },
      {
        name: 'sort_order',
        kind: 'int',
        hint: 'opsional · angka bulat, urutan tampil di kasir · contoh: "10"',
      },
    ],
  },
  {
    name: 'chart_of_accounts',
    table: 'chart_of_accounts',
    naturalKey: 'code',
    permission: 'accounting.coa.manage',
    columns: [
      {
        name: 'code',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode akun unik · contoh: "1101"',
      },
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "Kas Outlet"' },
      {
        name: 'type',
        kind: 'enum',
        values: ACCOUNT_TYPES,
        required: true,
        hint: `wajib · salah satu dari: ${ACCOUNT_TYPES.join(' | ')} · TIDAK BISA diubah lagi setelah akun dibuat · contoh: "asset"`,
      },
      {
        name: 'normal_balance',
        kind: 'enum',
        values: NORMAL_BALANCES,
        required: true,
        hint: `wajib · salah satu dari: ${NORMAL_BALANCES.join(' | ')} · TIDAK BISA diubah lagi setelah akun dibuat · contoh: "debit"`,
      },
      {
        name: 'parent_code',
        kind: 'text',
        hint: 'opsional · kode akun induk yang SUDAH ADA (untuk akun sub-kategori) — jika diisi, urutkan baris induk lebih dulu di berkas ini · contoh: "1100"',
        fk: { table: 'chart_of_accounts', column: 'code', label: 'akun induk' },
      },
      {
        name: 'is_postable',
        kind: 'boolean',
        hint: 'opsional · ya/tidak — akun header/grup (tempat akun lain bernaung) diisi "tidak"; default "ya" · TIDAK BISA diubah lagi setelah akun dibuat · contoh: "ya"',
      },
    ],
  },
  {
    name: 'employees',
    table: 'employees',
    naturalKey: 'employee_number',
    permission: 'hr.employee.manage',
    columns: [
      {
        name: 'employee_number',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode unik karyawan · contoh: "EMP001"',
      },
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "Budi Santoso"' },
      {
        name: 'position',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, jabatan · contoh: "Kasir"',
      },
      {
        name: 'location',
        kind: 'text',
        required: true,
        hint: 'wajib · kode lokasi yang SUDAH ADA · contoh: "GDG"',
        fk: { table: 'locations', column: 'code', label: 'lokasi' },
      },
      {
        name: 'join_date',
        kind: 'date',
        required: true,
        hint: 'wajib · tanggal gabung, format YYYY-MM-DD · TIDAK BISA diubah lagi setelah karyawan dibuat · contoh: "2026-01-15"',
      },
      {
        name: 'base_salary',
        kind: 'decimal',
        scale: 2,
        required: true,
        hint: 'wajib · angka desimal (gaji pokok bulanan dalam Rupiah) · perubahan tercatat sebagai riwayat jabatan baru · contoh: "3500000"',
      },
      {
        name: 'nik',
        kind: 'text',
        hint: 'opsional · NIK KTP · contoh: "6371011501900001"',
      },
      { name: 'phone', kind: 'text', hint: 'opsional · teks · contoh: "081234567890"' },
      { name: 'email', kind: 'text', hint: 'opsional · teks · contoh: "budi@mimichicken.id"' },
    ],
  },
  {
    name: 'work_shifts',
    table: 'work_shifts',
    naturalKey: 'name',
    dedupeColumns: ['name', 'location'],
    permission: 'hr.shift.manage',
    columns: [
      {
        name: 'name',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, nama shift · contoh: "Pagi"',
      },
      {
        name: 'location',
        kind: 'text',
        hint: 'opsional · kode lokasi yang SUDAH ADA — kosongkan agar shift berlaku di SEMUA lokasi · contoh: "GDG"',
        fk: { table: 'locations', column: 'code', label: 'lokasi' },
      },
      {
        name: 'start_time',
        kind: 'time',
        required: true,
        hint: 'wajib · jam mulai, format HH:mm (24 jam) · contoh: "07:00"',
      },
      {
        name: 'end_time',
        kind: 'time',
        required: true,
        hint: 'wajib · jam selesai, format HH:mm (24 jam), boleh melewati tengah malam · contoh: "15:00"',
      },
      {
        name: 'break_minutes',
        kind: 'int',
        hint: 'opsional · angka bulat, menit istirahat · default 0 · contoh: "60"',
      },
    ],
  },
  {
    name: 'assets',
    table: 'assets',
    naturalKey: 'asset_number',
    permission: 'asset.manage',
    columns: [
      {
        name: 'asset_number',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode/nomor aset unik · contoh: "AST-001"',
      },
      {
        name: 'name',
        kind: 'text',
        required: true,
        hint: 'wajib · teks · contoh: "Freezer Box 200L"',
      },
      {
        name: 'category',
        kind: 'enum',
        values: ASSET_CATEGORIES,
        required: true,
        hint: `wajib · salah satu dari: ${ASSET_CATEGORIES.join(' | ')} · contoh: "equipment"`,
      },
      {
        name: 'location',
        kind: 'text',
        required: true,
        hint: 'wajib · kode lokasi yang SUDAH ADA · contoh: "GDG"',
        fk: { table: 'locations', column: 'code', label: 'lokasi' },
      },
      {
        name: 'serial_number',
        kind: 'text',
        hint: 'opsional · teks · contoh: "SN-2024-0012"',
      },
      { name: 'brand', kind: 'text', hint: 'opsional · teks · contoh: "Modena"' },
      { name: 'model', kind: 'text', hint: 'opsional · teks · contoh: "MD-200"' },
      {
        name: 'purchase_date',
        kind: 'date',
        hint: 'opsional · tanggal beli, format YYYY-MM-DD · contoh: "2025-03-01"',
      },
      {
        name: 'purchase_price',
        kind: 'decimal',
        scale: 2,
        hint: 'opsional · angka desimal (harga beli dalam Rupiah) · contoh: "15000000"',
      },
      {
        name: 'assigned_to',
        kind: 'text',
        hint: 'opsional · kode karyawan (employee_number) yang SUDAH ADA, PIC aset ini · contoh: "EMP001"',
        fk: { table: 'employees', column: 'employee_number', label: 'karyawan' },
      },
    ],
  },
  {
    name: 'salary_components',
    table: 'salary_components',
    naturalKey: 'code',
    permission: 'payroll.component.manage',
    columns: [
      {
        name: 'code',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode unik komponen · contoh: "TUNJ_TRANSPORT"',
      },
      {
        name: 'name',
        kind: 'text',
        required: true,
        hint: 'wajib · teks · TIDAK BISA diubah untuk komponen bawaan sistem · contoh: "Tunjangan Transport"',
      },
      {
        name: 'type',
        kind: 'enum',
        values: COMPONENT_TYPES,
        required: true,
        hint: `wajib · salah satu dari: ${COMPONENT_TYPES.join(' | ')} · TIDAK BISA diubah lagi setelah komponen dibuat · contoh: "earning"`,
      },
      {
        name: 'calc_method',
        kind: 'enum',
        values: CALC_METHODS,
        required: true,
        hint: `wajib · salah satu dari: ${CALC_METHODS.join(' | ')} · TIDAK BISA diubah lagi setelah komponen dibuat · contoh: "fixed"`,
      },
      {
        name: 'default_amount',
        kind: 'decimal',
        scale: 2,
        hint: 'opsional · angka desimal (nominal default dalam Rupiah) · contoh: "150000"',
      },
    ],
  },
  {
    name: 'suppliers',
    table: 'suppliers',
    naturalKey: 'code',
    permission: 'supplier.manage',
    columns: [
      {
        name: 'code',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, kode unik supplier · contoh: "SUP-001"',
      },
      { name: 'name', kind: 'text', required: true, hint: 'wajib · teks · contoh: "PT Ayam Jaya"' },
      { name: 'contact_name', kind: 'text', hint: 'opsional · nama orang · contoh: "Budi"' },
      { name: 'phone', kind: 'text', hint: 'opsional · nomor telepon · contoh: "+62-812-3456789"' },
      { name: 'email', kind: 'text', hint: 'opsional · email · contoh: "sales@ayamjaya.co.id"' },
      { name: 'address', kind: 'text', hint: 'opsional · alamat · contoh: "Jl. Soekarno No. 1"' },
      {
        name: 'payment_terms_days',
        kind: 'int',
        hint: 'opsional · angka bulat, termin bayar dalam hari · contoh: "30"',
      },
      { name: 'bank_name', kind: 'text', hint: 'opsional · nama bank · contoh: "BCA"' },
      {
        name: 'bank_account',
        kind: 'text',
        hint: 'opsional · nomor rekening · contoh: "1234567890"',
      },
      {
        name: 'bank_account_name',
        kind: 'text',
        hint: 'opsional · nama pemilik rekening · contoh: "PT Ayam Jaya"',
      },
      {
        name: 'outlet_visible',
        kind: 'boolean',
        // D-20: this flag is what decides whether an OUTLET role can see the
        // supplier in its directory at all. Worth being explicit about in the
        // template, because the safe default is "no".
        hint: 'opsional · ya/tidak (boleh juga yes/no/y/n/1/0) — apakah supplier ini tampil di direktori outlet; default "tidak" · contoh: "tidak"',
      },
    ],
  },
  {
    name: 'employment_contracts',
    table: 'employment_contracts',
    naturalKey: 'contract_number',
    permission: 'hr.contract.manage',
    columns: [
      {
        name: 'contract_number',
        kind: 'text',
        required: true,
        hint: 'wajib · nomor kontrak. Jika COCOK dengan kontrak yang sudah ada, baris ini MEMPERBARUI kontrak tersebut. Jika tidak ditemukan, sebuah kontrak BARU dibuat dan diberi nomor resmi otomatis oleh sistem (nomor di kolom ini hanya dipakai untuk mencocokkan, bukan untuk menetapkan nomor kontrak baru) · contoh: "KONTRAK/202601/0001"',
      },
      {
        name: 'employee',
        kind: 'text',
        required: true,
        hint: 'wajib · kode karyawan (employee_number) yang SUDAH ADA · contoh: "EMP001"',
        fk: { table: 'employees', column: 'employee_number', label: 'karyawan' },
      },
      {
        name: 'contract_type',
        kind: 'enum',
        values: CONTRACT_TYPES,
        required: true,
        hint: `wajib · salah satu dari: ${CONTRACT_TYPES.join(' | ')} · contoh: "pkwt"`,
      },
      {
        name: 'position',
        kind: 'text',
        required: true,
        hint: 'wajib · teks, jabatan sesuai kontrak · contoh: "Kasir"',
      },
      {
        name: 'location',
        kind: 'text',
        hint: 'opsional · kode lokasi yang SUDAH ADA — kosongkan untuk penempatan seluruh perusahaan · contoh: "GDG"',
        fk: { table: 'locations', column: 'code', label: 'lokasi' },
      },
      {
        name: 'base_salary',
        kind: 'decimal',
        scale: 2,
        hint: 'opsional · angka desimal (gaji pokok yang DISEPAKATI di kontrak ini, dalam Rupiah) · contoh: "3500000"',
      },
      {
        name: 'start_date',
        kind: 'date',
        required: true,
        hint: 'wajib · tanggal mulai, format YYYY-MM-DD · contoh: "2026-01-01"',
      },
      {
        name: 'end_date',
        kind: 'date',
        hint: 'wajib untuk pkwt/probation/internship, KOSONGKAN untuk pkwtt (permanen) · format YYYY-MM-DD · contoh: "2026-12-31"',
      },
      {
        name: 'signed_at',
        kind: 'date',
        hint: 'opsional · tanggal dokumen fisik ditandatangani (BUKAN status tanda tangan per pihak — lihat catatan di bawah) · format YYYY-MM-DD · contoh: "2026-01-01"',
      },
      { name: 'notes', kind: 'text', hint: 'opsional · teks catatan bebas' },
    ],
  },
];

// NOTE (read before touching `employment_contracts` above): there is
// deliberately NO `status` column and no way to import a signature. Every
// imported contract is created as `draft` (`ContractsService.create`'s own
// default, migration 252) and an update never touches `status` — activation
// only ever happens through `POST /hr/contracts/:id/sign` (both required
// parties) followed by an explicit `PATCH .../:id` to `active`, both gated
// on `hr.contract.manage` through the real screen. See the `ImportEntityName`
// doc comment above for the full reasoning: a CSV column that could assert a
// contract was signed would be indistinguishable from a forged signature,
// which is the exact failure mode migration 252 was built to prevent.

export function entityDef(name: ImportEntityName): ImportEntityDef {
  const found = IMPORT_ENTITIES.find((e) => e.name === name);
  if (!found) throw new Error(`no import entity "${name}"`);
  return found;
}

export interface RowError {
  line: number;
  column?: string;
  message: string;
}

export interface ValidatedRow {
  line: number;
  values: Record<string, string | null>;
}

export interface ValidationResult {
  /** `false` means the HEADER itself is wrong (unknown/missing column) — `errors` describes that and `rows` is always empty. */
  headerOk: boolean;
  rows: ValidatedRow[];
  errors: RowError[];
}

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1', 'ya']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0', 'tidak']);
/** Same pattern `shift.dto.ts`'s `HHMM` validates `CreateShiftDto.startTime`/`endTime` against — kept in sync manually since this file cannot import backend DTOs (see this file's header comment on why it is a standalone copy). */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `YYYY-MM-DD`, and a REAL calendar date — rejects "2026-02-30" the way a plain regex would not. */
function isValidCalendarDate(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Checks a parsed (and guidance-row-stripped) file against an entity
 * definition. Ported from `database/import-schema.ts`'s `validate()` with
 * Indonesian messages and the explicit `headerOk` flag — see this file's
 * header comment for why both diverge from the original.
 */
export function validate(entity: ImportEntityDef, csv: ParsedCsv): ValidationResult {
  const errors: RowError[] = [];
  const rows: ValidatedRow[] = [];

  const known = new Set(entity.columns.map((c) => c.name));
  for (const column of csv.header) {
    if (!known.has(column)) {
      errors.push({
        line: 1,
        column,
        // Named, not ignored: a misspelled header would otherwise silently
        // drop the whole column and look like missing source data.
        message: `Kolom tidak dikenal "${column}" — kolom yang diharapkan: ${entity.columns
          .map((c) => c.name)
          .join(', ')}`,
      });
    }
  }
  for (const column of entity.columns) {
    if (column.required && !csv.header.includes(column.name)) {
      errors.push({
        line: 1,
        column: column.name,
        message: `Kolom wajib "${column.name}" tidak ditemukan di header`,
      });
    }
  }
  if (errors.length > 0) return { headerOk: false, rows, errors };

  const index = new Map(csv.header.map((h, i) => [h, i]));
  const seen = new Map<string, number>();

  for (const row of csv.rows) {
    if (row.values.length !== csv.header.length) {
      errors.push({
        line: row.line,
        message: `Baris ini punya ${row.values.length} kolom, seharusnya ${csv.header.length} — kemungkinan ada koma tambahan atau tanda kutip yang tidak ditutup`,
      });
      continue;
    }

    const values: Record<string, string | null> = {};
    let rowOk = true;

    for (const column of entity.columns) {
      const raw = index.has(column.name) ? (row.values[index.get(column.name)!] ?? '').trim() : '';
      if (raw === '') {
        if (column.required) {
          errors.push({
            line: row.line,
            column: column.name,
            message: `"${column.name}" wajib diisi`,
          });
          rowOk = false;
        }
        values[column.name] = null;
        continue;
      }

      switch (column.kind) {
        case 'int': {
          if (!/^-?\d+$/.test(raw)) {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" bukan angka bulat`,
            });
            rowOk = false;
            continue;
          }
          values[column.name] = raw;
          break;
        }
        case 'decimal': {
          // Accepts 1.5 and 1,5 — an Indonesian spreadsheet writes the comma.
          const normalized = raw.replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" bukan angka`,
            });
            rowOk = false;
            continue;
          }
          // Money/qty travel as fixed-scale decimal STRINGS (CONTRACTS §0), never floats.
          values[column.name] = Number(normalized).toFixed(column.scale ?? 2);
          break;
        }
        case 'boolean': {
          const lowered = raw.toLowerCase();
          if (BOOL_TRUE.has(lowered)) values[column.name] = 'true';
          else if (BOOL_FALSE.has(lowered)) values[column.name] = 'false';
          else {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" harus ya/tidak`,
            });
            rowOk = false;
          }
          break;
        }
        case 'enum': {
          const lowered = raw.toLowerCase();
          if (!column.values!.includes(lowered)) {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" harus salah satu dari: ${column.values!.join(', ')}`,
            });
            rowOk = false;
            continue;
          }
          values[column.name] = lowered;
          break;
        }
        case 'date': {
          if (!isValidCalendarDate(raw)) {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" harus tanggal valid format YYYY-MM-DD`,
            });
            rowOk = false;
            continue;
          }
          values[column.name] = raw;
          break;
        }
        case 'time': {
          if (!HHMM.test(raw)) {
            errors.push({
              line: row.line,
              column: column.name,
              message: `"${raw}" harus format jam HH:mm (24 jam)`,
            });
            rowOk = false;
            continue;
          }
          values[column.name] = raw;
          break;
        }
        default:
          values[column.name] = raw;
      }
    }

    if (!rowOk) continue;

    // Duplicate keys inside one file — which of the two should win is not
    // something an importer may guess. Normally the natural key alone; see
    // `ImportEntityDef.dedupeColumns`'s doc comment for the one entity
    // (`work_shifts`) whose real natural key is more than one column.
    const dedupeColumns = entity.dedupeColumns ?? [entity.naturalKey];
    const key = dedupeColumns.map((c) => (values[c] ?? '').toLowerCase()).join('|');
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push({
        line: row.line,
        column: entity.naturalKey,
        message: `"${values[entity.naturalKey]}" sudah muncul di baris ${previous}`,
      });
      continue;
    }
    seen.set(key, row.line);

    rows.push({ line: row.line, values });
  }

  return { headerOk: true, rows, errors };
}

/**
 * `GET .../template` body. Header row from the schema; ONE guidance row
 * (every cell prefixed `#`) instead of a separate example-data row.
 *
 * WHY ONE ROW, NOT TWO: the brief asks for header + example from the schema,
 * plus guidance (required/format) in "a second commented/aux row or a
 * companion sheet". A real-looking example row is the one most likely to
 * survive un-deleted into a real import — "BPP01 / Dada Ayam / kg / frozen"
 * reads exactly like a row someone meant to keep, and CSV has no actual
 * comment syntax to mark it inert. Folding the example INTO the guidance row
 * (every cell starts with `#…`) makes it impossible to mistake for real data
 * while still showing a concrete value per column, and `stripGuidanceRows()`
 * (used by both `preview` and `commit`) drops any row shaped like this
 * automatically — so a user who never deletes it gets a normal import, not a
 * cryptic validation error on "row 2".
 */
export function buildTemplate(entity: ImportEntityDef): string {
  const header = entity.columns.map((c) => c.name);
  const guidance = entity.columns.map((c) => `#${c.hint}`);
  return toCsv([header, guidance]);
}
