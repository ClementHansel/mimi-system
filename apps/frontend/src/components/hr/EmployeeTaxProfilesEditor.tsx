'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserRoundCheck, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CheckboxGroup,
  DataTable,
  Input,
  Modal,
  MoneyInput,
  Select,
} from '@/components/ui';
import { toDateInput } from '@/lib/dates';
import { getStatutoryPtkp, getTaxProfile, listTaxProfiles, putTaxProfile } from './lib/hr-api';
import type { PtkpRow, TaxProfile, TaxProfileRosterRow } from './lib/types';
import type { Money, Paginated } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * The employee tax-profile editor — the step of the Amendment 1 statutory
 * wizard that had a working API and no screen (MA-186).
 *
 * `StatutoryService.getStatus` refuses to report `ready` until every ACTIVE
 * employee has a row in `employee_tax_profiles`, and Settings → "Mode Payroll
 * Statutori" wires its "Aktifkan" button to `disabled={!status.ready}`. The
 * seed creates a profile for each employee it seeds, so a freshly seeded
 * database looks fine — and then the first person HR adds during real use has
 * no profile, coverage drops below 100%, and the button greys out with nothing
 * anywhere in the product able to bring it back. `getTaxProfile` and
 * `putTaxProfile` existed in `hr-api.ts` the whole time with no caller.
 *
 * It is also not only an enablement gate. Once statutory mode IS on,
 * `StatutoryService.buildCalculationInputs` throws `ERR_STATUTORY_NOT_READY`
 * for an employee with no profile, and `computeAndPersistLines` does not catch
 * it — so one new hire would fail the whole month's payroll run, again with no
 * way to fix the cause.
 *
 * There is deliberately no default profile. A PTKP code decides how much PPh21
 * is withheld from a real person's pay; inventing one to satisfy a readiness
 * check would produce a wrong number that looks like a right one, which is
 * strictly worse than a blocked button that says what is missing.
 *
 * Lives here rather than in `EmployeesPanel` because it is
 * `payroll.statutory.config` data (finance/hr_admin), not `hr.employee.manage`
 * data — the same permission as the rate tables it sits beside.
 */
const BPJS_PROGRAMS = ['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const;
type BpjsProgram = (typeof BPJS_PROGRAMS)[number];

const PROFILE_FILTERS = ['missing', 'present', 'all'] as const;
type ProfileFilter = (typeof PROFILE_FILTERS)[number];

const EMPTY_PAGE: Paginated<TaxProfileRosterRow> = { rows: [], total: 0, page: 1, pageSize: 25 };

/**
 * Dependants come FROM the PTKP code — "K/2" is married with two — so the
 * count is derived rather than typed. Two fields that must agree is two
 * chances to disagree, and the disagreement would be invisible on screen and
 * wrong in the withholding.
 */
function dependantsFromPtkp(ptkpCode: string): number {
  const tail = ptkpCode.split('/')[1];
  const n = Number.parseInt(tail ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

export function EmployeeTaxProfilesEditor() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ProfileFilter>('missing');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<TaxProfileRosterRow>>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [editing, setEditing] = useState<TaxProfileRosterRow | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadError(undefined);
    listTaxProfiles({ profile: filter, q: q || undefined, page, pageSize: 25 })
      .then(setData)
      .catch((err) => {
        setData(EMPTY_PAGE);
        setLoadError(errMsg(err, t('errors.generic')));
      })
      .finally(() => setLoading(false));
  }, [filter, q, page, t]);

  useEffect(reload, [reload]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRoundCheck className="size-5 text-brand-600" aria-hidden />
          {t('hr.statutory.taxProfileTitle')}
        </CardTitle>
        <CardDescription>{t('hr.statutory.taxProfileDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('hr.statutory.taxProfileFilterLabel')}
            value={filter}
            onValueChange={(v) => {
              setFilter(v as ProfileFilter);
              setPage(1);
            }}
            options={PROFILE_FILTERS.map((f) => ({
              value: f,
              label: t(`hr.statutory.taxProfileFilter.${f}`),
            }))}
            size="sm"
            wrapperClassName="w-56"
          />
          <Input
            label={t('hr.statutory.taxProfileSearchLabel')}
            placeholder={t('hr.statutory.taxProfileSearchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            size="sm"
            wrapperClassName="w-64"
          />
        </div>

        {/* The count is the point of the default filter: this is exactly the
            set blocking "Aktifkan" in Settings, so it is stated rather than
            left to be counted off the page. */}
        {filter === 'missing' && !loading && !loadError && (
          <p className="flex items-center gap-1.5 text-sm text-text-secondary">
            {data.total > 0 ? (
              <>
                <AlertTriangle className="size-4 flex-none text-warning-600" aria-hidden />
                {t('hr.statutory.taxProfileMissingCount', { n: data.total })}
              </>
            ) : (
              t('hr.statutory.taxProfileNoneMissing')
            )}
          </p>
        )}

        <DataTable
          columns={[
            { key: 'employeeNumber', header: t('hr.employees.columnNumber') },
            { key: 'name', header: t('hr.employees.columnName') },
            { key: 'locationName', header: t('hr.employees.columnLocation') },
            {
              key: 'ptkpCode',
              header: t('hr.statutory.ptkpCode'),
              render: (r) => r.ptkpCode ?? '—',
            },
            {
              key: 'hasProfile',
              header: t('hr.statutory.taxProfileColumnState'),
              render: (r) =>
                r.hasProfile ? (
                  <Badge variant="success" size="sm">
                    {t('hr.statutory.taxProfileComplete')}
                  </Badge>
                ) : (
                  <Badge variant="warning" size="sm">
                    {t('hr.statutory.taxProfileIncomplete')}
                  </Badge>
                ),
            },
          ]}
          data={data}
          keyField={(r) => r.employeeId}
          loading={loading}
          error={loadError}
          emptyTitle={t('hr.statutory.taxProfileEmptyTitle')}
          onRowClick={(row) => setEditing(row)}
          onPageChange={setPage}
        />
      </CardContent>

      {editing && (
        <TaxProfileModal
          employee={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}

function TaxProfileModal({
  employee,
  onClose,
  onSaved,
}: {
  employee: TaxProfileRosterRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [ptkpOptions, setPtkpOptions] = useState<PtkpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [npwp, setNpwp] = useState('');
  const [ptkpCode, setPtkpCode] = useState('');
  const [bpjsSalaryBase, setBpjsSalaryBase] = useState<Money | null>(null);
  const [enrolled, setEnrolled] = useState<Record<BpjsProgram, boolean>>({
    kesehatan: false,
    jht: false,
    jkk: false,
    jkm: false,
    jp: false,
  });
  const [enrolledSince, setEnrolledSince] = useState(toDateInput(new Date()));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The PTKP table is the source of valid codes — `putTaxProfile` rejects
    // anything not in it (`Unknown ptkpCode`), so this is a picker and never a
    // free-text field.
    Promise.all([
      getStatutoryPtkp().catch(() => [] as PtkpRow[]),
      employee.hasProfile
        ? getTaxProfile(employee.employeeId).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([codes, existing]) => {
        if (cancelled) return;
        setPtkpOptions(codes);
        if (existing) {
          setNpwp(existing.npwp ?? '');
          setPtkpCode(existing.ptkpCode);
          setBpjsSalaryBase(existing.bpjsSalaryBase);
          const programs = Object.keys(existing.bpjsEnrollments ?? {}) as BpjsProgram[];
          setEnrolled((prev) => ({
            ...prev,
            ...Object.fromEntries(
              BPJS_PROGRAMS.map((p) => [
                p,
                programs.includes(p) && !existing.bpjsEnrollments[p]?.endedAt,
              ]),
            ),
          }));
          const firstSince = programs
            .map((p) => existing.bpjsEnrollments[p]?.enrolledSince)
            .find(Boolean);
          if (firstSince) setEnrolledSince(firstSince);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [employee]);

  // A unique PTKP code list: the table is effective-dated, so the same code
  // appears once per vintage and a raw map would offer "TK/0" several times.
  const codes = Array.from(new Set(ptkpOptions.map((r) => r.ptkpCode))).sort();

  async function submit() {
    if (!ptkpCode) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const profile: TaxProfile = {
        npwp: npwp.trim() || null,
        ptkpCode,
        dependantsCount: dependantsFromPtkp(ptkpCode),
        bpjsEnrollments: Object.fromEntries(
          BPJS_PROGRAMS.filter((p) => enrolled[p]).map((p) => [
            p,
            { enrolledSince, endedAt: null },
          ]),
        ),
        bpjsSalaryBase,
      };
      await putTaxProfile(employee.employeeId, profile);
      toast({ title: t('hr.statutory.taxProfileSaveSuccess'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('hr.statutory.taxProfileModalTitle', { name: employee.name })}
      description={t('hr.statutory.taxProfileModalDescription')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!ptkpCode || loading}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="h-48 animate-pulse rounded-md bg-surface-sunken" />
      ) : (
        <div className="flex flex-col gap-4">
          <Select
            label={t('hr.statutory.ptkpCode')}
            value={ptkpCode}
            onValueChange={setPtkpCode}
            options={codes.map((c) => ({ value: c, label: c }))}
            placeholder={t('hr.statutory.taxProfilePtkpPlaceholder')}
            hint={
              codes.length === 0
                ? t('hr.statutory.taxProfileNoPtkpTable')
                : t('hr.statutory.taxProfilePtkpHint', {
                    n: ptkpCode ? dependantsFromPtkp(ptkpCode) : 0,
                  })
            }
            required
          />

          <Input
            label={t('hr.statutory.taxProfileNpwpLabel')}
            value={npwp}
            onChange={(e) => setNpwp(e.target.value)}
            placeholder="00.000.000.0-000.000"
            // Genuinely optional: roughly a third of the roster has no NPWP on
            // file, and PPh21 is computed either way (the no-NPWP surcharge is
            // the calculator's business, not this form's).
            hint={t('hr.statutory.taxProfileNpwpHint')}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text-primary">
              {t('hr.statutory.taxProfileBpjsLegend')}
            </legend>
            {/* MA-193 — all five programmes is the normal enrolment, so it is
                one click rather than five. */}
            <CheckboxGroup
              options={BPJS_PROGRAMS.map((p) => ({
                value: p,
                label: t(`hr.statutory.bpjsProgram.${p}`),
              }))}
              value={BPJS_PROGRAMS.filter((p) => enrolled[p])}
              onChange={(next) =>
                setEnrolled(
                  Object.fromEntries(BPJS_PROGRAMS.map((p) => [p, next.includes(p)])) as Record<
                    BpjsProgram,
                    boolean
                  >,
                )
              }
              scrollable={false}
            />
            <Input
              type="date"
              label={t('hr.statutory.taxProfileEnrolledSinceLabel')}
              value={enrolledSince}
              onChange={(e) => setEnrolledSince(e.target.value)}
              hint={t('hr.statutory.taxProfileEnrolledSinceHint')}
              size="sm"
              wrapperClassName="w-56"
            />
          </fieldset>

          <MoneyInput
            label={t('hr.statutory.taxProfileBpjsBaseLabel')}
            value={bpjsSalaryBase}
            onChange={setBpjsSalaryBase}
            hint={t('hr.statutory.taxProfileBpjsBaseHint')}
          />

          {error && <p className="text-sm text-danger-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
