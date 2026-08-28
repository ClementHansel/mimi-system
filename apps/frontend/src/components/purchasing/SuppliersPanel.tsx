'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, EyeOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Button, Card, CardContent, EmptyState, Input, toast } from '@/components/ui';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { MasterDataIo } from '@/components/admin/MasterDataIo';
import { getSuppliers, deactivateSupplier } from './lib/api';
import { SUPPLIER_IO_COLUMNS } from './lib/io-columns';
import { SupplierFormModal } from './SupplierFormModal';
import { SupplierDetailDrawer } from './SupplierDetailDrawer';
import type { Paginated } from '@/lib/shared-types';
import type { Supplier } from './lib/types';

/** Same shape the other panels in this app use (`MasterDataPanel`, `CreateSuratJalanModal`): surface the server's message, fall back to a generic one. */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * FR-SUP-01/03/04 — the supplier master list, and the way into one supplier's
 * items, prices and purchase history.
 *
 * Lives in Pembelian rather than Admin → Master Data even though it is master
 * data, because it is worked on by the person raising purchase orders, next to
 * the PR/PO tabs they already have open. Items, categories, units, products
 * and locations remain under Admin → Master Data; supplier is the one that
 * belongs on the buying desk.
 *
 * PRICES ARE A SEPARATE PERMISSION FROM THE SUPPLIER ITSELF (D-20/FR-SUP-06):
 * `supplier.read` shows this list, `supplier.price.read` is what reveals items
 * and price history, and `supplier.price.manage` is what allows editing them.
 * Outlet roles hold none of these — they get the stripped name/contact
 * directory from a different endpoint entirely. The gating here mirrors the
 * server so a user is never shown a control that will 403.
 */
export function SuppliersPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canManage = can('supplier.manage');

  const [data, setData] = useState<Paginated<Supplier>>({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 200,
  });
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [openSupplier, setOpenSupplier] = useState<Supplier | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(false);
    getSuppliers(q.trim() || undefined)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => {
    // Debounced so typing a supplier name is not one request per keystroke.
    const handle = setTimeout(reload, 250);
    return () => clearTimeout(handle);
  }, [reload]);

  async function onDeactivate(supplier: Supplier) {
    try {
      await deactivateSupplier(supplier.id);
      toast({ title: t('purchasing.suppliers.deactivated'), variant: 'success' });
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    }
  }

  const columns: DataTableColumn<Supplier>[] = [
    { key: 'code', header: t('purchasing.suppliers.columnCode'), sortable: true },
    { key: 'name', header: t('purchasing.suppliers.columnName'), sortable: true },
    {
      key: 'contactName',
      header: t('purchasing.suppliers.columnContact'),
      render: (r) => (
        <span className="text-sm">
          {r.contactName ?? '—'}
          {r.phone && <span className="block text-xs text-text-muted">{r.phone}</span>}
        </span>
      ),
    },
    {
      key: 'paymentTermsDays',
      header: t('purchasing.suppliers.columnTerms'),
      render: (r) =>
        r.paymentTermsDays === 0
          ? t('purchasing.suppliers.termsCash')
          : t('purchasing.suppliers.termsDays', { days: r.paymentTermsDays }),
    },
    {
      key: 'outletVisible',
      header: t('purchasing.suppliers.columnOutletVisible'),
      // Not decoration: this flag is what lets outlet staff pick the supplier
      // by name on a petty-cash form. Prices and terms stay hidden regardless.
      render: (r) =>
        r.outletVisible ? (
          <span className="text-xs text-text-secondary">{t('common.yes')}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <EyeOff className="size-3.5" aria-hidden />
            {t('common.no')}
          </span>
        ),
    },
    {
      key: 'isActive',
      header: t('purchasing.suppliers.columnStatus'),
      // Same wording the other master-data tables use, rather than a
      // `StatusBadge`: there is no `supplier` status domain, and inventing one
      // for a boolean would be a worse fit than the existing convention.
      render: (r) => (r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')),
    },
    {
      key: 'id',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpenSupplier(r)}>
            {t('purchasing.suppliers.openDetail')}
          </Button>
          {canManage && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                {t('common.edit')}
              </Button>
              {r.isActive && (
                <Button size="sm" variant="ghost" onClick={() => void onDeactivate(r)}>
                  {t('purchasing.suppliers.deactivate')}
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('purchasing.suppliers.searchPlaceholder')}
            className="pl-9"
            aria-label={t('purchasing.suppliers.searchPlaceholder')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Export/import as toolbar buttons on the list they act on, not a
              separate destination (owner, 2026-08-25). `rows` is the current
              search result, which is what an operator means by "export this".

              Bulk supplier import was BLOCKED until 2026-08-27 by a backend bug
              that made every supplier write throw before it could commit — the
              same one that broke the "Tambah Supplier" button beside this. See
              `modules/supplier/supplier.service.ts`'s constructor comment. */}
          <MasterDataIo
            entity="suppliers"
            titleKey="purchasing.suppliers.title"
            rows={data.rows}
            columns={SUPPLIER_IO_COLUMNS}
            filenameBase="supplier"
            onImported={reload}
            canImport={canManage}
          />
          {canManage && (
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
              {t('purchasing.suppliers.createButton')}
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent>
            <EmptyState title={t('table.error')} />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={data}
          keyField={(r) => r.id}
          loading={loading}
          emptyTitle={t('purchasing.suppliers.empty')}
        />
      )}

      {(createOpen || editing) && (
        <SupplierFormModal
          supplier={editing}
          onClose={() => {
            setCreateOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreateOpen(false);
            setEditing(null);
            reload();
          }}
        />
      )}

      {openSupplier && (
        <SupplierDetailDrawer supplier={openSupplier} onClose={() => setOpenSupplier(null)} />
      )}
    </div>
  );
}
