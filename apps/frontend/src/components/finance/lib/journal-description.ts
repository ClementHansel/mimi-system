/**
 * Turns a journal entry's machine-written `description` into something a
 * non-accountant can read.
 *
 * The GL engine writes system entries as `"<eventType> — <refKind> <uuid>"`,
 * so the Jurnal table read like this:
 *
 *     outlet_ingredient_usage — usage_day c0b915b2-f4ee-550c-9500-d567cfa063d6
 *
 * Three problems in one string: an enum name instead of a sentence, English
 * where the rest of the UI is Indonesian, and a 36-character UUID that no
 * human will ever act on but which dominates the column. The owner's verdict
 * was simply "Keterangan is too confusing for normal user".
 *
 * This parses that shape and returns a label plus the technical remainder,
 * kept (never dropped) for the detail drawer and the cell's `title` — an
 * accountant chasing a specific `usage_day` row still needs the id, they just
 * should not have to read it to scan the ledger.
 *
 * Anything that does not match the machine shape — a manually posted entry's
 * free text — is passed through untouched, except for the engine's English
 * `"Reversal of JE/…: reason"` prefix, which gets the same treatment because
 * it is equally machine-written.
 */

/** Known event tokens → the i18n key suffix under `finance.journal.event`. */
const EVENT_TOKENS = new Set([
  // The PRD's 16 (`JournalEventType`)
  'gudang_purchase',
  'gudang_goods_in',
  'gudang_goods_out_to_outlet',
  'gudang_return_to_supplier',
  'gudang_waste',
  'gudang_stock_adjustment',
  'gudang_stock_revaluation',
  'outlet_goods_in_from_warehouse',
  'outlet_ingredient_usage',
  'outlet_sales',
  'outlet_waste',
  'outlet_return_to_warehouse',
  'outlet_stock_adjustment',
  'outlet_direct_purchase',
  'outlet_petty_cash',
  'outlet_operating_expense',
  // D-04 extensions (`JournalSystemEventType`)
  'payroll_accrual',
  'payroll_payment',
  'qris_settlement',
  'transfer_verified',
  'platform_settlement',
  'sale_void_reversal',
  'offline_auth_rejected',
  'petty_cash_topup',
]);

/** Known source-document tokens → `finance.journal.ref` key suffix. */
const REF_TOKENS = new Set([
  'usage_day',
  'sale_day',
  'po_receipt',
  'surat_jalan',
  'sj',
  'goods_receipt',
  'replenishment',
  'opname',
  'waste',
  'return',
  'petty_cash',
  'payroll_run',
  'payment_verification',
  'pos_sale',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JournalDescriptionParts {
  /** i18n key for the event, or `null` when the text is not machine-written. */
  eventKey: string | null;
  /** i18n key for the source-document kind, when the entry names one. */
  refKey: string | null;
  /** An unrecognized event/ref token, shown verbatim rather than swallowed. */
  rawToken: string | null;
  /** The referenced document's id, for the drawer — never the table cell. */
  refId: string | null;
  /** Free text to show as-is (manual entries, reversal reasons). */
  text: string | null;
  /** The original string, always kept for `title` and the detail drawer. */
  raw: string;
}

/**
 * Splits a description into its parts. Pure and i18n-free — the caller
 * translates, so this stays testable without a provider and adding a language
 * never touches this file.
 */
export function parseJournalDescription(raw: string): JournalDescriptionParts {
  const base: JournalDescriptionParts = {
    eventKey: null,
    refKey: null,
    rawToken: null,
    refId: null,
    text: null,
    raw,
  };

  // "Reversal of JE/202608/0079: dicatat dua kali"
  const reversal = /^Reversal of (\S+?):\s*(.*)$/i.exec(raw);
  if (reversal) {
    return {
      ...base,
      eventKey: 'reversal',
      refId: reversal[1] ?? null,
      text: reversal[2]?.trim() || null,
    };
  }

  // "<eventType> — <refKind> <uuid>" (em dash, as the engine writes it)
  const [head, tail] = raw.split(' — ', 2);
  const eventToken = head?.trim() ?? '';
  if (!EVENT_TOKENS.has(eventToken)) {
    // Not one of ours: a human wrote it. Show exactly what they wrote.
    return { ...base, text: raw };
  }

  const parts: JournalDescriptionParts = { ...base, eventKey: eventToken };
  if (!tail) return parts;

  const tokens = tail.trim().split(/\s+/);
  for (const token of tokens) {
    if (UUID_RE.test(token)) {
      parts.refId = token;
    } else if (REF_TOKENS.has(token)) {
      parts.refKey = token;
    } else if (token) {
      // Unknown token — surfaced, not hidden. A new ref kind should look
      // slightly raw in the UI, not vanish from the ledger.
      parts.rawToken = parts.rawToken ? `${parts.rawToken} ${token}` : token;
    }
  }
  return parts;
}
