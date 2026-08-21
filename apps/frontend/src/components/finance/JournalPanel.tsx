'use client';

import { useEffect, useState } from 'react';
import { Plus, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { formatMoney } from '@/lib/formatters';
import { fmtDate } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Textarea';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { useApiList } from '@/components/admin/useApiList';
import { JournalDescription } from './JournalDescription';
import { sumMoney, moneyEquals, isZeroMoney } from './lib/money';
import type { Account, JournalEntry, Money } from './types';

/**
 * F07 finance — journal (CONTRACTS §4.17). "Every journal entry balances" is
 * the one thing that must be right here: the manual-post form computes a
 * live debit/credit total (via `sumMoney`, `BigInt`-cents, never a float sum)
 * and disables Submit until they match — the backend still rejects an
 * unbalanced entry (`ERR_UNBALANCED_ENTRY`), this is just the UI half of
 * "impossible to create an unbalanced entry from here".
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function JournalPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<JournalEntry>('/accounting/journal', {
    from,
    to,
    source,
    accountCode,
    page,
    pageSize,
  });

  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    api
      .get<Account[]>('/accounting/accounts?active=true')
      .then(setAccounts)
      .catch(() => {});
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [postOpen, setPostOpen] = useState(false);

  const columns: DataTableColumn<JournalEntry>[] = [
    { key: 'entryNumber', header: t('finance.journal.columnNumber') },
    {
      key: 'entryDate',
      header: t('finance.journal.columnDate'),
      render: (r) => fmtDate(r.entryDate),
    },
    {
      key: 'description',
      header: t('finance.journal.columnDescription'),
      // System entries arrive as `outlet_ingredient_usage — usage_day <uuid>`;
      // this renders them as a sentence and keeps the raw string on hover.
      render: (r) => <JournalDescription description={r.description} />,
    },
    {
      key: 'source',
      header: t('finance.journal.columnSource'),
      render: (r) =>
        t(r.source === 'manual' ? 'finance.journal.sourceManual' : 'finance.journal.sourceSystem'),
    },
    {
      key: 'status',
      header: t('finance.journal.columnStatus'),
      render: (r) => <StatusBadge domain="journalEntry" status={r.status} />,
    },
    {
      key: 'locationName',
      header: t('finance.journal.columnLocation'),
      render: (r) => r.locationName ?? '—',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label={t('common.from')}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-40"
          />
          <Input
            label={t('common.to')}
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-40"
          />
          <Select
            value={source}
            onValueChange={(v) => {
              setSource(v);
              setPage(1);
            }}
            placeholder={t('finance.journal.filterSourceAll')}
            options={[
              { value: 'manual', label: t('finance.journal.sourceManual') },
              { value: 'system', label: t('finance.journal.sourceSystem') },
            ]}
            wrapperClassName="w-40"
          />
          <Input
            placeholder={t('finance.journal.filterAccountCode')}
            value={accountCode}
            onChange={(e) => {
              setAccountCode(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-36"
          />
        </div>
        <PermissionGate permission="accounting.journal.post">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setPostOpen(true)}>
            {t('finance.journal.postButton')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('finance.journal.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {postOpen && (
        <PostEntryModal
          accounts={accounts}
          onClose={() => setPostOpen(false)}
          onPosted={() => {
            setPostOpen(false);
            reload();
            toast({ title: t('finance.journal.postSuccess'), variant: 'success' });
          }}
        />
      )}

      {selectedId && (
        <EntryDrawer
          id={selectedId}
          canReverse={can('accounting.journal.reverse')}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

interface DraftLine {
  accountCode: string;
  debit: Money;
  credit: Money;
  memo: string;
}

function PostEntryModal({
  accounts,
  onClose,
  onPosted,
}: {
  accounts: Account[];
  onClose: () => void;
  onPosted: () => void;
}) {
  const { t } = useI18n();
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { accountCode: accounts[0]?.code ?? '', debit: '0.00', credit: '0.00', memo: '' },
    { accountCode: accounts[0]?.code ?? '', debit: '0.00', credit: '0.00', memo: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const totalDebit = sumMoney(lines.map((l) => l.debit));
  const totalCredit = sumMoney(lines.map((l) => l.credit));
  const balanced = moneyEquals(totalDebit, totalCredit) && !isZeroMoney(totalDebit);

  function addLine() {
    setLines((ls) => [
      ...ls,
      { accountCode: accounts[0]?.code ?? '', debit: '0.00', credit: '0.00', memo: '' },
    ]);
  }
  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }
  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/accounting/journal', {
        entryDate,
        description,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo || undefined,
        })),
      });
      onPosted();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={t('finance.journal.postTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!balanced || !description || lines.some((l) => !l.accountCode)}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t('finance.journal.entryDate')}
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            required
          />
          <Input
            label={t('finance.journal.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          {lines.map((line, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <Select
                label={idx === 0 ? t('finance.journal.lineAccount') : undefined}
                value={line.accountCode}
                onValueChange={(v) => updateLine(idx, { accountCode: v })}
                options={accounts
                  .filter((a) => a.isPostable)
                  .map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))}
                wrapperClassName="flex-1"
              />
              <MoneyInput
                label={idx === 0 ? t('finance.journal.lineDebit') : undefined}
                value={line.debit}
                onChange={(v) => updateLine(idx, { debit: v ?? '0.00' })}
                wrapperClassName="w-36"
              />
              <MoneyInput
                label={idx === 0 ? t('finance.journal.lineCredit') : undefined}
                value={line.credit}
                onChange={(v) => updateLine(idx, { credit: v ?? '0.00' })}
                wrapperClassName="w-36"
              />
              <Input
                label={idx === 0 ? t('finance.journal.lineMemo') : undefined}
                value={line.memo}
                onChange={(e) => updateLine(idx, { memo: e.target.value })}
                wrapperClassName="flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeLine(idx)}
                disabled={lines.length <= 2}
              >
                {t('admin.masterData.products.removeLine')}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={addLine}
            className="self-start"
            leftIcon={<Plus className="size-4" />}
          >
            {t('admin.masterData.products.addLine')}
          </Button>
        </div>

        <div
          className={`flex items-center justify-between rounded-md border p-3 text-sm ${balanced ? 'border-success-200 bg-success-50' : 'border-danger-200 bg-danger-50'}`}
        >
          <span className="flex items-center gap-1.5 font-medium">
            {balanced ? (
              <CheckCircle2 className="size-4 text-success-700" />
            ) : (
              <AlertTriangle className="size-4 text-danger-700" />
            )}
            {balanced ? t('finance.journal.balanced') : t('finance.journal.unbalanced')}
          </span>
          <span className="tabular-nums">
            {t('finance.journal.debitCreditTotals', {
              debit: formatMoney(totalDebit, { cents: 'always' }),
              credit: formatMoney(totalCredit, { cents: 'always' }),
            })}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function EntryDrawer({
  id,
  canReverse,
  onClose,
  onChanged,
}: {
  id: string;
  canReverse: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get<JournalEntry>(`/accounting/journal/${id}`)
      .then(setEntry)
      .finally(() => setLoading(false));
  }, [id]);

  const totalDebit = entry ? sumMoney(entry.lines.map((l) => l.debit)) : '0.00';
  const totalCredit = entry ? sumMoney(entry.lines.map((l) => l.credit)) : '0.00';
  const balanced = moneyEquals(totalDebit, totalCredit);

  async function doReverse() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/journal/${id}/reverse`, { reason });
      toast({ title: t('finance.journal.reverseSuccess'), variant: 'success' });
      setReverseOpen(false);
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={entry?.entryNumber ?? t('finance.journal.detailTitle')}
      size="lg"
    >
      {loading || !entry ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <StatusBadge domain="journalEntry" status={entry.status} />
            <span className="text-sm text-text-muted">{fmtDate(entry.entryDate)}</span>
          </div>
          <JournalDescription description={entry.description} variant="detail" />

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken">
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">
                    {t('finance.journal.lineAccount')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">
                    {t('finance.journal.lineDebit')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">
                    {t('finance.journal.lineCredit')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">
                    {t('finance.journal.lineMemo')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((l) => (
                  <tr key={l.lineNo} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      {l.accountCode} — {l.accountName}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(l.debit, { cents: 'always' })}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(l.credit, { cents: 'always' })}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{l.memo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-3 py-2">{t('finance.journal.totals')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(totalDebit, { cents: 'always' })}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(totalCredit, { cents: 'always' })}
                  </td>
                  <td className="px-3 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          <div
            className={`flex items-center gap-1.5 rounded-md border p-2.5 text-sm font-medium ${balanced ? 'border-success-200 bg-success-50 text-success-700' : 'border-danger-200 bg-danger-50 text-danger-700'}`}
          >
            {balanced ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
            {balanced ? t('finance.journal.balanced') : t('finance.journal.unbalanced')}
          </div>

          {error && <p className="text-sm text-danger-600">{error}</p>}

          {entry.status === 'posted' && canReverse && (
            <Button
              variant="outline"
              leftIcon={<RotateCcw className="size-4" />}
              onClick={() => setReverseOpen(true)}
              className="self-start"
            >
              {t('finance.journal.reverseButton')}
            </Button>
          )}
        </div>
      )}

      {reverseOpen && (
        <Modal
          open
          onClose={() => setReverseOpen(false)}
          title={t('finance.journal.reverseTitle')}
          footer={
            <>
              <Button variant="outline" onClick={() => setReverseOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={doReverse} loading={busy} disabled={!reason}>
                {t('finance.journal.reverseButton')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('finance.journal.reverseReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Modal>
      )}
    </Drawer>
  );
}
