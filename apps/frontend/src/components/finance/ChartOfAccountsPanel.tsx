'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Checkbox } from '@/components/ui/Checkbox';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { AccountType } from './types';
import type { Account } from './types';

/**
 * F07 finance — chart of accounts (CONTRACTS §4.17, D-04). `GET /accounts`
 * returns a plain `Account[]` (tree-ordered), not `Paginated<T>` — small
 * enough (a few dozen postable + header rows) that DataTable is fed a
 * synthetic one-page `Paginated` wrapper rather than pulled through
 * `useApiList`, which assumes a real paginated endpoint underneath it.
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const TYPE_OPTIONS = Object.values(AccountType);

export function ChartOfAccountsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const [type, setType] = useState('');
  const [active, setActive] = useState('');
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Account | null | 'new'>(null);

  function reload() {
    setLoading(true); setError(undefined);
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (active) qs.set('active', active);
    if (q) qs.set('q', q);
    const query = qs.toString();
    api.get<Account[]>(`/accounting/accounts${query ? `?${query}` : ''}`)
      .then(setAccounts)
      .catch((err) => setError(errMsg(err, t('auth.genericError'))))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [type, active, q]);

  const columns: DataTableColumn<Account>[] = [
    { key: 'code', header: t('finance.coa.columnCode') },
    { key: 'name', header: t('finance.coa.columnName') },
    { key: 'type', header: t('finance.coa.columnType'), render: (r) => t(`finance.accountType.${r.type}`) },
    { key: 'normalBalance', header: t('finance.coa.columnNormalBalance'), render: (r) => t(r.normalBalance === 'debit' ? 'finance.coa.normalBalanceDebit' : 'finance.coa.normalBalanceCredit') },
    { key: 'isPostable', header: t('finance.coa.columnPostable'), render: (r) => (r.isPostable ? t('common.yes') : t('common.no')) },
    { key: 'isActive', header: t('finance.coa.columnStatus'), render: (r) => (r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input placeholder={t('finance.coa.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="w-56" />
          <Select value={type} onValueChange={setType} placeholder={t('finance.coa.filterTypeAll')}
            options={TYPE_OPTIONS.map((v) => ({ value: v, label: t(`finance.accountType.${v}`) }))} wrapperClassName="w-40" />
          <Select value={active} onValueChange={setActive} placeholder={t('finance.coa.filterStatusAll')}
            options={[{ value: 'true', label: t('admin.users.statusActive') }, { value: 'false', label: t('admin.users.statusInactive') }]} wrapperClassName="w-40" />
        </div>
        <PermissionGate permission="accounting.coa.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>{t('finance.coa.createButton')}</Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows: accounts, total: accounts.length, page: 1, pageSize: Math.max(accounts.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('finance.coa.empty')}
        onRowClick={can('accounting.coa.manage') ? (r) => setEditing(r) : undefined}
      />

      {editing && (
        <AccountFormModal
          account={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function AccountFormModal({ account, accounts, onClose, onSaved }: {
  account: Account | null; accounts: Account[]; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(account?.code ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<string>(account?.type ?? AccountType.ASSET);
  const [normalBalance, setNormalBalance] = useState<'debit' | 'credit'>(account?.normalBalance ?? 'debit');
  const [parentId, setParentId] = useState(account?.parentId ?? '');
  const [isPostable, setIsPostable] = useState(account?.isPostable ?? true);
  const [isActive, setIsActive] = useState(account?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true); setError(null);
    try {
      if (account) {
        await api.patch(`/accounting/accounts/${account.id}`, { name, isActive });
      } else {
        await api.post('/accounting/accounts', { code, name, type, normalBalance, parentId: parentId || undefined, isPostable });
      }
      toast({ title: t(account ? 'finance.coa.updateSuccess' : 'finance.coa.createSuccess'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally { setSubmitting(false); }
  }

  return (
    <Modal open onClose={onClose} title={t(account ? 'finance.coa.editTitle' : 'finance.coa.createTitle')}
      footer={<><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={submit} loading={submitting} disabled={!code || !name}>{t('common.save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {error && <p className="col-span-2 text-sm text-danger-600">{error}</p>}
        <Input label={t('finance.coa.code')} value={code} onChange={(e) => setCode(e.target.value)} disabled={!!account} required />
        <Input label={t('finance.coa.name')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label={t('finance.coa.type')} value={type} onValueChange={setType} disabled={!!account}
          options={TYPE_OPTIONS.map((v) => ({ value: v, label: t(`finance.accountType.${v}`) }))} />
        <Select label={t('finance.coa.columnNormalBalance')} value={normalBalance} onValueChange={(v) => setNormalBalance(v as 'debit' | 'credit')} disabled={!!account}
          options={[{ value: 'debit', label: t('finance.coa.normalBalanceDebit') }, { value: 'credit', label: t('finance.coa.normalBalanceCredit') }]} />
        {!account && (
          <Select label={t('finance.coa.parent')} value={parentId} onValueChange={setParentId} placeholder={t('admin.masterData.categories.noParent')}
            options={accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))} />
        )}
        {account ? (
          <div className="col-span-2"><Checkbox label={t('admin.users.statusActive')} checked={isActive} onCheckedChange={setIsActive} /></div>
        ) : (
          <div className="col-span-2"><Checkbox label={t('finance.coa.columnPostable')} checked={isPostable} onCheckedChange={setIsPostable} /></div>
        )}
      </div>
    </Modal>
  );
}
