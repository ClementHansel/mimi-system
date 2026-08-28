/**
 * Shared plumbing every kind's resolver uses — kept here rather than
 * duplicated four times.
 *
 * TOKEN COMPLETENESS, MECHANICALLY
 * ---------------------------------
 * Each resolver builds ONE object typed `Record<KindFieldToken, string>` —
 * so the TypeScript compiler refuses to build if a token is missing, per the
 * ticket's whole reason for exporting those closed unions (`catalog.ts`'s
 * header). For a label-valued token (`document_title`, `party_label`, an
 * enum's display name, ...) that object's value is not the display text —
 * the backend may not hold that — it is the i18n KEY the frontend resolves
 * (`'docs.title.invoice'`), by construction indistinguishable at the type
 * level from a plain data value (both are `string`). `splitFieldsAndLabels`
 * is what tells them apart at RUNTIME, by consulting the fixed set of
 * label-token names for that kind, and routes each into `DocPayload.fields`
 * or `.labelKeys` accordingly — the split the wire contract requires,
 * derived from the one already-typechecked object rather than assembled by
 * hand in two places that could drift apart.
 */
import type { DocKind } from '@mimi/shared';

export function splitFieldsAndLabels<Token extends string>(
  all: Record<Token, string>,
  labelTokens: readonly Token[],
): { fields: Record<string, string>; labelKeys: Record<string, string> } {
  const labelSet = new Set<string>(labelTokens);
  const fields: Record<string, string> = {};
  const labelKeys: Record<string, string> = {};
  for (const token of Object.keys(all) as Token[]) {
    const value = all[token];
    if (labelSet.has(token)) {
      labelKeys[token] = value;
    } else {
      fields[token] = value;
    }
  }
  return { fields, labelKeys };
}

/** `DocPayload.codes` — keyed by the kind's `defaultCodeSource` field token (`catalog.ts`). `null` = the kind has no `code` element (none currently do, but the type allows it). */
export function buildCodes<Token extends string>(
  defaultCodeSource: string | null,
  all: Record<Token, string>,
): Record<string, string> {
  if (!defaultCodeSource) return {};
  const value = (all as Record<string, string>)[defaultCodeSource];
  return value !== undefined ? { [defaultCodeSource]: value } : {};
}

export interface DocRenderContext {
  brand: import('@mimi/shared').BrandPalette;
  logoAttachmentId: string | null;
  backgroundAttachmentId: string | null;
}

/** Shared `DocPayload` tail every resolver assembles identically. */
export function documentHead(kind: DocKind, ctx: DocRenderContext) {
  return {
    kind,
    logoAttachmentId: ctx.logoAttachmentId,
    backgroundAttachmentId: ctx.backgroundAttachmentId,
    brand: ctx.brand,
  };
}
