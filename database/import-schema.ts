/**
 * The pure half of the master-data importer: CSV parsing, per-entity column
 * definitions, and row validation. No database, no I/O — so it can be unit
 * tested directly, and so a bad file is rejected before a connection is opened.
 *
 * WHY THIS EXISTS. The box is a demo today and real Mimi Chicken data later
 * (owner, 2026-08-22: "demo now, prod later"). Getting from one to the other
 * means loading real outlets, items, units, categories and menu products —
 * hundreds of rows that live in somebody's spreadsheet. Typing them into the
 * Data Master screens is a day of work and a guaranteed typo; a one-off SQL
 * script is worse, because it is unreviewable and unrepeatable.
 *
 * THE RULES THAT SHAPED IT:
 *
 *  1. DRY RUN BY DEFAULT. `--commit` is opt-in. An import that silently wrote
 *     on first run would make "let me see what this file would do" impossible,
 *     and that is the question anyone sane asks first.
 *  2. VALIDATE THE WHOLE FILE, THEN DECIDE. Every error is collected with its
 *     line number rather than throwing on the first one: fixing a 300-row
 *     spreadsheet one error per run is not a workflow.
 *  3. NATURAL KEYS, NOT UUIDs. A spreadsheet has `BPP01`, not
 *     `9c38204e-…`. Every entity upserts on the key a human already uses, which
 *     is also what makes re-running an import safe.
 *  4. NO NEW DEPENDENCY. The CSV parser below is ~40 lines and handles quotes,
 *     embedded commas and CRLF. Adding a csv package to a database tool that
 *     runs twice a year is not worth the supply-chain surface.
 */

export interface ParsedCsv {
  header: string[];
  /** 1-based FILE line numbers, so an error message matches what the editor shows. */
  rows: { line: number; values: string[] }[];
}

/**
 * RFC4180-ish CSV: double quotes around fields, `""` for a literal quote,
 * commas and newlines allowed inside quotes, CRLF or LF line endings.
 *
 * Written by hand rather than pulled in, and deliberately strict about one
 * thing: a row whose column count differs from the header is an ERROR, not a
 * silent pad or truncate. A spreadsheet export with a stray comma is exactly
 * how a phone number ends up in the address column.
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

export type ColumnKind = 'text' | 'int' | 'decimal' | 'boolean' | 'enum';

export interface ColumnDef {
  name: string;
  kind: ColumnKind;
  required?: boolean;
  /** For `enum`. */
  values?: readonly string[];
  /** Decimal places for `decimal` — money is 2, quantity 3 (CONTRACTS §0). */
  scale?: number;
}

export interface EntityDef {
  /** What `--only` matches, and the CSV file's base name. */
  name: string;
  table: string;
  /** The human key an upsert matches on. */
  naturalKey: string;
  columns: ColumnDef[];
  /** Free-text note printed in `--help`, so the format is discoverable. */
  note: string;
}

const STORAGE_TYPES = ['frozen', 'chilled', 'dry'] as const;
const LOCATION_TYPES = ['warehouse', 'outlet'] as const;

/**
 * Entities in DEPENDENCY ORDER. The importer processes them in this sequence so
 * a single run can create a unit, then an item that references it, then a
 * product whose recipe consumes that item — which is what a real onboarding
 * spreadsheet looks like.
 */
export const ENTITIES: EntityDef[] = [
  {
    name: 'units',
    table: 'units',
    naturalKey: 'code',
    note: 'code,name — e.g. kg,Kilogram',
    columns: [
      { name: 'code', kind: 'text', required: true },
      { name: 'name', kind: 'text', required: true },
    ],
  },
  {
    name: 'item_categories',
    table: 'item_categories',
    // No `code` column on this table — the name IS the key.
    naturalKey: 'name',
    note: 'name,sort_order — sort_order optional',
    columns: [
      { name: 'name', kind: 'text', required: true },
      { name: 'sort_order', kind: 'int' },
    ],
  },
  {
    name: 'locations',
    table: 'locations',
    naturalKey: 'code',
    note: 'code,name,type,city,address,phone,latitude,longitude,geofence_radius_m — type: warehouse|outlet. Leave geofence_radius_m empty to inherit the system default (migration 229)',
    columns: [
      { name: 'code', kind: 'text', required: true },
      { name: 'name', kind: 'text', required: true },
      { name: 'type', kind: 'enum', values: LOCATION_TYPES, required: true },
      { name: 'city', kind: 'text', required: true },
      { name: 'address', kind: 'text' },
      { name: 'phone', kind: 'text' },
      { name: 'latitude', kind: 'decimal', scale: 6 },
      { name: 'longitude', kind: 'decimal', scale: 6 },
      { name: 'geofence_radius_m', kind: 'int' },
    ],
  },
  {
    name: 'items',
    table: 'items',
    naturalKey: 'sku',
    note: 'sku,name,category,base_unit,storage_type,is_sellable,shelf_life_days,barcode — category matches item_categories.name, base_unit matches units.code, storage_type: frozen|chilled|dry',
    columns: [
      { name: 'sku', kind: 'text', required: true },
      { name: 'name', kind: 'text', required: true },
      { name: 'category', kind: 'text' },
      { name: 'base_unit', kind: 'text', required: true },
      { name: 'storage_type', kind: 'enum', values: STORAGE_TYPES, required: true },
      { name: 'is_sellable', kind: 'boolean' },
      { name: 'shelf_life_days', kind: 'int' },
      { name: 'barcode', kind: 'text' },
    ],
  },
  {
    name: 'products',
    table: 'products',
    naturalKey: 'code',
    note: 'code,name,category,price,sort_order — category is the POS menu group by NAME (Ayam, Minuman, …); it must already exist under Master Data, price in rupiah',
    columns: [
      { name: 'code', kind: 'text', required: true },
      { name: 'name', kind: 'text', required: true },
      { name: 'category', kind: 'text', required: true },
      { name: 'price', kind: 'decimal', scale: 2, required: true },
      { name: 'sort_order', kind: 'int' },
    ],
  },
  {
    name: 'recipes',
    table: 'recipes',
    // Grouped by product: a recipe is REPLACED wholesale, so the key is the
    // product, not the line.
    naturalKey: 'product_code',
    note: 'product_code,item_sku,qty,unit,yield_qty — one row per ingredient; every row for a product REPLACES that product’s whole recipe. yield_qty is optional (defaults to 1) and only read from a product’s first row',
    columns: [
      { name: 'product_code', kind: 'text', required: true },
      { name: 'item_sku', kind: 'text', required: true },
      { name: 'qty', kind: 'decimal', scale: 3, required: true },
      { name: 'unit', kind: 'text', required: true },
      // The schema splits a recipe in two: `recipes` (one per product, carrying
      // the yield) and `recipe_lines` (the ingredients). A flat sheet cannot
      // express that hierarchy, so the yield rides on the ingredient rows and
      // the importer reads it once per product.
      { name: 'yield_qty', kind: 'decimal', scale: 3 },
    ],
  },
];

export interface RowError {
  entity: string;
  line: number;
  column?: string;
  message: string;
}

export interface ValidatedRow {
  line: number;
  values: Record<string, string | null>;
}

export interface ValidationResult {
  rows: ValidatedRow[];
  errors: RowError[];
}

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1', 'ya']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0', 'tidak']);

/**
 * Checks a parsed file against an entity definition.
 *
 * Returns BOTH the good rows and every error — the caller decides whether to
 * proceed. Collecting rather than throwing is rule 2 in the header: a
 * spreadsheet with fifteen problems should report fifteen problems.
 */
export function validate(entity: EntityDef, csv: ParsedCsv): ValidationResult {
  const errors: RowError[] = [];
  const rows: ValidatedRow[] = [];

  const known = new Set(entity.columns.map((c) => c.name));
  for (const column of csv.header) {
    if (!known.has(column)) {
      errors.push({
        entity: entity.name,
        line: 1,
        column,
        // Named, not ignored: a misspelled header ("lattitude") would otherwise
        // silently drop the whole column and look like missing data.
        message: `unknown column "${column}" — expected one of: ${entity.columns.map((c) => c.name).join(', ')}`,
      });
    }
  }
  for (const column of entity.columns) {
    if (column.required && !csv.header.includes(column.name)) {
      errors.push({
        entity: entity.name,
        line: 1,
        column: column.name,
        message: `required column "${column.name}" is missing`,
      });
    }
  }
  if (errors.length > 0) return { rows, errors };

  const index = new Map(csv.header.map((h, i) => [h, i]));
  const seen = new Map<string, number>();

  for (const row of csv.rows) {
    if (row.values.length !== csv.header.length) {
      errors.push({
        entity: entity.name,
        line: row.line,
        message: `has ${row.values.length} fields but the header has ${csv.header.length} — a stray comma or an unclosed quote`,
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
            entity: entity.name,
            line: row.line,
            column: column.name,
            message: `"${column.name}" is required`,
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
              entity: entity.name,
              line: row.line,
              column: column.name,
              message: `"${raw}" is not a whole number`,
            });
            rowOk = false;
            continue;
          }
          values[column.name] = raw;
          break;
        }
        case 'decimal': {
          // Accepts 1.5 and 1,5 — an Indonesian spreadsheet writes the comma,
          // and rejecting it would fail on correct data.
          const normalized = raw.replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
            errors.push({
              entity: entity.name,
              line: row.line,
              column: column.name,
              message: `"${raw}" is not a number`,
            });
            rowOk = false;
            continue;
          }
          // Money and quantity travel as fixed-scale decimal STRINGS
          // (CONTRACTS §0) — never as floats.
          values[column.name] = Number(normalized).toFixed(column.scale ?? 2);
          break;
        }
        case 'boolean': {
          const lowered = raw.toLowerCase();
          if (BOOL_TRUE.has(lowered)) values[column.name] = 'true';
          else if (BOOL_FALSE.has(lowered)) values[column.name] = 'false';
          else {
            errors.push({
              entity: entity.name,
              line: row.line,
              column: column.name,
              message: `"${raw}" is not yes/no`,
            });
            rowOk = false;
          }
          break;
        }
        case 'enum': {
          const lowered = raw.toLowerCase();
          if (!column.values!.includes(lowered)) {
            errors.push({
              entity: entity.name,
              line: row.line,
              column: column.name,
              message: `"${raw}" must be one of: ${column.values!.join(', ')}`,
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

    // Duplicate natural keys inside one file. `recipes` is exempt: many rows
    // per product is the format, not a mistake.
    if (entity.name !== 'recipes') {
      const key = (values[entity.naturalKey] ?? '').toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined) {
        errors.push({
          entity: entity.name,
          line: row.line,
          column: entity.naturalKey,
          message: `"${values[entity.naturalKey]}" already appears on line ${previous} — which of the two should win is not something an importer may guess`,
        });
        continue;
      }
      seen.set(key, row.line);
    }

    rows.push({ line: row.line, values });
  }

  return { rows, errors };
}
