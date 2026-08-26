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

export type ColumnKind = 'text' | 'int' | 'decimal' | 'boolean' | 'enum';

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
 */
export type ImportEntityName = 'item_categories' | 'items' | 'products';

export interface ImportEntityDef {
  name: ImportEntityName;
  table: string;
  naturalKey: string;
  /** `@mimi/shared` `PermissionKey` — kept as `string` here to avoid a runtime import just for a type. */
  permission: string;
  columns: ColumnDef[];
}

const STORAGE_TYPES = ['frozen', 'chilled', 'dry'] as const;

/**
 * Entities in DEPENDENCY ORDER — `item_categories` before `items` (an item
 * may reference one), and `products` last (it references a `product_categories`
 * row by name), matching `database/import-schema.ts`'s own ordering.
 * `units`/`locations`/`recipes` are intentionally NOT here: `units` because
 * `UnitService` (the real domain service this module delegates every write
 * to, per this file's header comment) exposes no update method — only
 * `createUnit` — so an upsert-on-natural-key import could never update an
 * existing unit's name, unlike every other entity here; `recipes` and
 * `locations` are out of THIS ticket's scope (three entities, chosen for
 * value/risk — see `import.module.ts`).
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
];

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
        default:
          values[column.name] = raw;
      }
    }

    if (!rowOk) continue;

    // Duplicate natural keys inside one file — which of the two should win is
    // not something an importer may guess.
    const key = (values[entity.naturalKey] ?? '').toLowerCase();
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
