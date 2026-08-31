'use client';

import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Upload, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FileUpload } from '@/components/ui/FileUpload';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { toast } from '@/components/ui/Toast';
import { downloadCsv, toCsv } from '@/lib/export/csv';
import { parseCsv, type CsvRecord } from '@/lib/import/csv-parse';
import { errMsg } from '@/lib/api-error';

/** One column the template declares and the mapper may read. */
export interface LineImportColumn {
  /** The header text, exactly as the template writes it and the export produces it. */
  header: string;
  /** Shown in the template's guidance row — what a valid cell looks like. */
  hint: string;
  /** Whether a row missing this cell can still be mapped (the mapper still decides). */
  required?: boolean;
}

/** What the caller's mapper says about one CSV row. */
export type LineImportRowResult<TLine> =
  | { ok: true; line: TLine }
  | { ok: false; error: string }
  /** Recognised and deliberately ignored — a subtotal row, a zero count. */
  | { ok: true; line: null };

/**
 * Bulk-fill a document's LINES from a CSV, as a toolbar button beside "add
 * line".
 *
 * WHY THIS EXISTS SEPARATELY FROM `MasterDataIo`. That one wraps
 * `ImportPanel`, which previews and commits against `/api/import/:entity` —
 * right for master data upserted on a natural key, wrong for a transactional
 * document (see `lib/import/csv-parse.ts`'s header for the full reasoning).
 * This component never writes anything: it parses, shows every row it could and
 * could not read, and hands the good ones back through `onLines` so they land
 * in the create form the operator was already looking at. The document is then
 * submitted by the same button, through the same endpoint, with the same
 * validation and the same mandatory photo as a hand-typed one.
 *
 * THE ERRORS ARE THE POINT. A stock count typed into a spreadsheet by three
 * people will have a misspelt SKU, a blank quantity and a row for an item that
 * was deactivated last month. Silently dropping those is how a count sheet
 * comes out short and nobody knows which line went missing, so every rejected
 * row is listed with its file line number and the reason, the good rows are
 * still importable, and the count of each is stated before anything is applied.
 *
 * REPLACE OR APPEND is the operator's call, not a default: importing into a
 * form that already has hand-typed lines could reasonably mean either, and
 * guessing wrong destroys work.
 */
export function LineImportButton<TLine>({
  /** Heading for the modal — the document being filled, in the operator's words. */
  title,
  columns,
  /** `<templateBase>-template.csv` and the same base for the guidance row. */
  templateBase,
  /** Called per non-blank row, in file order. Resolve names/SKUs to ids here. */
  mapRow,
  /** Applied lines, in file order. `mode` is what the operator chose. */
  onLines,
  /** Whether the form already holds lines — decides if the append/replace choice is even offered. */
  hasExistingLines = false,
  disabled,
  /** Extra guidance shown above the picker (e.g. "areas must already exist"). */
  note,
}: {
  title: string;
  columns: LineImportColumn[];
  templateBase: string;
  mapRow: (row: CsvRecord) => LineImportRowResult<TLine>;
  onLines: (lines: TLine[], mode: 'append' | 'replace') => void;
  hasExistingLines?: boolean;
  disabled?: boolean;
  note?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState('');
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<{
    lines: TLine[];
    errors: { line: number; message: string }[];
    skipped: number;
    /** Headers the file had that the template does not declare — a likely wrong file. */
    unknownHeaders: string[];
    /** Declared headers the file is missing entirely. */
    missingHeaders: string[];
  } | null>(null);
  /** The exact text `result` was computed from, so "apply" can never act on a stale parse. */
  const parsedFrom = useRef<string | null>(null);

  const headerSet = useMemo(
    () => new Set(columns.map((c) => c.header.trim().toLowerCase())),
    [columns],
  );

  function reset() {
    setFiles([]);
    setPasted('');
    setResult(null);
    parsedFrom.current = null;
  }

  function downloadTemplate() {
    // Header row + ONE guidance row, which `parseCsv` will hand back to the
    // mapper as an ordinary row on re-import. That is fine and deliberate: the
    // mapper rejects it (no such SKU), so it appears in the error list as line
    // 2 with a reason, which is a clearer instruction to delete it than a
    // silent skip would be.
    const csv = toCsv<Record<string, string>>(
      [Object.fromEntries(columns.map((c) => [c.header, c.hint]))],
      columns.map((c) => ({ key: c.header, header: c.header })),
    );
    downloadCsv(`${templateBase}-template.csv`, csv);
  }

  function runParse(text: string) {
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0) {
      setResult({
        lines: [],
        errors: [{ line: 1, message: t('lineImport.emptyFile') }],
        skipped: 0,
        unknownHeaders: [],
        missingHeaders: columns.map((c) => c.header),
      });
      parsedFrom.current = text;
      return;
    }

    const fileHeaders = parsed.headers.map((h) => h.trim().toLowerCase());
    const lines: TLine[] = [];
    const errors: { line: number; message: string }[] = [];
    let skipped = 0;

    for (const row of parsed.rows) {
      if (row.isBlank) {
        skipped += 1;
        continue;
      }
      let mapped: LineImportRowResult<TLine>;
      try {
        mapped = mapRow(row);
      } catch (err) {
        // A mapper that throws is a bug, but one bad row must not take the
        // whole file down — the operator still gets the other 199 lines.
        mapped = { ok: false, error: errMsg(err, t('table.error')) };
      }
      if (!mapped.ok) errors.push({ line: row.line, message: mapped.error });
      else if (mapped.line === null) skipped += 1;
      else lines.push(mapped.line);
    }

    setResult({
      lines,
      errors,
      skipped,
      unknownHeaders: parsed.headers.filter((h) => !headerSet.has(h.trim().toLowerCase())),
      missingHeaders: columns
        .filter((c) => !fileHeaders.includes(c.header.trim().toLowerCase()))
        .map((c) => c.header),
    });
    parsedFrom.current = text;
  }

  async function parseSelection() {
    setParsing(true);
    try {
      const file = files[0];
      if (file) {
        // Read the TEXT (not `readCsvFile`) so `parsedFrom` can hold exactly
        // what produced this result — that string is the staleness guard.
        runParse(await file.text());
      } else if (pasted.trim() !== '') {
        runParse(pasted);
      }
    } catch {
      toast({ title: t('lineImport.readError'), variant: 'danger' });
    } finally {
      setParsing(false);
    }
  }

  function apply(mode: 'append' | 'replace') {
    if (!result || result.lines.length === 0) return;
    onLines(result.lines, mode);
    toast({
      title: t('lineImport.applied', { count: result.lines.length }),
      variant: 'success',
    });
    setOpen(false);
    reset();
  }

  const currentText = files[0] ? null : pasted;
  // "Apply" is only ever enabled for a parse of the CURRENT selection — the
  // same guard `ImportPanel` puts between preview and commit, for the same
  // reason: nothing may be applied that was not actually checked.
  const stale =
    result !== null &&
    parsedFrom.current !== null &&
    currentText !== null &&
    parsedFrom.current !== currentText;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        leftIcon={<Upload className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        {t('lineImport.openButton')}
      </Button>

      {open && (
        <Modal
          open
          size="lg"
          onClose={() => {
            setOpen(false);
            reset();
          }}
          title={t('lineImport.modalTitle', { entity: title })}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">{t('lineImport.intro')}</p>
            {note && (
              <p className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-sm text-text-secondary">
                <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
                {note}
              </p>
            )}

            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                leftIcon={<Download className="size-4" aria-hidden />}
                onClick={downloadTemplate}
              >
                {t('lineImport.downloadTemplate')}
              </Button>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                    <th className="px-3 py-2">{t('lineImport.column')}</th>
                    <th className="px-3 py-2">{t('lineImport.expected')}</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col) => (
                    <tr key={col.header} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-medium whitespace-nowrap text-text-primary">
                        {col.header}
                        {col.required && <span className="text-danger-600"> *</span>}
                      </td>
                      <td className="px-3 py-2 text-text-muted">{col.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <FileUpload
              label={t('lineImport.fileLabel')}
              hint={t('lineImport.fileHint')}
              accept=".csv,text/csv"
              value={files}
              onChange={(next) => {
                setFiles(next);
                setResult(null);
                parsedFrom.current = null;
              }}
            />

            {/* Paste, as well as upload. The realistic bulk edit is a block of
                cells already highlighted in a spreadsheet, and making someone
                Save As a file first for a ten-line count is friction with no
                payoff — `parseCsv` detects the tab delimiter a spreadsheet
                copy puts on the clipboard. */}
            {files.length === 0 && (
              <Textarea
                label={t('lineImport.pasteLabel')}
                hint={t('lineImport.pasteHint')}
                rows={5}
                value={pasted}
                onChange={(e) => {
                  setPasted(e.target.value);
                  setResult(null);
                  parsedFrom.current = null;
                }}
              />
            )}

            <div>
              <Button
                type="button"
                loading={parsing}
                disabled={files.length === 0 && pasted.trim() === ''}
                onClick={parseSelection}
              >
                {t('lineImport.check')}
              </Button>
            </div>

            {result && (
              <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" size="sm">
                    <CheckCircle2 className="size-3" aria-hidden />
                    {t('lineImport.readyCount', { count: result.lines.length })}
                  </Badge>
                  {result.errors.length > 0 && (
                    <Badge variant="danger" size="sm">
                      <XCircle className="size-3" aria-hidden />
                      {t('lineImport.errorCount', { count: result.errors.length })}
                    </Badge>
                  )}
                  {result.skipped > 0 && (
                    <Badge variant="neutral" size="sm">
                      {t('lineImport.skippedCount', { count: result.skipped })}
                    </Badge>
                  )}
                </div>

                {result.missingHeaders.length > 0 && (
                  <p className="text-sm text-warning-700">
                    {t('lineImport.missingHeaders', { headers: result.missingHeaders.join(', ') })}
                  </p>
                )}
                {result.unknownHeaders.length > 0 && (
                  <p className="text-sm text-text-muted">
                    {t('lineImport.unknownHeaders', { headers: result.unknownHeaders.join(', ') })}
                  </p>
                )}

                {result.errors.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                    <table className="w-full border-collapse text-sm">
                      <tbody>
                        {result.errors.map((err) => (
                          <tr
                            key={`${err.line}-${err.message}`}
                            className="border-b border-border last:border-0"
                          >
                            <td className="w-24 px-3 py-1.5 whitespace-nowrap text-text-muted">
                              {t('lineImport.lineNo', { line: err.line })}
                            </td>
                            <td className="px-3 py-1.5 text-text-primary">{err.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {stale && <p className="text-sm text-warning-700">{t('lineImport.stale')}</p>}

                {/* Rows with errors are LEFT OUT, they never block the good
                    ones: a 200-line count sheet with two bad rows is still
                    worth importing 198 of, and the two are on screen to fix by
                    hand. This is the opposite call from `ImportPanel`, which
                    refuses to commit any row while one is in error — there,
                    the write is irreversible master data; here it is a draft
                    the operator reviews before submitting. */}
                {result.lines.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {hasExistingLines ? (
                      <>
                        <Button variant="outline" disabled={stale} onClick={() => apply('append')}>
                          {t('lineImport.append')}
                        </Button>
                        <Button disabled={stale} onClick={() => apply('replace')}>
                          {t('lineImport.replace')}
                        </Button>
                      </>
                    ) : (
                      <Button disabled={stale} onClick={() => apply('replace')}>
                        {t('lineImport.applyLines', { count: result.lines.length })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
