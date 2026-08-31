'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Copy, ImageUp, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { useBrand } from '@/lib/brand';
import { resolveAttachmentUrl } from '@/lib/attachment-url';
import { uploadAttachment, DOC_BACKGROUND_KIND } from '@/components/admin/lib/attachments';
import { Button, Checkbox, Input, Modal, Select, Textarea, EmptyState } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import {
  BRAND_COLOR_TOKENS,
  DOC_CATALOGS,
  DOC_PAPERS,
  DOC_PAPER_SIZES,
  DOC_TEMPLATE_LIMITS,
  defaultDocTemplate,
  validateDocTemplate,
  type DocAlign,
  type DocElement,
  type DocElementType,
  type DocKind,
  type DocPaper,
  type DocTableColumn,
  type DocTemplate,
} from '@/lib/shared-types';
import { DocumentRenderer } from './DocumentRenderer';
import { getDocTemplate, putDocTemplate, resetDocTemplate } from './doc-api';
import { sampleDocData } from './sample-data';
import { apiErrorDetail } from '@/lib/api-error';

/**
 * The document designer: drag boxes on a page, see the result live, save it.
 *
 * Adopted from `aire`'s `DocumentDesigner.tsx`, with four things done
 * differently and one thing taken verbatim.
 *
 * TAKEN VERBATIM — the drag math. Capture the pointer on `pointerdown`, record
 * the pointer's page coordinates AND the element's template coordinates, and
 * on every `pointermove` set the element to `origin + (pointer - start) /
 * scale`. It is the right shape: it never reads the element's live position
 * (which would accumulate rounding), and dividing the pointer delta by the
 * canvas scale is the single line that makes dragging correct at any zoom.
 *
 * DIFFERENT #1 — THE PALETTE IS DATA, NOT A LIST IN THIS FILE. `aire` hardcodes
 * `allowLogo/allowCode/allowTable/allowTotals` booleans per kind and a
 * hand-written field list with English labels. Here both come from
 * `DOC_CATALOGS[kind]` in `@mimi/shared`, which is the same object the backend
 * resolvers are typed against — so a token this palette offers is a token some
 * resolver is compelled to fill (`documents/catalog.ts` explains why that
 * matters: a token nobody fills prints as an empty box on a real invoice).
 *
 * DIFFERENT #2 — KEYBOARD. `aire`'s canvas is drag-only. That makes fine
 * positioning (nudging a total two pixels so it lines up with the column above
 * it) a game of pixel-hunting with a trackpad, and makes the editor unusable
 * without a pointing device at all. Every element here is a real `<button>`:
 * Tab reaches it, Enter/Space selects it, arrows nudge it 1px, Shift+arrows a
 * grid step, Delete removes it.
 *
 * DIFFERENT #3 — COLOUR IS A TOKEN FIRST. The four `brand.*` tokens are
 * first-class swatches, offered before the custom picker, because a template
 * that names tokens is a template that follows the brand forever
 * (`documents/defaults.ts` rule 1). A literal hex is available and is
 * sometimes right — but it is opting one element out of the brand, and the
 * panel says so.
 *
 * DIFFERENT #4 — SAVE VALIDATES WITH THE SERVER'S OWN VALIDATOR.
 * `validateDocTemplate` is shared (`@mimi/shared`), so the designer refuses to
 * send what the server would refuse to store, and when the server refuses
 * anyway its `details` are shown verbatim rather than replaced with "gagal
 * menyimpan". The client check is a courtesy; the server's is the boundary.
 */

/**
 * Snap step, in template pixels. 4 is small enough to place a 9px caption
 * against a rule and coarse enough that two elements an owner meant to align
 * actually do. It is a UI convenience only — nothing in the model or the
 * validator knows about a grid, so a template hand-edited off-grid still
 * renders and still saves.
 */
const GRID = 4;

/** Shift+arrow moves by a grid step; a bare arrow moves by one pixel. */
const NUDGE_COARSE = GRID;

/** Default footprint for a newly added element, per type, in template pixels. */
const DEFAULT_SIZE: Record<DocElementType, { w: number; h: number }> = {
  text: { w: 200, h: 24 },
  field: { w: 200, h: 20 },
  logo: { w: 140, h: 56 },
  table: { w: 480, h: 300 },
  totals: { w: 240, h: 100 },
  code: { w: 80, h: 80 },
  // A divider's box IS its thickness — 1px tall is a horizontal rule (see the
  // renderer, which reads a taller-than-wide box as a vertical one).
  divider: { w: 240, h: 1 },
  box: { w: 160, h: 80 },
  signature: { w: 200, h: 100 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapTo(value: number, snap: boolean): number {
  return snap ? Math.round(value / GRID) * GRID : Math.round(value);
}

/**
 * Column widths must always sum EXACTLY to the table element's width.
 *
 * This is not cosmetic. `renderTable` emits a `<colgroup>` of fixed pixel
 * widths inside a `table-layout: fixed` table that is `width: 100%` of the
 * element — so if the widths sum to more than the element, the browser
 * compresses every column proportionally and the rightmost money column
 * silently loses its last digits; if they sum to less, the last column
 * stretches and the right edge stops aligning with the rule above it. The
 * seeded defaults already satisfy this (and a shared test asserts it), so an
 * owner resizing one column must not be the thing that breaks it.
 *
 * The redistribution takes the difference out of (or gives it to) the OTHER
 * columns in proportion to their current widths, then puts any rounding
 * remainder on the last column. Proportional rather than "all on the
 * neighbour" because an owner widening the item-name column expects every
 * other column to give a little, not for one adjacent column to collapse.
 */
const MIN_COLUMN_WIDTH = 16;

function normalizeColumnWidths(
  columns: readonly DocTableColumn[],
  total: number,
): DocTableColumn[] {
  if (columns.length === 0) return [];
  const floor = MIN_COLUMN_WIDTH * columns.length;
  // A table narrower than its own minimum cannot be satisfied; spread evenly
  // and let `validateDocTemplate` speak if the geometry is genuinely broken.
  if (total <= floor) {
    const each = Math.max(1, Math.floor(total / columns.length));
    return columns.map((c, i) => ({
      ...c,
      width: i === columns.length - 1 ? total - each * (columns.length - 1) : each,
    }));
  }

  const current = columns.reduce((sum, c) => sum + Math.max(MIN_COLUMN_WIDTH, c.width), 0);
  const ratio = total / current;
  const scaled = columns.map((c) => ({
    ...c,
    width: Math.max(MIN_COLUMN_WIDTH, Math.round(Math.max(MIN_COLUMN_WIDTH, c.width) * ratio)),
  }));
  const drift = total - scaled.reduce((sum, c) => sum + c.width, 0);
  const last = scaled[scaled.length - 1];
  if (last) last.width = Math.max(MIN_COLUMN_WIDTH, last.width + drift);
  return scaled;
}

/** Resize ONE column and absorb the difference across the rest. */
function resizeColumn(
  columns: readonly DocTableColumn[],
  index: number,
  nextWidth: number,
  total: number,
): DocTableColumn[] {
  if (columns.length === 1) {
    const only = columns[0];
    return only ? [{ ...only, width: total }] : [];
  }
  const others = columns.filter((_, i) => i !== index);
  const target = clamp(nextWidth, MIN_COLUMN_WIDTH, total - MIN_COLUMN_WIDTH * others.length);
  const remaining = total - target;
  const rescaledOthers = normalizeColumnWidths(others, remaining);

  const out: DocTableColumn[] = [];
  let cursor = 0;
  for (let i = 0; i < columns.length; i++) {
    const source = columns[i];
    if (!source) continue;
    if (i === index) out.push({ ...source, width: target });
    else {
      const scaled = rescaledOthers[cursor++];
      out.push(scaled ?? source);
    }
  }
  return out;
}

let elementSeq = 0;
function mintElementId(prefix: string): string {
  elementSeq += 1;
  // Time plus a monotonic counter: two elements added in the same millisecond
  // must not collide, because a duplicate id is a `validateDocTemplate` error
  // AND it would make select/drag/delete act on an arbitrary one of the two
  // (that validator's own note on duplicate ids).
  return `${prefix}-${Date.now().toString(36)}-${elementSeq.toString(36)}`;
}

// ── Colour control ───────────────────────────────────────────────────────────

/**
 * A colour picker whose FIRST options are the four brand tokens.
 *
 * `nullable` is for `background`, where "no colour" is a meaningful third
 * state (a `box` with no fill is an outline; a `table` with no header fill
 * prints an unfilled header row) — as opposed to `color`, where an absent
 * value already means `brand.ink` per `resolveDocColor`.
 */
function ColorField({
  label,
  value,
  onChange,
  nullable = false,
}: {
  label: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  nullable?: boolean;
}) {
  const { t } = useI18n();
  const { palette } = useBrand();
  const isToken = !!value && (BRAND_COLOR_TOKENS as readonly string[]).includes(value);
  const swatchFor = (token: string): string =>
    token === 'brand.primary'
      ? palette.primary
      : token === 'brand.accent'
        ? palette.accent
        : token === 'brand.ink'
          ? palette.ink
          : palette.muted;
  const tokenLabel: Record<string, string> = {
    'brand.primary': t('doc.designer.colorBrandPrimary'),
    'brand.accent': t('doc.designer.colorBrandAccent'),
    'brand.ink': t('doc.designer.colorBrandInk'),
    'brand.muted': t('doc.designer.colorBrandMuted'),
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {BRAND_COLOR_TOKENS.map((token) => (
          <button
            key={token}
            type="button"
            title={tokenLabel[token]}
            aria-label={tokenLabel[token]}
            aria-pressed={value === token}
            onClick={() => onChange(token)}
            className={`size-7 rounded-md border-2 ${value === token ? 'border-text-primary' : 'border-border'}`}
            style={{ background: swatchFor(token) }}
          />
        ))}
        {nullable && (
          <button
            type="button"
            title={t('doc.designer.colorNone')}
            aria-label={t('doc.designer.colorNone')}
            aria-pressed={value === undefined}
            onClick={() => onChange(undefined)}
            className={`size-7 rounded-md border-2 bg-surface text-[10px] ${value === undefined ? 'border-text-primary' : 'border-border'}`}
          >
            —
          </button>
        )}
        {/* A native colour input, deliberately: it is the one control every
            browser and every tablet already knows how to open, and it costs no
            dependency. Its value is only meaningful when the element is NOT on
            a brand token, so it shows the resolved token colour while one is
            selected and switches the element to a literal the moment it is
            used. */}
        <input
          type="color"
          aria-label={t('doc.designer.colorCustom')}
          value={isToken ? swatchFor(value) : (value ?? '#000000')}
          onChange={(e) => onChange(e.target.value)}
          className={`size-7 cursor-pointer rounded-md border-2 bg-transparent p-0 ${!isToken && value ? 'border-text-primary' : 'border-border'}`}
        />
      </div>
      <p className="text-[11px] leading-snug text-text-muted">{t('doc.designer.colorBrandHint')}</p>
    </div>
  );
}

// ── Properties panel ─────────────────────────────────────────────────────────

function ColumnsEditor({
  element,
  kind,
  onChange,
}: {
  element: DocElement;
  kind: DocKind;
  onChange: (columns: DocTableColumn[]) => void;
}) {
  const { t } = useI18n();
  const columns = element.columns ?? [];
  const catalogColumns = DOC_CATALOGS[kind].columns;
  const unused = catalogColumns.filter((key) => !columns.some((c) => c.key === key));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">
          {t('doc.designer.propColumns')}
        </span>
        <Select
          size="sm"
          placeholder={t('doc.designer.addColumn')}
          options={unused.map((key) => ({ value: key, label: t(`doc.column.${key}`) }))}
          value=""
          disabled={unused.length === 0 || columns.length >= DOC_TEMPLATE_LIMITS.maxColumns}
          onValueChange={(key) => {
            if (!key) return;
            onChange(
              normalizeColumnWidths(
                [...columns, { key, width: MIN_COLUMN_WIDTH, align: 'left' as DocAlign }],
                element.w,
              ),
            );
          }}
          wrapperClassName="w-40"
        />
      </div>

      <p className="text-[11px] leading-snug text-text-muted">
        {t('doc.designer.columnWidthNotice', { width: element.w })}
      </p>

      {columns.map((column, index) => (
        <div key={column.key} className="rounded-md border border-border p-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t(`doc.column.${column.key}`)}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('doc.designer.removeColumn')}
              disabled={columns.length <= 1}
              onClick={() =>
                onChange(
                  normalizeColumnWidths(
                    columns.filter((_, i) => i !== index),
                    element.w,
                  ),
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              size="sm"
              label={t('doc.designer.propColumnLabel')}
              hint={t('doc.designer.propColumnLabelHint')}
              value={column.labelText ?? ''}
              onChange={(e) => {
                const next = [...columns];
                next[index] = { ...column, labelText: e.target.value || undefined };
                onChange(next);
              }}
            />
            <Input
              size="sm"
              type="number"
              label={t('doc.designer.propColumnWidth')}
              value={String(column.width)}
              onChange={(e) =>
                onChange(resizeColumn(columns, index, Number(e.target.value), element.w))
              }
            />
          </div>
          <div className="mt-2">
            <Select
              size="sm"
              label={t('doc.designer.propColumnAlign')}
              options={(['left', 'center', 'right'] as DocAlign[]).map((a) => ({
                value: a,
                label: t(`doc.designer.align.${a}`),
              }))}
              value={column.align ?? 'left'}
              onValueChange={(a) => {
                const next = [...columns];
                next[index] = { ...column, align: a as DocAlign };
                onChange(next);
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PropertiesPanel({
  element,
  kind,
  page,
  onPatch,
}: {
  element: DocElement | null;
  kind: DocKind;
  page: { width: number; height: number };
  onPatch: (patch: Partial<DocElement>) => void;
}) {
  const { t } = useI18n();
  const catalog = DOC_CATALOGS[kind];

  if (!element) {
    return <p className="text-sm text-text-muted">{t('doc.designer.noSelection')}</p>;
  }

  const numberField = (key: 'x' | 'y' | 'w' | 'h', label: string, max: number) => (
    <Input
      size="sm"
      type="number"
      label={label}
      value={String(element[key])}
      onChange={(e) => onPatch({ [key]: clamp(Number(e.target.value), 0, max) })}
    />
  );

  // Which controls apply is derived from the element TYPE, not from a flag on
  // the template: a `divider` has no font size, a `logo` has no alignment of
  // text, and showing an inert control is worse than showing none.
  const hasText = element.type === 'text';
  const hasTypography =
    element.type === 'text' ||
    element.type === 'field' ||
    element.type === 'table' ||
    element.type === 'totals' ||
    element.type === 'signature';
  const hasAlign =
    element.type === 'text' ||
    element.type === 'field' ||
    element.type === 'logo' ||
    element.type === 'code' ||
    element.type === 'totals';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {numberField('x', t('doc.designer.propX'), page.width)}
        {numberField('y', t('doc.designer.propY'), page.height)}
        {numberField('w', t('doc.designer.propW'), page.width)}
        {numberField('h', t('doc.designer.propH'), page.height)}
      </div>

      {hasText && (
        <Textarea
          label={t('doc.designer.propText')}
          rows={3}
          maxLength={DOC_TEMPLATE_LIMITS.maxTextLength}
          value={element.text ?? ''}
          onChange={(e) => onPatch({ text: e.target.value })}
        />
      )}

      {element.type === 'field' && (
        <Select
          size="sm"
          label={t('doc.designer.propField')}
          options={catalog.fields.map((token) => ({
            value: token,
            label: t(`doc.field.${token}`),
          }))}
          value={element.field ?? ''}
          onValueChange={(field) => onPatch({ field })}
        />
      )}

      {element.type === 'signature' && (
        <Select
          size="sm"
          label={t('doc.designer.propSignatureRole')}
          options={catalog.signatureRoles.map((role) => ({
            value: role,
            label: t(`doc.signature.${role}`),
          }))}
          value={element.signatureRole ?? ''}
          onValueChange={(signatureRole) => onPatch({ signatureRole })}
        />
      )}

      {element.type === 'code' && (
        <>
          <Select
            size="sm"
            label={t('doc.designer.propCodeType')}
            options={[
              { value: 'qr', label: t('doc.designer.codeType.qr') },
              { value: 'barcode', label: t('doc.designer.codeType.barcode') },
            ]}
            value={element.codeType ?? 'qr'}
            onValueChange={(codeType) => onPatch({ codeType: codeType as 'qr' | 'barcode' })}
          />
          <Select
            size="sm"
            label={t('doc.designer.propCodeSource')}
            options={catalog.fields.map((token) => ({
              value: token,
              label: t(`doc.field.${token}`),
            }))}
            value={element.codeSource ?? catalog.defaultCodeSource ?? ''}
            onValueChange={(codeSource) => onPatch({ codeSource })}
          />
        </>
      )}

      {hasTypography && (
        <Input
          size="sm"
          type="number"
          label={t('doc.designer.propFontSize')}
          min={DOC_TEMPLATE_LIMITS.minFontSize}
          max={DOC_TEMPLATE_LIMITS.maxFontSize}
          value={String(element.fontSize ?? 12)}
          onChange={(e) =>
            onPatch({
              fontSize: clamp(
                Number(e.target.value),
                DOC_TEMPLATE_LIMITS.minFontSize,
                DOC_TEMPLATE_LIMITS.maxFontSize,
              ),
            })
          }
        />
      )}

      <ColorField
        label={t('doc.designer.propColor')}
        value={element.color}
        onChange={(color) => onPatch({ color })}
      />

      {(element.type === 'box' || element.type === 'table') && (
        <ColorField
          nullable
          label={t('doc.designer.propBackground')}
          value={element.background}
          onChange={(background) => onPatch({ background })}
        />
      )}

      {hasAlign && (
        <Select
          size="sm"
          label={t('doc.designer.propAlign')}
          options={(['left', 'center', 'right'] as DocAlign[]).map((a) => ({
            value: a,
            label: t(`doc.designer.align.${a}`),
          }))}
          value={element.align ?? 'left'}
          onValueChange={(align) => onPatch({ align: align as DocAlign })}
        />
      )}

      {(element.type === 'text' || element.type === 'field') && (
        <>
          <Checkbox
            label={t('doc.designer.propBold')}
            checked={element.bold === true}
            onCheckedChange={(bold) => onPatch({ bold })}
          />
          <Checkbox
            label={t('doc.designer.propWrap')}
            description={t('doc.designer.propWrapHint')}
            checked={element.wrap === true}
            onCheckedChange={(wrap) => onPatch({ wrap })}
          />
        </>
      )}

      {element.type === 'table' && (
        <ColumnsEditor element={element} kind={kind} onChange={(columns) => onPatch({ columns })} />
      )}
    </div>
  );
}

// ── The designer ─────────────────────────────────────────────────────────────

export function DocumentDesigner({ kind }: { kind: DocKind }) {
  const { t } = useI18n();
  const { palette, logoUrl } = useBrand();
  const catalog = DOC_CATALOGS[kind];

  const [template, setTemplate] = useState<DocTemplate | null>(null);
  /** The last state the server acknowledged — the baseline "unsaved changes" is measured against. */
  const [savedJson, setSavedJson] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState(0.6);
  const [snap, setSnap] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adopt = useCallback((next: DocTemplate) => {
    setTemplate(next);
    setSavedJson(JSON.stringify(next));
    setErrors([]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTemplate(null);
    setSelectedId(null);
    setLoadError(null);
    getDocTemplate(kind)
      .then((tpl) => {
        if (!cancelled) adopt(tpl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : t('doc.designer.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, adopt, t]);

  // The background is an attachment id on the template; the preview needs a
  // URL. Resolved separately (and cached by `lib/attachment-url`) so switching
  // between the four designers does not re-presign the same letterhead.
  useEffect(() => {
    let cancelled = false;
    void resolveAttachmentUrl(template?.backgroundAttachmentId ?? null).then((url) => {
      if (!cancelled) setBackgroundUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [template?.backgroundAttachmentId]);

  const dirty = template !== null && JSON.stringify(template) !== savedJson;
  const selected = template?.elements.find((e) => e.id === selectedId) ?? null;

  const data = useMemo(
    () => sampleDocData(kind, palette, { logoUrl, backgroundUrl, t }),
    [kind, palette, logoUrl, backgroundUrl, t],
  );

  // ── Mutation helpers ───────────────────────────────────────────────────────

  const patchElement = useCallback((id: string, patch: Partial<DocElement>) => {
    setTemplate((current) => {
      if (!current) return current;
      return {
        ...current,
        elements: current.elements.map((el) => {
          if (el.id !== id) return el;
          const next = { ...el, ...patch };
          // Resizing a TABLE has to re-fit its columns, or the invariant
          // above (`normalizeColumnWidths`) breaks the moment somebody drags
          // the table's right edge rather than editing a column number.
          if (next.type === 'table' && next.columns && patch.w !== undefined) {
            next.columns = normalizeColumnWidths(next.columns, next.w);
          }
          return next;
        }),
      };
    });
  }, []);

  const addElement = useCallback(
    (type: DocElementType, field?: string) => {
      setTemplate((current) => {
        if (!current) return current;
        if (current.elements.length >= DOC_TEMPLATE_LIMITS.maxElements) return current;
        const size = DEFAULT_SIZE[type];
        const w = Math.min(size.w, current.width - GRID * 2);
        const h = Math.min(size.h, current.height - GRID * 2);
        // Dropped in the middle of the page rather than at 0,0: the top-left
        // corner of a seeded template is already occupied by a logo, so a new
        // element there would land invisible under it and read as "the button
        // did nothing".
        const element: DocElement = {
          id: mintElementId(field ?? type),
          type,
          x: snapTo(clamp((current.width - w) / 2, 0, current.width - w), true),
          y: snapTo(clamp((current.height - h) / 2, 0, current.height - h), true),
          w,
          h,
          fontSize: 11,
          color: 'brand.ink',
          align: 'left',
          ...(field ? { field } : {}),
          ...(type === 'text' ? { text: '' } : {}),
          ...(type === 'code'
            ? { codeType: 'qr' as const, codeSource: catalog.defaultCodeSource ?? undefined }
            : {}),
          ...(type === 'signature' ? { signatureRole: catalog.signatureRoles[0] } : {}),
          ...(type === 'table'
            ? {
                columns: normalizeColumnWidths(
                  catalog.columns.slice(0, 4).map((key) => ({
                    key,
                    width: MIN_COLUMN_WIDTH,
                    align: 'left' as DocAlign,
                  })),
                  w,
                ),
              }
            : {}),
        };
        setSelectedId(element.id);
        return { ...current, elements: [...current.elements, element] };
      });
    },
    [catalog],
  );

  const removeElement = useCallback((id: string) => {
    setTemplate((current) =>
      current ? { ...current, elements: current.elements.filter((el) => el.id !== id) } : current,
    );
    setSelectedId(null);
  }, []);

  const duplicateElement = useCallback((id: string) => {
    setTemplate((current) => {
      if (!current) return current;
      const source = current.elements.find((el) => el.id === id);
      if (!source || current.elements.length >= DOC_TEMPLATE_LIMITS.maxElements) return current;
      const copy: DocElement = {
        ...source,
        id: mintElementId(source.type),
        // Offset by a grid step so the copy is visibly a second object rather
        // than something that looks like nothing happened.
        x: clamp(source.x + GRID * 2, 0, current.width - source.w),
        y: clamp(source.y + GRID * 2, 0, current.height - source.h),
        ...(source.columns ? { columns: source.columns.map((c) => ({ ...c })) } : {}),
      };
      setSelectedId(copy.id);
      return { ...current, elements: [...current.elements, copy] };
    });
  }, []);

  // ── Drag ───────────────────────────────────────────────────────────────────

  /**
   * Pointer drag. `setPointerCapture` on the handle means the drag survives the
   * pointer leaving the element (and the canvas) — without it, moving fast
   * drops the element mid-drag, which is the single most common complaint
   * about hand-rolled canvas editors.
   *
   * The origin is captured ONCE in a ref, and every move recomputes the
   * absolute position from it. Applying per-move deltas instead would
   * accumulate the snap rounding, so a slow drag across the page would end up
   * somewhere a fast one did not.
   */
  const dragRef = useRef<{
    id: string;
    mode: 'move' | 'resize';
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    el: DocElement,
    mode: 'move' | 'resize',
  ) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(el.id);
    dragRef.current = {
      id: el.id,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: el.x,
      originY: el.y,
      originW: el.w,
      originH: el.h,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || !template) return;
    // THE line that makes this work at any zoom: a pointer delta is in SCREEN
    // pixels, the model is in TEMPLATE pixels, and the canvas is scaled by
    // exactly `scale`.
    const dx = (event.clientX - drag.pointerX) / scale;
    const dy = (event.clientY - drag.pointerY) / scale;

    if (drag.mode === 'move') {
      patchElement(drag.id, {
        x: clamp(snapTo(drag.originX + dx, snap), 0, template.width - drag.originW),
        y: clamp(snapTo(drag.originY + dy, snap), 0, template.height - drag.originH),
      });
      return;
    }
    patchElement(drag.id, {
      w: clamp(snapTo(drag.originW + dx, snap), GRID, template.width - drag.originX),
      h: clamp(snapTo(drag.originH + dy, snap), 1, template.height - drag.originY),
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function handleElementKeyDown(event: ReactKeyboardEvent<HTMLElement>, el: DocElement) {
    if (!template) return;
    const step = event.shiftKey ? NUDGE_COARSE : 1;
    const move = (dx: number, dy: number) => {
      event.preventDefault();
      patchElement(el.id, {
        x: clamp(el.x + dx, 0, template.width - el.w),
        y: clamp(el.y + dy, 0, template.height - el.h),
      });
    };
    switch (event.key) {
      case 'ArrowLeft':
        return move(-step, 0);
      case 'ArrowRight':
        return move(step, 0);
      case 'ArrowUp':
        return move(0, -step);
      case 'ArrowDown':
        return move(0, step);
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        return removeElement(el.id);
      default:
        return;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  async function save() {
    if (!template) return;
    // The SHARED validator, so the designer refuses exactly what the server
    // would refuse. This is a courtesy check, not a boundary — the server runs
    // it again on the row it is about to store.
    const clientErrors = validateDocTemplate(kind, template);
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      const stored = await putDocTemplate(kind, template);
      adopt(stored);
      toast({ title: t('doc.designer.saved'), variant: 'success' });
    } catch (err) {
      // `ERR_VALIDATION` carries `details` — the same strings
      // `validateDocTemplate` produces. Showing them verbatim tells the owner
      // WHICH element is off the page; replacing them with a generic failure
      // message would leave them clicking Save and guessing.
      const details = err instanceof ApiError && Array.isArray(err.details) ? err.details : null;
      if (details) setErrors(details.map((d) => String(d)));
      toast({
        title: t('doc.designer.saveFailed'),
        description: err instanceof ApiError && !details ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }

  async function doReset() {
    setResetOpen(false);
    try {
      // The SERVER's default, not `defaultDocTemplate(kind)` from the local
      // bundle — one authority for "default", for the reason `doc-api.ts`
      // records. The local import is still used, below, as the offline-safe
      // fallback if the call fails, because an owner who asked to reset should
      // not be left holding the layout they wanted rid of.
      const restored = await resetDocTemplate(kind);
      adopt(restored);
      setSelectedId(null);
      toast({ title: t('doc.designer.resetDone'), variant: 'success' });
    } catch (err) {
      setTemplate(defaultDocTemplate(kind));
      setSelectedId(null);
      toast({
        title: t('doc.designer.saveFailed'),
        description: err instanceof ApiError ? err.message : undefined,
        variant: 'danger',
      });
    }
  }

  async function uploadBackground(file: File) {
    setUploading(true);
    try {
      const attachmentId = await uploadAttachment(file, DOC_BACKGROUND_KIND);
      setTemplate((current) =>
        current ? { ...current, backgroundAttachmentId: attachmentId } : current,
      );
    } catch (err) {
      toast({
        title: t('doc.designer.uploadFailed'),
        description: apiErrorDetail(err),
        variant: 'danger',
      });
    } finally {
      setUploading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loadError) return <EmptyState size="lg" title={loadError} />;
  if (!template) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;

  const paperOptions = DOC_PAPERS.map((paper) => ({ value: paper, label: paper }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-text-secondary">{t('doc.designer.description')}</p>
        <p className="text-xs text-text-muted">
          {t('doc.designer.keyboardHint', { step: NUDGE_COARSE })}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface-raised p-3">
        <Select
          size="sm"
          label={t('doc.designer.paper')}
          options={paperOptions}
          value={template.paper}
          onValueChange={(paper) => {
            const size = DOC_PAPER_SIZES[paper as DocPaper];
            // Width/height follow the paper. Elements are NOT re-flowed:
            // moving somebody's layout for them would be a worse surprise than
            // an element that now sticks off the page, and
            // `validateDocTemplate` names every one of those on save.
            setTemplate({
              ...template,
              paper: paper as DocPaper,
              width: size.width,
              height: size.height,
            });
          }}
          wrapperClassName="w-32"
        />
        <Select
          size="sm"
          label={t('doc.designer.zoom')}
          options={[0.4, 0.5, 0.6, 0.75, 1].map((z) => ({
            value: String(z),
            label: `${Math.round(z * 100)}%`,
          }))}
          value={String(scale)}
          onValueChange={(z) => setScale(Number(z))}
          wrapperClassName="w-28"
        />
        <div className="pb-1">
          <Checkbox
            label={t('doc.designer.snap')}
            description={t('doc.designer.snapHint', { size: GRID })}
            checked={snap}
            onCheckedChange={setSnap}
          />
        </div>

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadBackground(file);
              e.target.value = '';
            }}
          />
          <Button
            size="sm"
            variant="outline"
            loading={uploading}
            leftIcon={<ImageUp className="size-4" />}
            onClick={() => fileInputRef.current?.click()}
          >
            {template.backgroundAttachmentId
              ? t('doc.designer.background')
              : t('doc.designer.backgroundUpload')}
          </Button>
          {template.backgroundAttachmentId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTemplate({ ...template, backgroundAttachmentId: null })}
            >
              {t('doc.designer.backgroundRemove')}
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-end gap-2">
          {dirty && (
            <span className="pb-2 text-xs text-warning-700">{t('doc.designer.unsaved')}</span>
          )}
          <Button
            size="sm"
            variant="outline"
            leftIcon={<RotateCcw className="size-4" />}
            onClick={() => setResetOpen(true)}
          >
            {t('doc.designer.resetToDefault')}
          </Button>
          <Button size="sm" loading={saving} leftIcon={<Save className="size-4" />} onClick={save}>
            {t('doc.designer.save')}
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-md border border-danger-600 bg-danger-50 p-3">
          <p className="mb-1 text-sm font-semibold text-danger-700">
            {t('doc.designer.validationTitle')}
          </p>
          {/* Verbatim from the shared validator — see `save()`. These are
              developer-shaped strings (`elements[3] extends outside the 794px
              page width`) and that is deliberate: they name the exact element,
              which is what an owner needs to go fix it. */}
          <ul className="list-disc pl-5 text-xs text-danger-700">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[220px_1fr_280px]">
        {/* Palette + layers */}
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('doc.designer.paletteTitle')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {catalog.elements.map((type) => (
                <Button key={type} size="sm" variant="outline" onClick={() => addElement(type)}>
                  {t(`doc.designer.element.${type}`)}
                </Button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('doc.designer.fieldsTitle')}</h3>
            <p className="mb-2 text-[11px] text-text-muted">{t('doc.designer.fieldsHint')}</p>
            <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
              {catalog.fields.map((token) => (
                <Button
                  key={token}
                  size="sm"
                  variant="ghost"
                  className="border border-border"
                  onClick={() => addElement('field', token)}
                >
                  {t(`doc.field.${token}`)}
                </Button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('doc.designer.layersTitle')}</h3>
            <p className="mb-2 text-[11px] text-text-muted">
              {t('doc.designer.elementCount', {
                count: template.elements.length,
                max: DOC_TEMPLATE_LIMITS.maxElements,
              })}
            </p>
            <ul className="max-h-64 overflow-y-auto text-sm">
              {template.elements.map((el) => (
                <li key={el.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(el.id)}
                    className={`w-full truncate rounded px-2 py-1 text-left ${
                      el.id === selectedId
                        ? 'bg-brand-50 text-brand-700'
                        : 'hover:bg-surface-sunken'
                    }`}
                  >
                    {elementLabel(el, t)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Canvas */}
        <section className="overflow-auto rounded-lg border border-border bg-surface-sunken p-4">
          <p className="mb-2 text-xs text-text-muted">{t('doc.designer.previewHint')}</p>
          <div
            className="relative mx-auto"
            style={{ width: template.width * scale, height: template.height * scale }}
            aria-label={t('doc.designer.canvasLabel')}
          >
            <DocumentRenderer template={template} data={data} scale={scale} placeholders />
            {/* The interaction layer sits ON TOP of the rendered sheet rather
                than being woven into it. That is what lets there be exactly one
                renderer (see `DocumentRenderer`'s header): the visual is the
                same markup the printer gets, and everything clickable is a
                sibling overlay computed from the same geometry. */}
            <div className="absolute inset-0">
              {template.elements.map((el) => {
                const isSelected = el.id === selectedId;
                const style: CSSProperties = {
                  position: 'absolute',
                  left: el.x * scale,
                  top: el.y * scale,
                  width: Math.max(6, el.w * scale),
                  height: Math.max(6, el.h * scale),
                };
                return (
                  <button
                    key={el.id}
                    type="button"
                    aria-label={elementLabel(el, t)}
                    aria-pressed={isSelected}
                    style={style}
                    className={`cursor-move ${
                      isSelected
                        ? 'outline outline-2 outline-brand-500'
                        : 'outline outline-1 outline-transparent hover:outline-brand-300'
                    }`}
                    onPointerDown={(e) => beginDrag(e, el, 'move')}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    // Selection is bound to THREE things on purpose. A pointer
                    // drag selects on `pointerdown` so the properties panel is
                    // already showing the right element by the time the drag
                    // ends. `focus` selects so Tab-ing through the canvas keeps
                    // the panel in step. And `click` selects because that is
                    // the event assistive technology synthesises when a user
                    // activates a control without a pointer at all — without
                    // it, a screen-reader user can reach an element and press
                    // Enter and nothing happens.
                    onClick={() => setSelectedId(el.id)}
                    onKeyDown={(e) => handleElementKeyDown(e, el)}
                    onFocus={() => setSelectedId(el.id)}
                  />
                );
              })}
              {selected && (
                // One resize grip, bottom-right. Rendered outside the element
                // button so a pointerdown on it is not also a "move" gesture —
                // nesting an interactive control inside a button is invalid
                // markup and breaks keyboard focus order besides.
                <div
                  role="presentation"
                  onPointerDown={(e) => beginDrag(e, selected, 'resize')}
                  onPointerMove={continueDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className="absolute size-3 cursor-nwse-resize rounded-sm bg-brand-500"
                  style={{
                    left: (selected.x + selected.w) * scale - 6,
                    top: (selected.y + selected.h) * scale - 6,
                  }}
                />
              )}
            </div>
          </div>
        </section>

        {/* Properties */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('doc.designer.propertiesTitle')}</h3>
            {selected && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('doc.designer.duplicate')}
                  onClick={() => duplicateElement(selected.id)}
                >
                  <Copy className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('doc.designer.deleteElement')}
                  onClick={() => removeElement(selected.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )}
          </div>
          <PropertiesPanel
            element={selected}
            kind={kind}
            page={{ width: template.width, height: template.height }}
            onPatch={(patch) => selected && patchElement(selected.id, patch)}
          />
        </section>
      </div>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t('doc.designer.resetConfirmTitle')}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={doReset}>
              {t('doc.designer.resetToDefault')}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {t('doc.designer.resetConfirmBody', { kind: t(`doc.designer.kind.${kind}`) })}
        </p>
      </Modal>
    </div>
  );
}

/**
 * What an element is CALLED in the layer list and in its accessible name.
 * A `field` names its token (that is the only thing that distinguishes two
 * otherwise identical boxes); a `text` shows its own first characters; the
 * rest fall back to their type.
 */
function elementLabel(el: DocElement, t: (key: string) => string): string {
  if (el.type === 'field' && el.field) return t(`doc.field.${el.field}`);
  if (el.type === 'text') return el.text?.slice(0, 32) || t('doc.designer.element.text');
  if (el.type === 'signature' && el.signatureRole) return t(`doc.signature.${el.signatureRole}`);
  return t(`doc.designer.element.${el.type}`);
}
