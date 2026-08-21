'use client';

import { useEffect, useState } from 'react';
import { ArrowRightLeft, Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { useApiList } from '@/components/admin/useApiList';
import { getLocations, createPurchaseRequestFromReplenishment } from './lib/api';
import type { LocationOption } from './lib/types';
// `Replenishment` is re-exported through the outlet module's own types file,
// which is this app's seam onto `@mimi/shared` for the replenishment shapes.
import type { Paginated } from '@/lib/shared-types';
import type { Replenishment } from '@/components/outlet/lib/types';

/**
 * "Permintaan Outlet" — the office's view of what the stores are asking for,
 * and the one place an outlet request becomes a purchase request.
 *
 * Owner's ruling (2026-08-21): "Need to have a place to see requests from
 * stores properly and able to convert that to PR, and later PR to PO." Until
 * now these requests existed only in Gudang's approval queue, so Pembelian —
 * the people who actually buy what the warehouse cannot ship — had no sight of
 * them at all and retyped the lines from a WhatsApp message.
 *
 * What conversion does NOT do, on purpose:
 *
 *  - It does not change the outlet's request. That request has its own life in
 *    gudang (fulfil it from stock), and buying the goods in is the OTHER answer
 *    to it, not a state change of it. Both answers can be true at once for
 *    different lines.
 *  - It does not price anything. The new PR is a DRAFT with `est_price` 0; the
 *    office fills in prices and a supplier, then submits. A conversion that
 *    invented figures would look like a quote.
 *
 * The link survives on the PR (`sourceReplenishmentNumber` in its drawer), so
 * "which store asked for this?" is answerable from the document afterwards.
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Statuses worth converting. A `draft` request has not been sent by the outlet
 * yet, and a `cancelled`/`rejected` one was decided against — buying against
 * either would be acting on a request nobody made.
 */
const CONVERTIBLE = new Set(['submitted', 'approved', 'partially_fulfilled', 'fulfilled']);

export function OutletRequestsPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState('submitted');
  const [locationId, setLocationId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [converting, setConverting] = useState<Replenishment | null>(null);

  const { data, loading, error, reload } = useApiList<Replenishment>('/replenishment', {
    status,
    locationId,
    page,
    pageSize,
  });

  useEffect(() => {
    getLocations()
      .then((r: Paginated<LocationOption>) => setLocations(r.rows))
      .catch(() => {});
  }, []);

  const columns: DataTableColumn<Replenishment>[] = [
    { key: 'requestNumber', header: t('purchasing.outletRequests.columnNumber') },
    { key: 'locationName', header: t('purchasing.outletRequests.columnLocation') },
    {
      key: 'lines',
      header: t('purchasing.outletRequests.columnLines'),
      align: 'right',
      render: (r) => r.lines.length,
    },
    {
      key: 'neededBy',
      header: t('purchasing.outletRequests.columnNeededBy'),
      render: (r) => (r.neededBy ? fmtDate(r.neededBy) : '—'),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="replenishment" status={r.status} size="sm" />,
    },
    {
      key: 'convert',
      header: '',
      render: (r) => (
        <PermissionGate permission="purchasing.pr.create">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<ArrowRightLeft className="size-4" />}
            disabled={!CONVERTIBLE.has(r.status)}
            // A request the outlet has not sent yet, or one already decided
            // against, is not something to buy against — the button says why
            // rather than silently doing nothing.
            title={
              CONVERTIBLE.has(r.status) ? undefined : t('purchasing.outletRequests.notConvertible')
            }
            onClick={() => setConverting(r)}
          >
            {t('purchasing.outletRequests.convertButton')}
          </Button>
        </PermissionGate>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">{t('purchasing.outletRequests.intro')}</p>

      <div className="flex flex-wrap items-end gap-2">
        <SearchableSelect
          label={t('purchasing.outletRequests.filterLocation')}
          value={locationId}
          onValueChange={(v) => {
            setLocationId(v);
            setPage(1);
          }}
          options={locations.map((l) => ({
            value: l.id,
            label: l.name,
            hint: l.city ?? undefined,
          }))}
          placeholder={t('purchasing.filterLocationAll')}
          wrapperClassName="w-64"
        />
        <Select
          label={t('common.status')}
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          placeholder={t('purchasing.outletRequests.filterStatusAll')}
          options={[
            { value: 'submitted', label: t('status.replenishment.submitted') },
            { value: 'approved', label: t('status.replenishment.approved') },
            { value: 'partially_fulfilled', label: t('status.replenishment.partially_fulfilled') },
            { value: 'fulfilled', label: t('status.replenishment.fulfilled') },
            { value: 'rejected', label: t('status.replenishment.rejected') },
          ]}
          wrapperClassName="w-48"
        />
      </div>

      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('purchasing.outletRequests.empty')}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />

      {converting && (
        <ConvertModal
          request={converting}
          locations={locations}
          onClose={() => setConverting(null)}
          onConverted={() => {
            setConverting(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ConvertModal({
  request,
  locations,
  onClose,
  onConverted,
}: {
  request: Replenishment;
  locations: LocationOption[];
  onClose: () => void;
  onConverted: () => void;
}) {
  const { t } = useI18n();
  // Destination defaults to the only warehouse when there is exactly one, which
  // is today's reality (Balikpapan) — but it is still a shown, editable field,
  // because a second warehouse is a deployment change, not a rewrite.
  const warehouses = locations.filter((l) => l.type === 'warehouse');
  const [locationId, setLocationId] = useState(warehouses.length === 1 ? warehouses[0]!.id : '');
  const [neededBy, setNeededBy] = useState(request.neededBy ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function convert() {
    if (!locationId) {
      setError(t('validation.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pr = await createPurchaseRequestFromReplenishment({
        replenishmentId: request.id,
        locationId,
        neededBy: neededBy || undefined,
        notes: notes || undefined,
      });
      toast({
        title: t('purchasing.outletRequests.convertSuccess', { number: pr.prNumber }),
        variant: 'success',
      });
      onConverted();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('purchasing.outletRequests.convertTitle', { number: request.requestNumber })}
      description={t('purchasing.outletRequests.convertDescription')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={convert} loading={busy} disabled={!locationId}>
            {t('purchasing.outletRequests.convertConfirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}

        <div className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm">
          <Store className="size-4 flex-none text-text-muted" aria-hidden />
          <span className="text-text-secondary">
            {request.locationName} ·{' '}
            {t('purchasing.outletRequests.lineCount', {
              count: request.lines.length,
            })}
          </span>
        </div>

        {request.lines.length === 0 ? (
          <EmptyState title={t('purchasing.outletRequests.noLines')} size="sm" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-1 font-normal">{t('purchasing.requests.item')}</th>
                <th className="pb-1 text-right font-normal">{t('purchasing.requests.qty')}</th>
              </tr>
            </thead>
            <tbody>
              {request.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="py-1.5 text-text-primary">{l.itemName}</td>
                  <td className="py-1.5 text-right text-text-primary">
                    {l.qtyRequested} {l.unitCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <SearchableSelect
            label={t('purchasing.requests.destination')}
            value={locationId}
            onValueChange={setLocationId}
            options={(warehouses.length > 0 ? warehouses : locations).map((l) => ({
              value: l.id,
              label: l.name,
              hint: l.city ?? undefined,
            }))}
            placeholder={t('common.selectPlaceholder')}
            hint={t('purchasing.requests.destinationHint')}
            required
          />
          <Input
            label={t('purchasing.requests.neededBy')}
            type="date"
            value={neededBy}
            onChange={(e) => setNeededBy(e.target.value)}
          />
        </div>

        <Input
          label={t('purchasing.outletRequests.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('purchasing.outletRequests.notesPlaceholder')}
        />

        <p className="text-xs text-text-muted">{t('purchasing.outletRequests.priceHint')}</p>
      </div>
    </Modal>
  );
}
