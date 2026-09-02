/**
 * CSV → document lines for the Outlet tabs, as pure mappers for
 * `components/common/LineImportButton`.
 *
 * WHAT THESE DO AND DELIBERATELY DO NOT DO. Nothing here writes anything. Each
 * mapper turns one CSV row into one line of the create form the operator is
 * already looking at, resolving SKUs and area names to ids and rejecting what
 * it cannot resolve. The document is then submitted by the same button, through
 * the same endpoint, with the same server validation, the same approval chain
 * and the same mandatory photo evidence as a hand-typed one. That is the whole
 * reason import is offered on transactional tabs at all: a waste record still
 * needs its photos, a petty-cash claim still needs payment proof and a goods
 * photo, and an opname still goes through submit → variance → approval. A CSV
 * that could skip those would be a fraud channel, not a convenience.
 *
 * TWO TABS TAKE NO IMPORT, on purpose:
 *   - `Stok` is a DERIVED balance. Stock moves only through a documented
 *     movement (receiving, opname, waste, return, sale), each of which posts a
 *     ledger entry. Letting a CSV set a balance directly would put stock on
 *     hand out of step with the movements that are supposed to explain it, and
 *     leave nothing to audit against. Export only.
 *   - `Terima Barang` is a signed handover of one physical delivery, per drop,
 *     with a receiver signature and photos. There is no bulk version of that
 *     act. Export only.
 *
 * IDS ARE RESOLVED FROM WHAT THE SCREEN ALREADY LOADED (`items`, `areas`, the
 * open count sheet), never fetched per row: the lists are small, already in
 * memory, and already permission-filtered by the server that sent them. A row
 * naming something outside them is an error the operator must see, not a
 * lookup to widen.
 *
 * AMBIGUITY IS AN ERROR, NOT A GUESS. Two items sharing a name is a real state
 * of the catalogue ("Ayam Potong" in two brands). Picking the first match would
 * write off, or order, the wrong one — and the operator would have no way to
 * tell from the screen that a choice was even made.
 */
import type { LineImportColumn, LineImportRowResult } from '@/components/common/LineImportButton';
import { parseDecimal, type CsvRecord } from '@/lib/import/csv-parse';
import type { Item, StorageArea } from './types';
import type { OpnameSheetRow } from './opname-sheet';
import type { Qty, Money } from '@/lib/shared-types';

/**
 * These four lists restate the option sets the panels declare as local
 * literals (`WASTE_REASONS`, `EXPENSE_CATEGORIES`, `ReturnCondition`). They are
 * duplicated rather than imported because the panels keep them private, and a
 * CSV needs to VALIDATE against them, not just render them — an unrecognised
 * `alasan` has to become a row error naming the accepted values, which is the
 * one place the operator finds out what to type.
 */
const WASTE_REASONS = ['expired', 'damaged', 'spoiled', 'prep_error', 'other'];
const RETURN_CONDITIONS = ['damaged', 'expired', 'wrong_item', 'quality', 'other'];
const EXPENSE_CATEGORIES = ['bahan_baku', 'kebersihan', 'operasional_lain'];

/**
 * Joins area + item name into one index key. A NON-PRINTING separator, not a
 * space: with a space, area "Freezer 1" + item "Ayam" and area "Freezer" +
 * item "1 Ayam" build the SAME key, and a count would be filed against the
 * wrong line. No storage-area name or item name can contain this character.
 */
const AREA_ITEM_SEP = '\u001f';

function fold(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A resolver that answers "which one", or says why it cannot. */
type Resolution<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Build a fold-keyed index where a key claimed by two different entities is
 * marked ambiguous rather than resolving to whichever was seen first.
 */
function buildIndex<T>(entries: { key: string; value: T }[]): Map<string, T | 'ambiguous'> {
  const index = new Map<string, T | 'ambiguous'>();
  for (const { key, value } of entries) {
    if (key === '') continue;
    const folded = fold(key);
    index.set(folded, index.has(folded) ? 'ambiguous' : value);
  }
  return index;
}

export interface ItemResolver {
  /** By SKU first, then by name. */
  resolve(skuText: string, nameText: string): Resolution<Item>;
}

/**
 * SKU WINS OVER NAME when a row carries both, and a disagreement between them
 * is an ERROR rather than a silent preference. A file where column A says
 * `AYM-001` and column B says "Sayur Bayam" is a file whose columns have been
 * shifted or sorted independently — the single most destructive spreadsheet
 * accident there is, and one that silently importing the SKU would hide.
 */
export function makeItemResolver(items: Item[]): ItemResolver {
  const bySku = buildIndex(items.map((i) => ({ key: i.sku, value: i })));
  const byName = buildIndex(items.map((i) => ({ key: i.name, value: i })));

  return {
    resolve(skuText, nameText) {
      const sku = skuText.trim();
      const name = nameText.trim();
      if (sku === '' && name === '') return { ok: false, error: 'Kolom sku/nama barang kosong' };

      let bySkuHit: Item | undefined;
      if (sku !== '') {
        const hit = bySku.get(fold(sku));
        if (hit === undefined) return { ok: false, error: `SKU tidak dikenal: ${sku}` };
        if (hit === 'ambiguous') return { ok: false, error: `SKU ganda di katalog: ${sku}` };
        bySkuHit = hit;
      }

      let byNameHit: Item | undefined;
      if (name !== '') {
        const hit = byName.get(fold(name));
        if (hit === undefined && sku === '')
          return { ok: false, error: `Nama barang tidak dikenal: ${name}` };
        if (hit === 'ambiguous' && sku === '')
          return {
            ok: false,
            error: `Nama barang ada lebih dari satu: ${name} — pakai kolom sku`,
          };
        if (hit !== undefined && hit !== 'ambiguous') byNameHit = hit;
      }

      if (bySkuHit && byNameHit && bySkuHit.id !== byNameHit.id) {
        return {
          ok: false,
          error: `SKU ${sku} adalah "${bySkuHit.name}", bukan "${name}" — kolom mungkin tergeser`,
        };
      }
      const resolved = bySkuHit ?? byNameHit;
      return resolved ? { ok: true, value: resolved } : { ok: false, error: `Baris tidak cocok` };
    },
  };
}

export interface AreaResolver {
  resolve(text: string): Resolution<StorageArea>;
}

/** Storage areas resolve by CODE or NAME — a count sheet is labelled either way. */
export function makeAreaResolver(areas: StorageArea[]): AreaResolver {
  const index = buildIndex([
    ...areas.map((a) => ({ key: a.code, value: a })),
    ...areas.map((a) => ({ key: a.name, value: a })),
  ]);
  return {
    resolve(text) {
      const key = text.trim();
      if (key === '') return { ok: false, error: 'Kolom area simpan kosong' };
      const hit = index.get(fold(key));
      if (hit === undefined) return { ok: false, error: `Area simpan tidak dikenal: ${key}` };
      if (hit === 'ambiguous') return { ok: false, error: `Area simpan ganda: ${key}` };
      return { ok: true, value: hit };
    },
  };
}

/** A quantity cell that must be present and strictly positive. */
function positiveQty(text: string, label: string): Resolution<Qty> {
  const raw = text.trim();
  if (raw === '') return { ok: false, error: `${label} kosong` };
  const parsed = parseDecimal(raw);
  if (parsed === null) return { ok: false, error: `${label} bukan angka: ${raw}` };
  // `> 0`, not `>= 0`: a zero line adds nothing to a request, a waste record or
  // a return, and a stray `0` is far more often an empty cell someone typed
  // into than a deliberate entry.
  if (/^-/.test(parsed) || /^0(\.0+)?$/.test(parsed))
    return { ok: false, error: `${label} harus lebih dari 0: ${raw}` };
  return { ok: true, value: parsed };
}

/**
 * A MONEY cell, which needs one rule quantity does not.
 *
 * `parseDecimal` reads a single dot as a decimal point, so `120.000` parses as
 * one hundred and twenty. For a QUANTITY that is right — `1.500` kg is a kilo
 * and a half, and stock is genuinely fractional. For RUPIAH it is a 1000×
 * understatement of a cash claim, and `120.000` is simply how an Indonesian
 * spreadsheet writes a hundred and twenty thousand. Rupiah has no subunit in
 * practice: nothing is ever priced in fractions of one.
 *
 * So for money only, a single dot followed by exactly three digits is read as
 * thousands grouping — the same rule `parseDecimal` already applies to a lone
 * comma (`1,500`), applied to the separator this locale actually uses. This
 * lives here rather than in `parseDecimal` because it is true of money and
 * false of quantity, and that function cannot tell which it was handed.
 */
function positiveMoney(text: string, label: string): Resolution<Money> {
  const raw = text.trim();
  const degrouped = /^-?\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  return positiveQty(degrouped, label);
}

/** One of a fixed option set, or an error that LISTS the options. */
function oneOf(
  text: string,
  options: string[],
  label: string,
  fallback?: string,
): Resolution<string> {
  const raw = fold(text);
  if (raw === '') {
    if (fallback !== undefined) return { ok: true, value: fallback };
    return { ok: false, error: `${label} kosong — pilih: ${options.join(', ')}` };
  }
  const hit = options.find((o) => fold(o) === raw);
  if (!hit)
    return {
      ok: false,
      error: `${label} tidak dikenal: ${text.trim()} — pilih: ${options.join(', ')}`,
    };
  return { ok: true, value: hit };
}

// ── Stock Opname: fill an OPEN count sheet ───────────────────────────────────

/**
 * The opname importer is the odd one out: it does NOT create lines. The server
 * generates the count sheet from system stock for the chosen area when the
 * session is started, and a count is an answer to those lines — so a CSV can
 * only FILL them. A row naming an item the sheet does not contain is reported,
 * never added, because adding it would mean counting stock the system does not
 * think is there without the variance that is supposed to flag exactly that.
 */
export interface OpnameCountFill {
  /**
   * KEYED BY ITEM, not by a saved line. A fresh count sheet has no lines at all
   * (a line exists only once a quantity is recorded), so a fill addressed to a
   * `lineId` could never reach an uncounted row — which was every row on a new
   * sheet. `PUT /stock-opname/:id/lines` is itemId-keyed for the same reason.
   */
  itemId: string;
  countedQty: Qty;
  varianceReason: string;
}

export const OPNAME_IMPORT_COLUMNS: LineImportColumn[] = [
  { header: 'nama_barang', hint: 'Ayam Utuh', required: true },
  { header: 'area_simpan', hint: 'Freezer 1' },
  { header: 'qty_hitung', hint: '12.5', required: true },
  { header: 'alasan_selisih', hint: 'rusak saat simpan' },
];

/**
 * Matching is by ITEM NAME (plus area when the sheet spans more than one),
 * because a sheet row carries no SKU on the wire — the count sheet the
 * operator exported shows the name, so that is what they will type back.
 */
export function makeOpnameCountMapper(lines: OpnameSheetRow[]) {
  const multiArea = new Set(lines.map((l) => l.storageAreaId)).size > 1;
  const byNameAndArea = buildIndex(
    lines.map((l) => ({ key: `${l.storageAreaName}${AREA_ITEM_SEP}${l.itemName}`, value: l })),
  );
  const byName = buildIndex(lines.map((l) => ({ key: l.itemName, value: l })));

  return function mapRow(row: CsvRecord): LineImportRowResult<OpnameCountFill> {
    const name = row.get('nama_barang').trim();
    const area = row.get('area_simpan').trim();
    if (name === '') return { ok: false, error: 'Kolom nama_barang kosong' };

    let line: OpnameSheetRow | 'ambiguous' | undefined;
    if (area !== '') {
      line = byNameAndArea.get(fold(`${area}${AREA_ITEM_SEP}${name}`));
      if (line === undefined)
        return { ok: false, error: `Tidak ada baris "${name}" di area "${area}" pada lembar ini` };
    } else {
      line = byName.get(fold(name));
      if (line === undefined)
        return { ok: false, error: `Tidak ada baris "${name}" pada lembar hitung ini` };
      // Only ask for the area when the sheet actually has more than one, so a
      // single-area count is not made fussier than it needs to be.
      if (line === 'ambiguous')
        return {
          ok: false,
          error: multiArea
            ? `"${name}" ada di lebih dari satu area — isi kolom area_simpan`
            : `"${name}" ada lebih dari satu kali di lembar ini`,
        };
    }
    if (line === 'ambiguous')
      return { ok: false, error: `"${name}" di area "${area}" ada lebih dari satu kali` };

    // A count of ZERO is meaningful here and must be accepted — "we have none
    // of this left" is the single most important thing a count can say, and it
    // is precisely the line with the largest variance. This is why the opname
    // mapper does not use `positiveQty`.
    const raw = row.get('qty_hitung').trim();
    if (raw === '') return { ok: false, error: `qty_hitung kosong untuk "${name}"` };
    const counted = parseDecimal(raw);
    if (counted === null) return { ok: false, error: `qty_hitung bukan angka: ${raw}` };
    if (counted.startsWith('-'))
      return { ok: false, error: `qty_hitung tidak boleh negatif: ${raw}` };

    return {
      ok: true,
      line: {
        itemId: line.itemId,
        countedQty: counted,
        varianceReason: row.get('alasan_selisih').trim(),
      },
    };
  };
}

// ── Minta Barang (replenishment) ─────────────────────────────────────────────

export interface ReplenishmentImportLine {
  itemId: string;
  qtyRequested: Qty;
}

export const REPLENISHMENT_IMPORT_COLUMNS: LineImportColumn[] = [
  { header: 'sku', hint: 'AYM-001' },
  { header: 'nama_barang', hint: 'Ayam Utuh' },
  { header: 'qty', hint: '10', required: true },
];

export function makeReplenishmentMapper(items: Item[]) {
  const resolver = makeItemResolver(items);
  return function mapRow(row: CsvRecord): LineImportRowResult<ReplenishmentImportLine> {
    const item = resolver.resolve(row.get('sku'), row.get('nama_barang'));
    if (!item.ok) return { ok: false, error: item.error };
    const qty = positiveQty(row.get('qty'), 'qty');
    if (!qty.ok) return { ok: false, error: qty.error };
    return { ok: true, line: { itemId: item.value.id, qtyRequested: qty.value } };
  };
}

// ── Waste ────────────────────────────────────────────────────────────────────

export interface WasteImportLine {
  storageAreaId: string;
  itemId: string;
  qty: Qty;
  reason: string;
  reasonDetail: string;
}

export const WASTE_IMPORT_COLUMNS: LineImportColumn[] = [
  { header: 'area_simpan', hint: 'Freezer 1', required: true },
  { header: 'sku', hint: 'AYM-001' },
  { header: 'nama_barang', hint: 'Ayam Utuh' },
  { header: 'qty', hint: '2.5', required: true },
  { header: 'alasan', hint: WASTE_REASONS.join(' / '), required: true },
  { header: 'detail_alasan', hint: 'freezer mati semalam' },
];

export function makeWasteMapper(items: Item[], areas: StorageArea[]) {
  const itemResolver = makeItemResolver(items);
  const areaResolver = makeAreaResolver(areas);
  return function mapRow(row: CsvRecord): LineImportRowResult<WasteImportLine> {
    const area = areaResolver.resolve(row.get('area_simpan'));
    if (!area.ok) return { ok: false, error: area.error };
    const item = itemResolver.resolve(row.get('sku'), row.get('nama_barang'));
    if (!item.ok) return { ok: false, error: item.error };
    const qty = positiveQty(row.get('qty'), 'qty');
    if (!qty.ok) return { ok: false, error: qty.error };
    // No default: writing stock off for an unstated reason is exactly what the
    // mandatory-reason rule exists to prevent.
    const reason = oneOf(row.get('alasan'), WASTE_REASONS, 'alasan');
    if (!reason.ok) return { ok: false, error: reason.error };
    return {
      ok: true,
      line: {
        storageAreaId: area.value.id,
        itemId: item.value.id,
        qty: qty.value,
        reason: reason.value,
        reasonDetail: row.get('detail_alasan').trim(),
      },
    };
  };
}

// ── Retur ────────────────────────────────────────────────────────────────────

export interface ReturnImportLine {
  itemId: string;
  storageAreaId: string;
  qty: Qty;
  condition: string;
  reason: string;
}

export const RETURN_IMPORT_COLUMNS: LineImportColumn[] = [
  { header: 'area_simpan', hint: 'Chiller 1', required: true },
  { header: 'sku', hint: 'AYM-001' },
  { header: 'nama_barang', hint: 'Ayam Utuh' },
  { header: 'qty', hint: '3', required: true },
  { header: 'kondisi', hint: RETURN_CONDITIONS.join(' / ') },
  { header: 'alasan', hint: 'kemasan bocor', required: true },
];

export function makeReturnMapper(items: Item[], areas: StorageArea[]) {
  const itemResolver = makeItemResolver(items);
  const areaResolver = makeAreaResolver(areas);
  return function mapRow(row: CsvRecord): LineImportRowResult<ReturnImportLine> {
    const area = areaResolver.resolve(row.get('area_simpan'));
    if (!area.ok) return { ok: false, error: area.error };
    const item = itemResolver.resolve(row.get('sku'), row.get('nama_barang'));
    if (!item.ok) return { ok: false, error: item.error };
    const qty = positiveQty(row.get('qty'), 'qty');
    if (!qty.ok) return { ok: false, error: qty.error };
    // `damaged` is the form's own default for a new line, so a blank column
    // behaves the same as clicking "add line" — not a new policy.
    const condition = oneOf(row.get('kondisi'), RETURN_CONDITIONS, 'kondisi', 'damaged');
    if (!condition.ok) return { ok: false, error: condition.error };
    const reason = row.get('alasan').trim();
    if (reason === '') return { ok: false, error: 'alasan kosong' };
    return {
      ok: true,
      line: {
        itemId: item.value.id,
        storageAreaId: area.value.id,
        qty: qty.value,
        condition: condition.value,
        reason,
      },
    };
  };
}

// ── Kas Kecil (petty cash) ───────────────────────────────────────────────────

export interface PettyCashImportLine {
  description: string;
  itemId: string;
  qty: Qty | null;
  amount: Money;
  expenseCategory: string;
}

export const PETTY_CASH_IMPORT_COLUMNS: LineImportColumn[] = [
  { header: 'keterangan', hint: 'Beli minyak goreng 2L', required: true },
  { header: 'kategori_biaya', hint: EXPENSE_CATEGORIES.join(' / ') },
  { header: 'jumlah', hint: '45000', required: true },
  { header: 'sku', hint: 'kosongkan jika bukan barang stok' },
  { header: 'nama_barang', hint: 'kosongkan jika bukan barang stok' },
  { header: 'qty', hint: 'kosongkan jika tanpa qty' },
];

/**
 * `keterangan` and `jumlah` are the required pair; the item link is OPTIONAL
 * because most petty cash is not a stock item at all (a parking fee, a plumber).
 * A claim line with no item is normal here, unlike on the waste and return
 * tabs where every line is by definition a movement of stock.
 */
export function makePettyCashMapper(items: Item[]) {
  const resolver = makeItemResolver(items);
  return function mapRow(row: CsvRecord): LineImportRowResult<PettyCashImportLine> {
    const description = row.get('keterangan').trim();
    if (description === '') return { ok: false, error: 'keterangan kosong' };

    const category = oneOf(
      row.get('kategori_biaya'),
      EXPENSE_CATEGORIES,
      'kategori_biaya',
      'bahan_baku',
    );
    if (!category.ok) return { ok: false, error: category.error };

    const amount = positiveMoney(row.get('jumlah'), 'jumlah');
    if (!amount.ok) return { ok: false, error: amount.error };

    const skuText = row.get('sku').trim();
    const nameText = row.get('nama_barang').trim();
    let itemId = '';
    if (skuText !== '' || nameText !== '') {
      const item = resolver.resolve(skuText, nameText);
      if (!item.ok) return { ok: false, error: item.error };
      itemId = item.value.id;
    }

    const qtyText = row.get('qty').trim();
    let qty: Qty | null = null;
    if (qtyText !== '') {
      const parsed = positiveQty(qtyText, 'qty');
      if (!parsed.ok) return { ok: false, error: parsed.error };
      qty = parsed.value;
    }

    return {
      ok: true,
      line: { description, itemId, qty, amount: amount.value, expenseCategory: category.value },
    };
  };
}
