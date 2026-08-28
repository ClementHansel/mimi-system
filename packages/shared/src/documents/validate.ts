/**
 * Structural validation for an owner-authored `DocTemplate`.
 *
 * Shared, not backend-only, for the same reason `offline/unlock-code.ts` is
 * shared: the designer should refuse to SAVE a template the server would
 * reject, and the server must never trust that it did. One implementation,
 * two callers, no drift about what "valid" means.
 *
 * This is deliberately STRUCTURAL, not aesthetic. It rejects what would break
 * a render (an unknown element type, a table with no columns, a colour that
 * isn't a colour, geometry outside the page) and permits everything that is
 * merely ugly (overlapping elements, a 4px font, an empty page). Refusing to
 * save an ugly layout would be this file deciding how an owner's own invoice
 * should look.
 *
 * Returns a diagnostic list — empty means valid — matching
 * `settings-value-validator.ts`'s contract exactly, so the backend can raise
 * the same `ERR_VALIDATION` shape from both.
 */

import { DOC_CATALOGS } from './catalog';
import {
  DOC_ELEMENT_TYPES,
  DOC_PAPERS,
  DOC_TEMPLATE_LIMITS,
  isDocKind,
  isValidDocColor,
  type DocElement,
  type DocKind,
  type DocTemplate,
} from './template';

const ALIGNS = new Set(['left', 'center', 'right']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateElement(
  el: unknown,
  index: number,
  tpl: DocTemplate,
  kind: DocKind,
  errors: string[],
  seenIds: Set<string>,
): void {
  const at = `elements[${index}]`;
  if (typeof el !== 'object' || el === null || Array.isArray(el)) {
    errors.push(`${at} must be an object`);
    return;
  }
  const e = el as Partial<DocElement>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    errors.push(`${at}.id is required`);
  } else if (seenIds.has(e.id)) {
    // Duplicate ids would make the designer's select/drag/delete act on an
    // arbitrary one of the two, and React's keyed reconciliation act on the
    // other.
    errors.push(`${at}.id '${e.id}' is duplicated`);
  } else {
    seenIds.add(e.id);
  }

  if (typeof e.type !== 'string' || !(DOC_ELEMENT_TYPES as readonly string[]).includes(e.type)) {
    errors.push(`${at}.type '${String(e.type)}' is not a known element type`);
    return;
  }
  const catalog = DOC_CATALOGS[kind];
  if (!catalog.elements.includes(e.type)) {
    errors.push(`${at}.type '${e.type}' is not available on a '${kind}' document`);
  }

  for (const axis of ['x', 'y', 'w', 'h'] as const) {
    if (!isFiniteNumber(e[axis])) {
      errors.push(`${at}.${axis} must be a number`);
    }
  }
  if (isFiniteNumber(e.w) && isFiniteNumber(e.x) && (e.x < 0 || e.x + e.w > tpl.width)) {
    errors.push(`${at} extends outside the ${tpl.width}px page width`);
  }
  if (isFiniteNumber(e.h) && isFiniteNumber(e.y) && (e.y < 0 || e.y + e.h > tpl.height)) {
    errors.push(`${at} extends outside the ${tpl.height}px page height`);
  }

  if (e.fontSize !== undefined) {
    if (
      !isFiniteNumber(e.fontSize) ||
      e.fontSize < DOC_TEMPLATE_LIMITS.minFontSize ||
      e.fontSize > DOC_TEMPLATE_LIMITS.maxFontSize
    ) {
      errors.push(
        `${at}.fontSize must be between ${DOC_TEMPLATE_LIMITS.minFontSize} and ${DOC_TEMPLATE_LIMITS.maxFontSize}`,
      );
    }
  }
  for (const key of ['color', 'background'] as const) {
    if (e[key] !== undefined && !isValidDocColor(e[key])) {
      errors.push(`${at}.${key} must be #rrggbb or a brand.* token`);
    }
  }
  if (e.align !== undefined && !ALIGNS.has(e.align)) {
    errors.push(`${at}.align must be left, center or right`);
  }

  if (e.type === 'field') {
    if (typeof e.field !== 'string' || !catalog.fields.includes(e.field)) {
      errors.push(`${at}.field '${String(e.field)}' is not a '${kind}' field token`);
    }
  }

  if (e.type === 'text') {
    if (typeof e.text !== 'string') {
      errors.push(`${at}.text is required for a text element`);
    } else if (e.text.length > DOC_TEMPLATE_LIMITS.maxTextLength) {
      errors.push(`${at}.text exceeds ${DOC_TEMPLATE_LIMITS.maxTextLength} characters`);
    }
  }

  if (e.type === 'code') {
    if (e.codeType !== undefined && e.codeType !== 'qr' && e.codeType !== 'barcode') {
      errors.push(`${at}.codeType must be 'qr' or 'barcode'`);
    }
    const source = e.codeSource ?? catalog.defaultCodeSource;
    if (typeof source !== 'string' || !catalog.fields.includes(source)) {
      errors.push(`${at}.codeSource '${String(source)}' is not a '${kind}' field token`);
    }
  }

  if (e.type === 'signature') {
    if (typeof e.signatureRole !== 'string' || !catalog.signatureRoles.includes(e.signatureRole)) {
      errors.push(`${at}.signatureRole '${String(e.signatureRole)}' is not valid for '${kind}'`);
    }
  }

  if (e.type === 'table') {
    if (!Array.isArray(e.columns) || e.columns.length === 0) {
      errors.push(`${at}.columns must list at least one column`);
      return;
    }
    if (e.columns.length > DOC_TEMPLATE_LIMITS.maxColumns) {
      errors.push(`${at}.columns exceeds ${DOC_TEMPLATE_LIMITS.maxColumns} columns`);
    }
    const seenCols = new Set<string>();
    e.columns.forEach((col, ci) => {
      const cAt = `${at}.columns[${ci}]`;
      if (typeof col?.key !== 'string' || !catalog.columns.includes(col.key)) {
        errors.push(`${cAt}.key '${String(col?.key)}' is not a '${kind}' column`);
      } else if (seenCols.has(col.key)) {
        errors.push(`${cAt}.key '${col.key}' is duplicated`);
      } else {
        seenCols.add(col.key);
      }
      if (!isFiniteNumber(col?.width) || col.width <= 0) {
        errors.push(`${cAt}.width must be a positive number`);
      }
      if (col?.align !== undefined && !ALIGNS.has(col.align)) {
        errors.push(`${cAt}.align must be left, center or right`);
      }
      if (col?.labelText !== undefined && typeof col.labelText !== 'string') {
        errors.push(`${cAt}.labelText must be a string`);
      }
    });
  }
}

/** Empty means valid. */
export function validateDocTemplate(kind: string, value: unknown): string[] {
  const errors: string[] = [];
  if (!isDocKind(kind)) return [`'${kind}' is not a document kind`];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['template must be an object'];
  }
  const tpl = value as Partial<DocTemplate>;

  if (tpl.kind !== kind) {
    errors.push(`template.kind '${String(tpl.kind)}' does not match the '${kind}' being saved`);
  }
  if (typeof tpl.paper !== 'string' || !(DOC_PAPERS as readonly string[]).includes(tpl.paper)) {
    errors.push(`template.paper '${String(tpl.paper)}' is not a known paper size`);
  }
  for (const dim of ['width', 'height'] as const) {
    const v = tpl[dim];
    if (
      !isFiniteNumber(v) ||
      v < DOC_TEMPLATE_LIMITS.minDimension ||
      v > DOC_TEMPLATE_LIMITS.maxDimension
    ) {
      errors.push(
        `template.${dim} must be between ${DOC_TEMPLATE_LIMITS.minDimension} and ${DOC_TEMPLATE_LIMITS.maxDimension}`,
      );
    }
  }
  if (
    tpl.backgroundAttachmentId !== null &&
    tpl.backgroundAttachmentId !== undefined &&
    typeof tpl.backgroundAttachmentId !== 'string'
  ) {
    errors.push('template.backgroundAttachmentId must be an attachment id or null');
  }
  if (!Array.isArray(tpl.elements)) {
    errors.push('template.elements must be an array');
    return errors;
  }
  if (tpl.elements.length > DOC_TEMPLATE_LIMITS.maxElements) {
    errors.push(`template.elements exceeds ${DOC_TEMPLATE_LIMITS.maxElements} elements`);
  }

  // Geometry checks below read `tpl.width`/`tpl.height`; if either failed
  // above, every element would then also report "outside the page", burying
  // the one real error under a wall of derived ones.
  if (errors.some((e) => e.startsWith('template.width') || e.startsWith('template.height'))) {
    return errors;
  }

  const seenIds = new Set<string>();
  tpl.elements.forEach((e, i) => validateElement(e, i, tpl as DocTemplate, kind, errors, seenIds));
  return errors;
}
