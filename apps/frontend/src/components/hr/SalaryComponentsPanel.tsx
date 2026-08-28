'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  EmptyState,
  Input,
  Modal,
  MoneyInput,
  SearchableSelect,
  Select,
  toast,
} from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { MasterDataIo } from '@/components/admin/MasterDataIo';
import { isoToday, sortByEffectiveFromDesc, windowState } from './lib/effective-window';
import {
  createPayrollComponent,
  getEmployeeComponents,
  listEmployees,
  listPayrollComponents,
  putEmployeeComponents,
  updatePayrollComponent,
} from './lib/hr-api';
import { SALARY_COMPONENT_IO_COLUMNS } from './lib/salary-components-io';
import type { EmployeeComponentAssignment, PayrollComponent } from './lib/types';

/** Same shape every other master-data panel in this app uses to surface the server's own message. */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// `CreateComponentDto` only ever accepts these two — `'employer_cost'` (BPJS
// employer shares) is a real `type` value the LIST can return, but nothing in
// the payroll module's own DTOs lets it be created that way, so the create
// form never offers it either (see `createPayrollComponent`'s doc comment).
const CREATE_TYPES = ['earning', 'deduction'] as const;
const CALC_METHODS = ['fixed', 'per_day', 'per_hour', 'formula', 'manual'] as const;

/** The edit form's read-only display still needs a typed starting value for the (disabled-in-edit) create-only `calcMethod` state — falls back to `'fixed'` for a value this union somehow doesn't recognize, which never happens against a real API response. */
function initialCalcMethod(component: PayrollComponent | null): (typeof CALC_METHODS)[number] {
  const value = component?.calcMethod;
  return (CALC_METHODS as readonly string[]).includes(value ?? '')
    ? (value as (typeof CALC_METHODS)[number])
    : 'fixed';
}

/**
 * F08 `hr`/`payroll` — the salary component MASTER (allowances/deductions,
 * CONTRACTS §4.15 PIN-07/POUT-09, `payroll.component.manage`) plus the
 * per-employee assignment surface that makes the master useful (PIN-03..06,
 * `GET`/`PUT /payroll/employees/:employeeId/components`). Both live in this
 * one file: the master defines WHAT components exist, the assignment section
 * is WHO gets a custom amount for one of them, and setting up a new hire's
 * `tunjangan jabatan` needs both without leaving the tab.
 *
 * TWO SERVER-ENFORCED IMMUTABILITY RULES this UI makes unmistakable rather
 * than lets someone attempt and get rejected (`ComponentsService.update`,
 * `UpdateComponentDto`):
 *  - `type`/`calcMethod` cannot change after a component is created —
 *    `UpdateComponentDto` doesn't even declare the fields, so the edit form
 *    shows them as plain read-only text (never a disabled input, which reads
 *    as "you could if only…" rather than "this is fixed") and the update
 *    call never carries them.
 *  - a system component's (`isSystem`) `name` cannot change at all — the
 *    server 403s an update whose body carries `name` for a system row, so
 *    the edit form shows the name as read-only text for those rows and the
 *    update call omits `name` entirely rather than sending it unchanged.
 *
 * There is no DELETE anywhere in this file — the table has none, and a
 * component referenced by a past payroll run must never be hard-deletable.
 * `isActive` (exposed on `GET` as of the `components.service.ts` fix this
 * ticket shipped — see the report) is the sanctioned way to retire one.
 */
export function SalaryComponentsPanel() {
  const { can } = usePermissions();
  const canManage = can('payroll.component.manage');

  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    setLoading(true);
    listPayrollComponents()
      .then(setComponents)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  return (
    <div className="flex flex-col gap-6">
      <ComponentsMasterCard
        components={components}
        loading={loading}
        canManage={canManage}
        onChanged={reload}
      />
      <EmployeeComponentsCard components={components} canManage={canManage} />
    </div>
  );
}

// ── master list ──────────────────────────────────────────────────────────

function ComponentsMasterCard({
  components,
  loading,
  canManage,
  onChanged,
}: {
  components: PayrollComponent[];
  loading: boolean;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PayrollComponent | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return components;
    return components.filter(
      (c) => c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
    );
  }, [components, q]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>{t('hr.components.masterTitle')}</CardTitle>
          <CardDescription>{t('hr.components.masterDescription')}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Rows/columns mirror the `salary_components` importer header-for-header
              (`lib/salary-components-io.ts`), so an export is a valid import file. */}
          <MasterDataIo
            entity="salary_components"
            titleKey="hr.components.title"
            rows={components}
            columns={SALARY_COMPONENT_IO_COLUMNS}
            filenameBase="komponen-gaji"
            onImported={onChanged}
            canImport={canManage}
          />
          {canManage && (
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
              {t('hr.components.createButton')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input
          placeholder={t('hr.components.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="max-w-sm"
        />
        <DataTable
          columns={[
            { key: 'code', header: t('hr.components.columnCode') },
            {
              key: 'name',
              header: t('hr.components.columnName'),
              render: (r) => (
                <span className="inline-flex items-center gap-1.5">
                  {r.name}
                  {r.isSystem && (
                    <Badge variant="neutral" size="sm">
                      {t('hr.components.systemBadge')}
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              key: 'type',
              header: t('hr.components.columnType'),
              render: (r) => t(`hr.components.typeLabel.${r.type}`),
            },
            {
              key: 'calcMethod',
              header: t('hr.components.columnCalcMethod'),
              render: (r) => t(`hr.components.calcMethodLabel.${r.calcMethod}`),
            },
            {
              key: 'defaultAmount',
              header: t('hr.components.columnDefaultAmount'),
              render: (r) => formatMoney(r.defaultAmount),
              align: 'right',
            },
            {
              key: 'isActive',
              header: t('hr.components.columnStatus'),
              render: (r) => (
                <Badge variant={r.isActive ? 'success' : 'neutral'} size="sm">
                  {t(r.isActive ? 'hr.components.statusActive' : 'hr.components.statusInactive')}
                </Badge>
              ),
            },
          ]}
          data={{
            rows: filtered,
            total: filtered.length,
            page: 1,
            pageSize: Math.max(filtered.length, 1),
          }}
          keyField={(r) => r.id}
          loading={loading}
          onRowClick={canManage ? (r) => setEditing(r) : undefined}
        />
      </CardContent>

      {(createOpen || editing) && (
        <ComponentFormModal
          component={editing}
          onClose={() => {
            setCreateOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreateOpen(false);
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function ComponentFormModal({
  component,
  onClose,
  onSaved,
}: {
  component: PayrollComponent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(component?.code ?? '');
  const [name, setName] = useState(component?.name ?? '');
  const [type, setType] = useState<(typeof CREATE_TYPES)[number]>(
    component?.type === 'deduction' ? 'deduction' : 'earning',
  );
  const [calcMethod, setCalcMethod] = useState<(typeof CALC_METHODS)[number]>(
    initialCalcMethod(component),
  );
  const [defaultAmount, setDefaultAmount] = useState<string | null>(
    component?.defaultAmount ?? null,
  );
  const [isActive, setIsActive] = useState(component?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      if (component) {
        // `type`/`calcMethod` never appear here — this is the one place that
        // matters, not just the read-only rendering below. `name` is included
        // ONLY for a non-system row: the server 403s an update DTO that
        // carries `name` at all for `isSystem` rows, so this omits the key
        // rather than sending the unchanged value.
        await updatePayrollComponent(component.id, {
          defaultAmount: defaultAmount ?? undefined,
          isActive,
          ...(component.isSystem ? {} : { name }),
        });
      } else {
        await createPayrollComponent({
          code,
          name,
          type,
          calcMethod,
          defaultAmount: defaultAmount ?? undefined,
        });
      }
      toast({
        title: t(component ? 'hr.components.updateSuccess' : 'hr.components.createSuccess'),
        variant: 'success',
      });
      onSaved();
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
      title={
        component
          ? t('hr.components.editTitle', { name: component.name })
          : t('hr.components.createTitle')
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!component && (!code.trim() || !name.trim())}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-danger-600">{error}</p>}

        {component ? (
          <ReadOnlyField label={t('hr.components.fieldCode')} value={component.code} />
        ) : (
          <Input
            label={t('hr.components.fieldCode')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        )}

        {component?.isSystem ? (
          <ReadOnlyField
            label={t('hr.components.fieldName')}
            value={component.name}
            hint={t('hr.components.systemLockedNameHint')}
          />
        ) : (
          <Input
            label={t('hr.components.fieldName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}

        {component ? (
          <ReadOnlyField
            label={t('hr.components.fieldType')}
            value={t(`hr.components.typeLabel.${component.type}`)}
            hint={t('hr.components.immutableAfterCreateHint')}
          />
        ) : (
          <Select
            label={t('hr.components.fieldType')}
            value={type}
            onValueChange={(v) => setType(v as (typeof CREATE_TYPES)[number])}
            options={CREATE_TYPES.map((v) => ({
              value: v,
              label: t(`hr.components.typeLabel.${v}`),
            }))}
          />
        )}

        {component ? (
          <ReadOnlyField
            label={t('hr.components.fieldCalcMethod')}
            value={t(`hr.components.calcMethodLabel.${component.calcMethod}`)}
          />
        ) : (
          <Select
            label={t('hr.components.fieldCalcMethod')}
            value={calcMethod}
            onValueChange={(v) => setCalcMethod(v as (typeof CALC_METHODS)[number])}
            options={CALC_METHODS.map((v) => ({
              value: v,
              label: t(`hr.components.calcMethodLabel.${v}`),
            }))}
          />
        )}

        <MoneyInput
          label={t('hr.components.fieldDefaultAmount')}
          value={defaultAmount}
          onChange={setDefaultAmount}
        />

        {component && (
          <Checkbox
            label={t('hr.components.isActiveLabel')}
            checked={isActive}
            onCheckedChange={setIsActive}
          />
        )}
      </div>
    </Modal>
  );
}

function ReadOnlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      <span className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
        {value}
      </span>
      {hint && <span className="text-xs text-text-muted">{hint}</span>}
    </div>
  );
}

// ── per-employee assignment ─────────────────────────────────────────────

interface DraftAssignmentRow {
  componentId: string;
  amount: string | null;
}

function EmployeeComponentsCard({
  components,
  canManage,
}: {
  components: PayrollComponent[];
  canManage: boolean;
}) {
  const { t } = useI18n();
  const [employeeOptions, setEmployeeOptions] = useState<
    { value: string; label: string; hint: string }[]
  >([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [employeeId, setEmployeeId] = useState('');
  const [assignments, setAssignments] = useState<EmployeeComponentAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draftRows, setDraftRows] = useState<DraftAssignmentRow[]>([
    { componentId: '', amount: null },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Bounded page walk (same idiom as `EmployeesPanel.loadExportSnapshot`)
      // so the picker offers every employee, not just the first 50, without
      // firing an unbounded number of requests against a server that ignores
      // `page`.
      const all: { id: string; name: string; employeeNumber: string }[] = [];
      for (let page = 1; page <= 40; page += 1) {
        const res = await listEmployees({ page }).catch(() => null);
        if (!res) break;
        all.push(...res.rows);
        if (res.rows.length === 0 || all.length >= res.total) break;
      }
      if (!cancelled) {
        setEmployeeOptions(
          all.map((e) => ({ value: e.id, label: e.name, hint: e.employeeNumber })),
        );
        setEmployeesLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function reloadAssignments(id: string) {
    setLoading(true);
    getEmployeeComponents(id)
      .then(setAssignments)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (employeeId) reloadAssignments(employeeId);
    else setAssignments([]);
    // Deliberately keyed on `employeeId` alone — `reloadAssignments` is
    // redefined every render but only ever reads its own `id` argument, so
    // re-running this effect for that reason would just refetch on every
    // unrelated re-render.
  }, [employeeId]);

  const today = useMemo(() => isoToday(), []);
  const sorted = useMemo(() => sortByEffectiveFromDesc(assignments), [assignments]);
  const componentByCode = useMemo(() => new Map(components.map((c) => [c.code, c])), [components]);
  // Only ACTIVE components are offered for a new assignment — an inactive one
  // was retired on purpose, and this picker is for setting up new custom
  // amounts, not for reopening a retired line. (Every existing assignment
  // still shows in the history table below regardless of its component's
  // current status.)
  const activeComponentOptions = useMemo(
    () =>
      components
        .filter((c) => c.isActive)
        .map((c) => ({ value: c.id, label: c.name, hint: c.code })),
    [components],
  );

  function updateDraftRow(i: number, patch: Partial<DraftAssignmentRow>) {
    setDraftRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (!employeeId) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const rows = draftRows.filter((r) => r.componentId);
      await putEmployeeComponents(
        employeeId,
        rows.map((r) => ({
          componentId: r.componentId,
          amount: r.amount ?? undefined,
          effectiveFrom,
        })),
      );
      toast({ title: t('hr.components.saveAssignmentsSuccess'), variant: 'success' });
      setShowForm(false);
      setEffectiveFrom('');
      setDraftRows([{ componentId: '', amount: null }]);
      reloadAssignments(employeeId);
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('hr.components.assignmentTitle')}</CardTitle>
        <CardDescription>{t('hr.components.assignmentDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SearchableSelect
          label={t('hr.components.selectEmployee')}
          placeholder={t('hr.components.selectEmployeePlaceholder')}
          value={employeeId}
          onValueChange={setEmployeeId}
          options={employeeOptions}
          disabled={employeesLoading}
          wrapperClassName="max-w-sm"
        />

        {!employeeId ? (
          <EmptyState icon={Users} title={t('hr.components.noEmployeeSelected')} size="sm" />
        ) : (
          <>
            {canManage && (
              <div>
                <Button
                  size="sm"
                  variant={showForm ? 'outline' : 'primary'}
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? t('common.cancel') : t('hr.components.addAssignmentRow')}
                </Button>
              </div>
            )}

            {showForm && (
              <div className="flex flex-col gap-3 rounded-md border border-border-strong bg-surface-sunken p-3">
                <label className="flex max-w-xs flex-col gap-1.5 text-sm font-medium text-text-primary">
                  {t('hr.statutory.effectiveFrom')}
                  <input
                    type="date"
                    value={effectiveFrom}
                    min={today}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    className="h-10 rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-text-primary"
                  />
                </label>

                {draftRows.map((row, i) => (
                  <div key={i} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_auto]">
                    <SearchableSelect
                      label={t('hr.components.assignmentColumnComponent')}
                      value={row.componentId}
                      onValueChange={(v) => updateDraftRow(i, { componentId: v })}
                      options={activeComponentOptions}
                    />
                    <MoneyInput
                      label={t('hr.components.assignmentColumnAmount')}
                      hint={t('hr.components.useDefaultAmountHint')}
                      value={row.amount}
                      onChange={(v) => updateDraftRow(i, { amount: v })}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('hr.components.removeRow')}
                      onClick={() => setDraftRows((rows) => rows.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Plus className="size-4" />}
                    onClick={() =>
                      setDraftRows((rows) => [...rows, { componentId: '', amount: null }])
                    }
                  >
                    {t('hr.components.addAssignmentRow')}
                  </Button>
                </div>
                <div>
                  <Button
                    onClick={submit}
                    loading={submitting}
                    disabled={!effectiveFrom || draftRows.every((r) => !r.componentId)}
                  >
                    {t('hr.components.saveAssignments')}
                  </Button>
                  {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
                </div>
              </div>
            )}

            {loading ? (
              <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
            ) : sorted.length === 0 ? (
              <EmptyState title={t('hr.components.noAssignments')} size="sm" />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                      <th className="px-3 py-2">{t('hr.statutory.window')}</th>
                      <th className="px-3 py-2">{t('hr.components.assignmentColumnComponent')}</th>
                      <th className="px-3 py-2">{t('hr.components.assignmentColumnAmount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row, i) => {
                      const state = windowState(row, today);
                      const comp = componentByCode.get(row.code);
                      return (
                        <tr
                          key={`${row.componentId}-${row.effectiveFrom}-${i}`}
                          className="border-b border-border last:border-0 align-top"
                        >
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <div className="flex flex-col gap-1">
                              <Badge
                                variant={
                                  state === 'active'
                                    ? 'success'
                                    : state === 'future'
                                      ? 'info'
                                      : 'neutral'
                                }
                                size="sm"
                              >
                                {t(`hr.statutory.windowState.${state}`)}
                              </Badge>
                              <span className="text-xs text-text-muted">
                                {row.effectiveFrom}
                                {' – '}
                                {row.effectiveTo ?? t('hr.statutory.openEnded')}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            {comp ? `${comp.name} (${comp.code})` : row.code}
                          </td>
                          <td className="px-3 py-2.5">
                            {row.amount
                              ? formatMoney(row.amount)
                              : t('hr.components.usesDefaultAmount')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
