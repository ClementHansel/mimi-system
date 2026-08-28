'use client';

import { resolveAttachmentUrl } from '@/lib/attachment-url';
import { translate } from '@/lib/i18n';
import type { DocCopySet, DocData, DocPayload } from '@/lib/shared-types';
import type { Translate } from './DocumentRenderer';

/**
 * `DocPayload` (wire) → `DocData` (renderable). THE one place that conversion
 * happens.
 *
 * `packages/shared/src/documents/payload.ts` explains why the two types exist
 * at all: the server may not hold Bahasa Indonesia copy (BUILD-PLAN §6.9), so
 * it splits what it knows into `fields` (values only it can know — an invoice
 * number, a formatted rupiah total) and `labelKeys` (tokens whose VALUE is
 * copy — `document_title`, `party_label`, `copy_holder_label`, an enum's
 * display name). This module does the three things that turns one into the
 * other:
 *
 *   1. resolves `labelKeys` through i18n and merges them OVER `fields`;
 *   2. turns `logoAttachmentId` / `backgroundAttachmentId` into presigned URLs;
 *   3. passes `brand` straight through, untouched.
 *
 * Concentrating it here — rather than letting each of the five print routes do
 * its own merge — is what makes "the label wins over the value" a single
 * decision. A route that got the precedence backwards would print the server's
 * placeholder value where a heading belongs, and it would do it on exactly one
 * of five documents, which is the kind of bug that ships.
 */

// `resolveAttachmentUrl` moved to `lib/attachment-url` when `lib/brand` grew
// a second caller for it (a `lib` module may not import from `components`).
// Re-exported here so the document layer still has one import for everything
// it needs to turn a payload into renderable data.
export { resolveAttachmentUrl, clearAttachmentUrlCache } from '@/lib/attachment-url';

// ── The merge ────────────────────────────────────────────────────────────────

/**
 * Namespace-drift shim, and it is deliberately loud in this comment rather
 * than silent in the code.
 *
 * The brief specified the printable-document i18n namespace as `docs.*`. That
 * path is taken by the USER MANUAL (`docs.title` is already a string), so the
 * frontend dictionary uses `doc.*` — see the long note above `doc:` in
 * `lib/i18n/id.ts`. The backend resolvers are being written in parallel
 * against the same brief, so a payload may arrive naming `docs.title.invoice`.
 *
 * Rather than print a raw key onto a customer's invoice, an unresolvable key
 * is retried once under the sibling prefix. If THAT fails too, we fall back to
 * whatever the server put in `fields` for the same token — the server always
 * sends a value there, and a slightly-wrong-looking label beats a document
 * with `docs.party_label` on it. The mismatch is reported to the console in
 * development so it gets fixed rather than lived with.
 */
function resolveLabelKey(
  t: Translate,
  key: string,
  rawFieldValue: string | undefined,
): string | undefined {
  const direct = t(key);
  if (direct !== key) return direct;

  const swapped = key.startsWith('docs.')
    ? `doc.${key.slice('docs.'.length)}`
    : key.startsWith('doc.')
      ? `docs.${key.slice('doc.'.length)}`
      : null;
  if (swapped) {
    const alternative = t(swapped);
    if (alternative !== swapped) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[doc-payload] labelKey "${key}" resolved only as "${swapped}" — the backend and lib/i18n/id.ts disagree on the document namespace.`,
        );
      }
      return alternative;
    }
  }

  // Neither prefix resolved. Keep the server's own value if it sent one;
  // otherwise drop the key entirely so `fields` is not polluted with it.
  return rawFieldValue;
}

/**
 * Build renderable `DocData` from one wire payload.
 *
 * `t` is injected rather than taken from `useI18n()` so this stays callable
 * from a plain async function (every print route loads its payload in an
 * effect, outside a hook context) and from a test with a stub dictionary.
 */
export async function docDataFromPayload(
  payload: DocPayload,
  t: Translate = translate,
): Promise<DocData> {
  const [logoUrl, backgroundUrl] = await Promise.all([
    resolveAttachmentUrl(payload.logoAttachmentId),
    resolveAttachmentUrl(payload.backgroundAttachmentId),
  ]);

  // `labelKeys` MERGES OVER `fields`, never under. That direction is the whole
  // contract: the server puts a machine-safe stand-in in `fields` for a token
  // whose real value is copy, and names the key it should be replaced with.
  const fields: Record<string, string> = { ...payload.fields };
  for (const [token, key] of Object.entries(payload.labelKeys)) {
    const resolved = resolveLabelKey(t, key, payload.fields[token]);
    if (resolved !== undefined) fields[token] = resolved;
  }

  return {
    fields,
    items: payload.items,
    // `DocPayloadTotalRow` and `DocTotalRow` are structurally identical today
    // (key/value/strong). They are copied field-by-field rather than passed by
    // reference so that the day the wire row grows a field, this is a compile
    // error here instead of an unnoticed pass-through.
    totals: payload.totals.map((row) => ({ key: row.key, value: row.value, strong: row.strong })),
    logoUrl,
    backgroundUrl,
    codes: payload.codes,
    brand: payload.brand,
  };
}

/**
 * The multi-sheet variant. Every copy is a COMPLETE payload (see `DocCopySet`
 * — a Surat Jalan copy that said "see sheet 1" would be worthless in a
 * dispute), so this is a plain map; the attachment cache above is what stops
 * that from becoming one presign per sheet.
 */
export async function docDataFromCopySet(
  copySet: DocCopySet,
  t: Translate = translate,
): Promise<DocData[]> {
  return Promise.all(copySet.copies.map((copy) => docDataFromPayload(copy, t)));
}

/**
 * The browser turns `document.title` into the suggested print-to-PDF filename,
 * and a document number may legitimately contain a slash (`SJ/2026/0001`).
 * `PrintFrame` already does this for the number it is handed; this is the same
 * rule for the copy-set/print-window paths that do not go through it.
 */
export function safeDocumentTitle(documentNumber: string): string {
  return documentNumber.replace(/[/\\]/g, '-');
}
