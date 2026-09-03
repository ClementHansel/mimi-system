'use client';

import { useMemo, useState } from 'react';
import { Download, Upload, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, type Paginated } from '@/lib/api';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FileUpload } from '@/components/ui/FileUpload';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { toast } from '@/components/ui/Toast';
import { downloadImportTemplate } from './lib/download-template';
import type {
  ImportEntityName,
  ImportPreviewResult,
  ImportPreviewRow,
  ImportCommitResult,
} from './types';
import { apiErrorText } from '@/lib/api-error';

/**
 * F?? `importData` — bulk import with a schema-derived template (owner,
 * 2026-08-24: master data is hand-typed one row at a time today; "add bulk
 * import with template download, so all the import would follow DB so no
 * errors").
 *
 * Three explicit steps, each a real round trip to the server — never a
 * client-side guess at what the server will accept:
 *   1. download the template (`GET .../template`, columns straight from the
 *      backend's schema definition — this component hardcodes nothing about
 *      what a valid row looks like);
 *   2. upload → preview (`POST .../preview`) — writes nothing, ever; every
 *      row comes back would-create / would-update / error, with the exact
 *      column named for any error;
 *   3. commit (`POST .../commit`) — disabled while `errorCount > 0` or no
 *      preview has run for the CURRENTLY selected file, so it is never
 *      possible to commit a file this component never actually validated.
 *
 * WHICH ENTITY IS THE CALLER'S TO SAY, not this component's. It used to open
 * on an entity dropdown from its own route, which asked the operator to
 * re-state something the screen they came from already knew. It is now mounted
 * from the Master Data tab that owns the data — Item, Kategori & Satuan, or
 * Produk & Resep — so `entity` arrives as a prop and there is no picker to get
 * wrong. Nothing here hardcodes what a valid row looks like either way: the
 * template and the validation both come from the server's own schema.
 */
export function ImportPanel({
  entity,
  onCommitted,
}: {
  entity: ImportEntityName;
  /** Called after a successful commit so the host list can reload — imported rows are invisible otherwise. */
  onCommitted?: () => void;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [committed, setCommitted] = useState<ImportCommitResult | null>(null);
  /** The exact `File` the current `preview` result was validated for — the guard that keeps "commit" from ever applying to a file it never actually checked (changing the entity or picking a new file clears this). */
  const [previewedFor, setPreviewedFor] = useState<File | null>(null);

  const canCommit =
    preview !== null &&
    preview.errorCount === 0 &&
    preview.fileErrors.length === 0 &&
    file[0] === previewedFor;

  function resetResults() {
    setPreview(null);
    setCommitted(null);
    setPreviewedFor(null);
  }

  async function handleDownloadTemplate() {
    setDownloading(true);
    try {
      await downloadImportTemplate(entity);
    } catch (err) {
      toast({
        variant: 'danger',
        title: t('importData.templateFailed'),
        description: apiErrorText(err),
      });
    } finally {
      setDownloading(false);
    }
  }

  async function handlePreview() {
    const chosen = file[0];
    if (!chosen) return;
    setPreviewing(true);
    setCommitted(null);
    try {
      const formData = new FormData();
      formData.append('file', chosen);
      const result = await api.upload<ImportPreviewResult>(`/import/${entity}/preview`, formData);
      setPreview(result);
      setPreviewedFor(chosen);
    } catch (err) {
      toast({
        variant: 'danger',
        title: t('importData.previewFailed'),
        description: apiErrorText(err),
      });
      setPreview(null);
      setPreviewedFor(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    const chosen = file[0];
    if (!chosen || !canCommit) return;
    setCommitting(true);
    try {
      const formData = new FormData();
      formData.append('file', chosen);
      const result = await api.upload<ImportCommitResult>(`/import/${entity}/commit`, formData);
      setCommitted(result);
      onCommitted?.();
      toast({
        variant: 'success',
        title: t('importData.commitSuccess'),
        description: t('importData.commitSuccessDetail', {
          inserted: result.inserted,
          updated: result.updated,
        }),
      });
    } catch (err) {
      // Atomic on the server (all-or-nothing) — a rejected commit here means
      // NOTHING was written, so there is nothing to reconcile client-side.
      toast({
        variant: 'danger',
        title: t('importData.commitFailed'),
        description: apiErrorText(err),
      });
    } finally {
      setCommitting(false);
    }
  }

  const rowsAsPaginated: Paginated<ImportPreviewRow> = useMemo(() => {
    const rows = preview?.rows ?? [];
    return { rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) };
  }, [preview]);

  const columns: DataTableColumn<ImportPreviewRow>[] = [
    { key: 'line', header: t('importData.preview.columnLine'), width: '80px' },
    {
      key: 'naturalKey',
      header: t('importData.preview.columnKey'),
      render: (r) => r.naturalKey ?? '—',
    },
    {
      key: 'status',
      header: t('importData.preview.columnStatus'),
      render: (r) => <RowStatusBadge status={r.status} />,
    },
    {
      key: 'errors',
      header: t('importData.preview.columnError'),
      render: (r) =>
        r.errors.length === 0 ? (
          '—'
        ) : (
          <ul className="flex flex-col gap-0.5">
            {r.errors.map((e, i) => (
              <li key={i} className="text-sm text-danger-600">
                {e.column ? <span className="font-mono text-xs">[{e.column}]</span> : null}{' '}
                {e.message}
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardDescription>{t('importData.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">{t('importData.step1')}</span>
            <Button
              variant="outline"
              leftIcon={<Download className="size-4" />}
              onClick={handleDownloadTemplate}
              loading={downloading}
              className="self-start"
            >
              {t('importData.downloadTemplate')}
            </Button>
            <p className="text-sm text-text-muted">{t('importData.templateHint')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">{t('importData.step2')}</span>
            <FileUpload
              accept=".csv,text/csv"
              value={file}
              onChange={(files) => {
                setFile(files);
                resetResults();
              }}
              hint={t('importData.uploadHint')}
              maxSizeMb={5}
            />
            <Button
              leftIcon={<Upload className="size-4" />}
              onClick={handlePreview}
              loading={previewing}
              disabled={file.length === 0}
              className="self-start"
            >
              {t('importData.runPreview')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && preview.fileErrors.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <p className="flex items-center gap-2 font-medium text-danger-600">
              <XCircle className="size-4" aria-hidden />
              {t('importData.fileErrorsTitle')}
            </p>
            <ul className="flex flex-col gap-1">
              {preview.fileErrors.map((e, i) => (
                <li key={i} className="text-sm text-danger-600">
                  {e.column ? <span className="font-mono text-xs">[{e.column}]</span> : null}{' '}
                  {e.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {preview && preview.fileErrors.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('importData.step3')}</CardTitle>
            <CardDescription>
              {t('importData.previewSummary', {
                total: preview.totalDataRows,
                create: preview.createCount,
                update: preview.updateCount,
                errors: preview.errorCount,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={columns}
              data={rowsAsPaginated}
              keyField={(r) => String(r.line)}
              emptyTitle={t('importData.preview.empty')}
            />
          </CardContent>
          <CardFooter className="justify-between">
            {preview.errorCount > 0 ? (
              <p className="flex items-center gap-2 text-sm text-danger-600">
                <AlertTriangle className="size-4" aria-hidden />
                {t('importData.hasErrorsHint')}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-success-700">
                <CheckCircle2 className="size-4" aria-hidden />
                {t('importData.readyToCommit')}
              </p>
            )}
            <Button
              onClick={handleCommit}
              loading={committing}
              disabled={!canCommit}
              variant="primary"
            >
              {t('importData.commit')}
            </Button>
          </CardFooter>
        </Card>
      )}

      {committed && (
        <Card>
          <CardContent className="flex items-center gap-2 text-success-700">
            <CheckCircle2 className="size-5" aria-hidden />
            <span>
              {t('importData.commitSuccessDetail', {
                inserted: committed.inserted,
                updated: committed.updated,
              })}
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RowStatusBadge({ status }: { status: ImportPreviewRow['status'] }) {
  const { t } = useI18n();
  if (status === 'would-create') {
    return <Badge variant="success">{t('importData.status.wouldCreate')}</Badge>;
  }
  if (status === 'would-update') {
    return <Badge variant="info">{t('importData.status.wouldUpdate')}</Badge>;
  }
  return <Badge variant="danger">{t('importData.status.error')}</Badge>;
}
