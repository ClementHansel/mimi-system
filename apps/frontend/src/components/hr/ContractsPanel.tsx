'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { FilePlus2, PenLine, Trash2, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DataTable,
  EmptyState,
  Input,
  Modal,
  MoneyInput,
  Select,
  StatusBadge,
  Textarea,
  toast,
} from '@/components/ui';
import { MasterDataIo } from '@/components/admin/MasterDataIo';
import { listEmployees, listLocationCodesById } from './lib/hr-api';
import {
  createContract,
  deleteContract,
  listContracts,
  listContractSignatures,
  listLocationsForContractForm,
  signContract,
  terminateContract,
  updateContract,
} from './lib/contracts-api';
import { contractIoColumns, type ContractExportRow } from './lib/contracts-io-columns';
import type { Contract, ContractSignature } from './lib/types';
import type { Paginated } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

const CONTRACT_TYPES = ['pkwt', 'pkwtt', 'probation', 'internship'] as const;
const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated'] as const;
const SIGN_METHODS = ['wet_ink_scan', 'digital', 'in_person_witnessed'] as const;

/**
 * F08 `hr` — employment contracts CRUD, per-party signatures, and
 * import/export (owner ask, 2026-08-27: "the contract for employee need to
 * be able to be made, signed by all, and will be linked to each employee.
 * (need crud), import and export").
 *
 * SIGNING IS NOT A FORM FIELD. `status: 'active'` cannot be set directly from
 * this screen's edit form — the DB trigger `contracts_require_signatures_
 * before_active` (migration 252) refuses it until BOTH required parties (the
 * employee, and at least one company signer) have a `contract_signatures`
 * row, and a contract is always CREATED as `draft` (nothing can reference a
 * signature row for a contract that does not exist yet). So the only path to
 * `active` here is: create as draft -> "Catat Tanda Tangan" for `employee`
 * -> "Catat Tanda Tangan" for `company` -> a status edit to `active`, which
 * the last step in `ContractFormModal` offers ONLY once `fullySigned` is
 * true — matching, not working around, the database's own gate.
 *
 * DELETE IS DRAFT-AND-UNSIGNED ONLY. `ContractsService.remove` (backend)
 * refuses anything else — a signed or non-draft contract is a legal record.
 * The delete button here is hidden for every other row rather than shown and
 * left to 400.
 *
 * Mounts standalone (per this round's instruction — the owner is wiring the
 * `hr` tab in separately), same as `SalaryComponentsPanel`.
 */
export function ContractsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canManage = can('hr.contract.manage');

  const [data, setData] = useState<Paginated<Contract>>({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState('');
  const [contractType, setContractType] = useState('');
  const [expiringWithinDays, setExpiringWithinDays] = useState('');

  const [employees, setEmployees] = useState<
    { id: string; name: string; employeeNumber: string }[]
  >([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [locationCodeById, setLocationCodeById] = useState<Map<string, string>>(new Map());
  const [exportRows, setExportRows] = useState<ContractExportRow[]>([]);

  const [viewing, setViewing] = useState<Contract | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [signing, setSigning] = useState<Contract | null>(null);
  const [terminating, setTerminating] = useState<Contract | null>(null);
  const [deleting, setDeleting] = useState<Contract | null>(null);

  function reload() {
    setLoading(true);
    setError(false);
    listContracts({
      status: status || undefined,
      contractType: contractType || undefined,
      expiringWithinDays: expiringWithinDays ? Number(expiringWithinDays) : undefined,
      page: data.page,
    })
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [status, contractType, expiringWithinDays, data.page]);

  useEffect(() => {
    listEmployees({ page: 1 })
      .then((res) =>
        setEmployees(
          res.rows.map((e) => ({ id: e.id, name: e.name, employeeNumber: e.employeeNumber })),
        ),
      )
      .catch(() => setEmployees([]));
    listLocationsForContractForm().then(setLocations);
    // Same endpoint, keyed by CODE this time — what the importer's `location`
    // column (and this panel's export columns, `contractIoColumns`) resolve
    // against, distinct from `locations` above (id -> NAME, for the form).
    listLocationCodesById().then(setLocationCodeById);
  }, []);

  /**
   * Full snapshot for import/export, independent of the on-screen filters —
   * same "bulk edit means the whole list, not today's filter" reasoning
   * `EmployeesPanel.loadExportSnapshot` documents, bounded the same way.
   */
  async function loadExportSnapshot() {
    const all: Contract[] = [];
    for (let page = 1; page <= 40; page += 1) {
      const res = await listContracts({ page });
      all.push(...res.rows);
      if (res.rows.length === 0 || all.length >= res.total) break;
    }
    setExportRows(all.map((c) => ({ ...c, employeeNumber: c.employeeNumber })));
  }
  useEffect(() => {
    loadExportSnapshot();
    // Mount-once: the export snapshot is refreshed explicitly after a write
    // (`refreshAfterWrite`), not by a dependency change.
  }, []);

  function refreshAfterWrite() {
    reload();
    loadExportSnapshot();
  }

  async function onDelete(contract: Contract) {
    try {
      await deleteContract(contract.id);
      toast({ title: t('hr.contracts.deleteSuccess'), variant: 'success' });
      setDeleting(null);
      refreshAfterWrite();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {/*
          One `items-end` row of label+control pairs, with the hints BELOW it
          rather than inside a field.

          The hint placement is the whole fix, not a tidy-up. `items-end`
          aligns the bottom of each child, and a field carrying a `hint` is
          two lines taller than its neighbours — so the two dropdowns were
          being shoved down until their inputs sat level with the hint's last
          line, leaving the empty band above them that made this bar look
          broken. Same reason `expiringFilter` lost its second line of label.
        */}
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t('hr.contracts.columnStatus')}
              value={status}
              onValueChange={setStatus}
              placeholder={t('hr.contracts.status.allStatuses')}
              options={CONTRACT_STATUSES.map((s) => ({
                value: s,
                label: t(`status.contract.${s}`),
              }))}
              wrapperClassName="w-44"
            />
            <Select
              label={t('hr.contracts.contractType')}
              value={contractType}
              onValueChange={setContractType}
              placeholder={t('hr.contracts.status.allStatuses')}
              options={CONTRACT_TYPES.map((c) => ({
                value: c,
                label: t(`hr.contracts.type.${c}`),
              }))}
              wrapperClassName="w-52"
            />
            <Input
              label={t('hr.contracts.expiringFilter')}
              type="number"
              min={0}
              value={expiringWithinDays}
              onChange={(e) => setExpiringWithinDays(e.target.value)}
              wrapperClassName="w-44"
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <MasterDataIo
                entity="employment_contracts"
                titleKey="hr.contracts.title"
                rows={exportRows}
                columns={contractIoColumns(locationCodeById)}
                filenameBase="kontrak_kerja"
                onImported={refreshAfterWrite}
                canImport={canManage}
              />
              {canManage && (
                <Button
                  leftIcon={<FilePlus2 className="size-4" />}
                  onClick={() => setCreateOpen(true)}
                >
                  {t('hr.contracts.createButton')}
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-text-secondary">
            {t('hr.contracts.expiringFilterHint')} {t('hr.contracts.detailHint')}
          </p>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent>
            <EmptyState title={t('table.error')} />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          /*
            EIGHT columns, not twelve, and every one of them `nowrap`.
            Jabatan / Gaji Pokok / Penempatan / the signature sentence all
            moved into `ContractDetailModal` — at twelve columns the table
            wrapped `PKWT (Waktu Tertentu)` and `Gudang Pusat Balikpapan`
            onto three lines each and pushed the row's own action buttons
            past the right edge of the viewport, where they could not be
            clicked at all. The row itself is the way in now (`onRowClick`),
            which is also where those actions live.
          */
          columns={[
            {
              key: 'contractNumber',
              header: t('hr.contracts.columnNumber'),
              render: (r) => (
                <span className="whitespace-nowrap font-medium text-text-primary">
                  {r.contractNumber}
                </span>
              ),
            },
            {
              key: 'employeeName',
              header: t('hr.contracts.columnEmployee'),
              render: (r) => <span className="whitespace-nowrap">{r.employeeName}</span>,
            },
            {
              key: 'contractType',
              header: t('hr.contracts.columnType'),
              render: (r) => (
                <span className="whitespace-nowrap">
                  {t(`hr.contracts.typeShort.${r.contractType}`)}
                </span>
              ),
            },
            {
              key: 'startDate',
              header: t('hr.contracts.columnPeriod'),
              render: (r) => (
                <span className="whitespace-nowrap text-sm">
                  {fmtDate(r.startDate)} — {r.endDate ? fmtDate(r.endDate) : '∞'}
                </span>
              ),
            },
            {
              key: 'status',
              header: t('hr.contracts.columnStatus'),
              render: (r) => <StatusBadge domain="contract" status={r.status} size="sm" />,
            },
            {
              key: 'fullySigned',
              header: t('hr.contracts.columnSigned'),
              render: (r) => (
                <Badge variant={r.fullySigned ? 'success' : 'warning'} size="sm">
                  {r.fullySigned
                    ? t('hr.contracts.signatures.shortComplete')
                    : t('hr.contracts.signatures.shortIncomplete')}
                </Badge>
              ),
            },
            {
              key: 'daysUntilExpiry',
              header: t('hr.contracts.columnExpiry'),
              render: (r) => (
                <span className="whitespace-nowrap">
                  {r.daysUntilExpiry !== null ? r.daysUntilExpiry : '—'}
                </span>
              ),
            },
          ]}
          data={data}
          keyField={(r) => r.id}
          loading={loading}
          emptyTitle={t('hr.contracts.empty')}
          onRowClick={setViewing}
          onPageChange={(page) => setData((d) => ({ ...d, page }))}
        />
      )}

      {viewing && (
        <ContractDetailModal
          contract={viewing}
          canManage={canManage}
          onClose={() => setViewing(null)}
          // Each hand-off closes the detail rather than stacking a second
          // dialog on top of it: `Modal` renders its own overlay, and two of
          // them means the Escape key closes the wrong one.
          onSign={() => {
            setSigning(viewing);
            setViewing(null);
          }}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
          onTerminate={() => {
            setTerminating(viewing);
            setViewing(null);
          }}
          onDelete={() => {
            setDeleting(viewing);
            setViewing(null);
          }}
        />
      )}

      {(createOpen || editing) && (
        <ContractFormModal
          contract={editing}
          employees={employees}
          locations={locations}
          onClose={() => {
            setCreateOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreateOpen(false);
            setEditing(null);
            refreshAfterWrite();
          }}
        />
      )}

      {signing && (
        <SignContractModal
          contract={signing}
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            refreshAfterWrite();
          }}
        />
      )}

      {terminating && (
        <TerminateContractModal
          contract={terminating}
          onClose={() => setTerminating(null)}
          onTerminated={() => {
            setTerminating(null);
            refreshAfterWrite();
          }}
        />
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('hr.contracts.deleteButton')}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void onDelete(deleting)}>
                {t('hr.contracts.deleteButton')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-secondary">
            {t('hr.contracts.deleteConfirm', { number: deleting.contractNumber })}
          </p>
        </Modal>
      )}
    </div>
  );
}

/** One label/value pair of `ContractDetailModal`. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-sm text-text-primary">{children}</dd>
    </div>
  );
}

/**
 * The whole contract, opened by clicking its row.
 *
 * This is where the columns the list dropped went — Jabatan, Gaji Pokok,
 * Penempatan, Catatan, the termination reason, and the actual signature
 * ledger (`contract_signatures`, which the list could only ever summarise as
 * a yes/no). It is also where every row action now lives: at twelve columns
 * those buttons rendered past the right edge of the table and were
 * unreachable, and a dialog that already names the contract is a safer place
 * to press "Putus Kontrak" than a cramped cell in a list of forty.
 *
 * The status/permission guards are copied from the row actions they replace,
 * not relaxed: terminate is `active`-only, edit is draft-or-active, and
 * delete stays draft-and-unsigned because `ContractsService.remove` refuses
 * anything else (a signed contract is a legal record).
 */
function ContractDetailModal({
  contract,
  canManage,
  onClose,
  onSign,
  onEdit,
  onTerminate,
  onDelete,
}: {
  contract: Contract;
  canManage: boolean;
  onClose: () => void;
  onSign: () => void;
  onEdit: () => void;
  onTerminate: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [signatures, setSignatures] = useState<ContractSignature[] | null>(null);

  useEffect(() => {
    listContractSignatures(contract.id)
      .then(setSignatures)
      .catch(() => setSignatures([]));
  }, [contract.id]);

  const canDelete =
    canManage &&
    contract.status === 'draft' &&
    !contract.employeeSigned &&
    contract.companySignerCount === 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('hr.contracts.detailTitle', { number: contract.contractNumber })}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {canDelete && (
            <Button
              variant="ghost"
              className="mr-auto"
              leftIcon={<Trash2 className="size-3.5" />}
              onClick={onDelete}
            >
              {t('hr.contracts.deleteButton')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          {canManage && contract.status === 'active' && (
            <Button
              variant="outline"
              leftIcon={<XCircle className="size-3.5" />}
              onClick={onTerminate}
            >
              {t('hr.contracts.terminate.button')}
            </Button>
          )}
          {canManage && (contract.status === 'draft' || contract.status === 'active') && (
            <Button variant="outline" leftIcon={<PenLine className="size-3.5" />} onClick={onEdit}>
              {t('common.edit')}
            </Button>
          )}
          {canManage && contract.status !== 'terminated' && (
            <Button onClick={onSign}>{t('hr.contracts.signatures.signButton')}</Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge domain="contract" status={contract.status} size="sm" />
          <Badge variant={contract.fullySigned ? 'success' : 'warning'} size="sm">
            {contract.fullySigned
              ? t('hr.contracts.signatures.fullySigned')
              : t('hr.contracts.signatures.shortIncomplete')}
          </Badge>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <DetailRow label={t('hr.contracts.employee')}>
            {contract.employeeName}{' '}
            <span className="text-text-muted">({contract.employeeNumber})</span>
          </DetailRow>
          <DetailRow label={t('hr.contracts.contractType')}>
            {t(`hr.contracts.type.${contract.contractType}`)}
          </DetailRow>
          <DetailRow label={t('hr.contracts.position')}>{contract.position}</DetailRow>
          <DetailRow label={t('hr.contracts.location')}>
            {contract.locationName ?? t('hr.contracts.locationPlaceholder')}
          </DetailRow>
          <DetailRow label={t('hr.contracts.baseSalary')}>
            {contract.baseSalary ? formatMoney(contract.baseSalary) : '—'}
          </DetailRow>
          <DetailRow label={t('hr.contracts.columnPeriod')}>
            {fmtDate(contract.startDate)} — {contract.endDate ? fmtDate(contract.endDate) : '∞'}
          </DetailRow>
          <DetailRow label={t('hr.contracts.columnExpiry')}>
            {contract.daysUntilExpiry !== null ? contract.daysUntilExpiry : '—'}
          </DetailRow>
          {contract.signedAt && (
            <DetailRow label={t('hr.contracts.signedAtLegacy')}>
              {fmtDate(contract.signedAt)}
            </DetailRow>
          )}
          {contract.terminationReason && (
            <DetailRow label={t('hr.contracts.terminate.reason')}>
              {contract.terminationReason}
            </DetailRow>
          )}
          {contract.notes && (
            <DetailRow label={t('hr.contracts.notes')}>{contract.notes}</DetailRow>
          )}
        </dl>

        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-text-primary">
            {t('hr.contracts.signatures.title')}
          </h4>
          {signatures === null ? (
            <div className="h-12 animate-pulse rounded-md bg-surface-sunken" />
          ) : signatures.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('hr.contracts.signatures.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1 rounded-md bg-surface-sunken p-3 text-xs text-text-secondary">
              {signatures.map((sig) => (
                <li key={sig.id}>
                  {t(
                    `hr.contracts.signatures.${sig.partyType === 'employee' ? 'employeeParty' : 'companyParty'}`,
                  )}
                  {' — '}
                  {sig.signerName}{' '}
                  {t('hr.contracts.signatures.signedAt', { when: fmtDateTime(sig.signedAt) })}
                  {' · '}
                  {t(`hr.contracts.signatures.method.${sig.method}`)}
                </li>
              ))}
            </ul>
          )}
          {!contract.fullySigned && (
            <p className="text-xs text-text-muted">{t('hr.contracts.signatures.activateHint')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ContractFormModal({
  contract,
  employees,
  locations,
  onClose,
  onSaved,
}: {
  contract: Contract | null;
  employees: { id: string; name: string; employeeNumber: string }[];
  locations: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isEdit = contract !== null;

  const [employeeId, setEmployeeId] = useState(contract?.employeeId ?? '');
  const [contractType, setContractType] = useState(contract?.contractType ?? 'pkwt');
  const [position, setPosition] = useState(contract?.position ?? '');
  const [locationId, setLocationId] = useState(contract?.locationId ?? '');
  const [baseSalary, setBaseSalary] = useState<string | null>(contract?.baseSalary ?? null);
  const [startDate, setStartDate] = useState(contract?.startDate ?? '');
  const [endDate, setEndDate] = useState(contract?.endDate ?? '');
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [activateNow, setActivateNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPkwtt = contractType === 'pkwtt';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        await updateContract(contract.id, {
          contractType,
          position,
          locationId: locationId || null,
          baseSalary: baseSalary,
          startDate,
          endDate: isPkwtt ? null : endDate || null,
          notes: notes || null,
          ...(activateNow ? { status: 'active' } : {}),
        });
      } else {
        await createContract({
          employeeId,
          contractType,
          position,
          locationId: locationId || undefined,
          baseSalary: baseSalary ?? undefined,
          startDate,
          endDate: isPkwtt ? undefined : endDate || undefined,
          notes: notes || undefined,
        });
      }
      toast({
        title: t(isEdit ? 'hr.contracts.updateSuccess' : 'hr.contracts.createSuccess'),
        variant: 'success',
      });
      onSaved();
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
      title={t(isEdit ? 'hr.contracts.editTitle' : 'hr.contracts.createTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!isEdit && (
          <Select
            label={t('hr.contracts.employee')}
            value={employeeId}
            onValueChange={setEmployeeId}
            required
            options={employees.map((e) => ({
              value: e.id,
              label: `${e.employeeNumber} — ${e.name}`,
            }))}
            wrapperClassName="sm:col-span-2"
          />
        )}
        <Select
          label={t('hr.contracts.contractType')}
          value={contractType}
          onValueChange={(v) => setContractType(v as Contract['contractType'])}
          required
          options={CONTRACT_TYPES.map((c) => ({ value: c, label: t(`hr.contracts.type.${c}`) }))}
        />
        <Input
          label={t('hr.contracts.position')}
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          required
        />
        <Select
          label={t('hr.contracts.location')}
          value={locationId ?? ''}
          onValueChange={setLocationId}
          placeholder={t('hr.contracts.locationPlaceholder')}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
        />
        <MoneyInput
          label={t('hr.contracts.baseSalary')}
          value={baseSalary}
          onChange={setBaseSalary}
        />
        <Input
          type="date"
          label={t('hr.contracts.startDate')}
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          required
        />
        {!isPkwtt && (
          <Input
            type="date"
            label={t('hr.contracts.endDate')}
            value={endDate ?? ''}
            onChange={(e) => setEndDate(e.target.value)}
            hint={t('hr.contracts.endDateHint')}
            required
          />
        )}
        <Textarea
          label={t('hr.contracts.notes')}
          value={notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
          wrapperClassName="sm:col-span-2"
        />
      </div>

      {/* Activation is offered ONLY when both required parties have already
          signed (`fullySigned`) — matching, not working around, the DB
          trigger (252) that refuses `status = 'active'` otherwise. */}
      {isEdit && contract.status === 'draft' && (
        <label className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={activateNow}
            disabled={!contract.fullySigned}
            onChange={(e) => setActivateNow(e.target.checked)}
          />
          {contract.fullySigned
            ? t('hr.contracts.signatures.fullySigned')
            : t('hr.contracts.signatures.activateHint')}
        </label>
      )}

      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </Modal>
  );
}

function SignContractModal({
  contract,
  onClose,
  onSigned,
}: {
  contract: Contract;
  onClose: () => void;
  onSigned: () => void;
}) {
  const { t } = useI18n();
  const [party, setParty] = useState<'employee' | 'company'>(
    contract.employeeSigned ? 'company' : 'employee',
  );
  const [method, setMethod] = useState<(typeof SIGN_METHODS)[number]>('wet_ink_scan');
  const [signedAt, setSignedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<ContractSignature[] | null>(null);

  useEffect(() => {
    listContractSignatures(contract.id)
      .then(setSignatures)
      .catch(() => setSignatures([]));
  }, [contract.id]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signContract(contract.id, {
        party,
        method,
        signedAt: signedAt || undefined,
        notes: notes || undefined,
      });
      toast({ title: t('hr.contracts.signatures.signSuccess'), variant: 'success' });
      onSigned();
    } catch (err) {
      setError(errMsg(err, t('hr.contracts.signatures.alreadySigned')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('hr.contracts.signatures.signTitle', { number: contract.contractNumber })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            {t('hr.contracts.signatures.signButton')}
          </Button>
        </>
      }
    >
      {signatures && signatures.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1 rounded-md bg-surface-sunken p-3 text-xs text-text-secondary">
          {signatures.map((s) => (
            <li key={s.id}>
              {t(
                `hr.contracts.signatures.${s.partyType === 'employee' ? 'employeeParty' : 'companyParty'}`,
              )}
              {' — '}
              {s.signerName}{' '}
              {t('hr.contracts.signatures.signedAt', { when: fmtDateTime(s.signedAt) })}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3">
        <Select
          label={t('hr.contracts.signatures.signParty')}
          value={party}
          onValueChange={(v) => setParty(v as 'employee' | 'company')}
          options={[
            {
              value: 'employee',
              label: t('hr.contracts.signatures.employeeParty'),
              disabled: contract.employeeSigned,
            },
            { value: 'company', label: t('hr.contracts.signatures.companyParty') },
          ]}
        />
        <Select
          label={t('hr.contracts.signatures.signMethod')}
          value={method}
          onValueChange={(v) => setMethod(v as (typeof SIGN_METHODS)[number])}
          options={SIGN_METHODS.map((m) => ({
            value: m,
            label: t(`hr.contracts.signatures.method.${m}`),
          }))}
        />
        <Input
          type="datetime-local"
          label={t('hr.contracts.signatures.signSignedAt')}
          value={signedAt}
          onChange={(e) => setSignedAt(e.target.value)}
          hint={t('hr.contracts.signatures.signSignedAtHint')}
        />
        <Textarea
          label={t('hr.contracts.signatures.signNotes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </Modal>
  );
}

function TerminateContractModal({
  contract,
  onClose,
  onTerminated,
}: {
  contract: Contract;
  onClose: () => void;
  onTerminated: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await terminateContract(contract.id, reason, endDate || undefined);
      toast({ title: t('hr.contracts.terminate.success'), variant: 'success' });
      onTerminated();
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
      title={t('hr.contracts.terminate.title', { number: contract.contractNumber })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!reason}>
            {t('hr.contracts.terminate.button')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Textarea
          label={t('hr.contracts.terminate.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <Input
          type="date"
          label={t('hr.contracts.terminate.endDate')}
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          hint={t('hr.contracts.terminate.endDateHint')}
        />
      </div>
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </Modal>
  );
}
