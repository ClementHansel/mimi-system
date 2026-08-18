'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import { Button, Input, MoneyInput, Select } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { EffectiveWindowEditor } from './EffectiveWindowEditor';
import {
  getStatutoryArticle17,
  getStatutoryBpjs,
  getStatutoryPtkp,
  getStatutoryTer,
  putStatutoryArticle17,
  putStatutoryBpjs,
  putStatutoryPtkp,
  putStatutoryTer,
} from './lib/hr-api';
import type { Article17BracketRow, BpjsRow, PtkpRow, TerBracketRow } from './lib/types';

const BPJS_PROGRAMS = ['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const;
const TER_CATEGORIES = ['A', 'B', 'C'] as const;

/**
 * F08 `hr` — the BPJS / PPh21 TER / PTKP / Article-17 rate editors
 * (CONTRACTS §4.15 Amendment 1, `payroll.statutory.config`). This is
 * precisely the slice `PayrollStatutoryCard` (F10, W4-05) named and
 * deliberately left for this ticket: the rate TABLES themselves, not the
 * enable/disable gate (that stays in F10, Owner/Manager-only).
 *
 * Every PUT here is a full-vintage replace keyed by `effectiveFrom`
 * (CONTRACTS §4.15) — `EffectiveWindowEditor` supplies the shared
 * active/future/past labeling and the same-day duplicate/backdate guard;
 * each rate shape below only supplies its own row fields.
 */
export function StatutoryRatesPanel() {
  return (
    <div className="flex flex-col gap-6">
      <BpjsEditor />
      <TerEditor />
      <PtkpEditor />
      <Article17Editor />
    </div>
  );
}

function BpjsEditor() {
  const { t } = useI18n();
  const [rows, setRows] = useState<BpjsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draft, setDraft] = useState<
    Record<
      string,
      {
        employerPct: string;
        employeePct: string;
        salaryFloor: string | null;
        salaryCap: string | null;
      }
    >
  >(
    Object.fromEntries(
      BPJS_PROGRAMS.map((p) => [
        p,
        { employerPct: '', employeePct: '', salaryFloor: null, salaryCap: null },
      ]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function reload() {
    setLoading(true);
    getStatutoryBpjs()
      .then(setRows)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      const rowsToSend = BPJS_PROGRAMS.map((program) => ({
        program,
        employerPct: draft[program]!.employerPct || '0',
        employeePct: draft[program]!.employeePct || '0',
        salaryFloor: draft[program]!.salaryFloor ?? undefined,
        salaryCap: draft[program]!.salaryCap ?? undefined,
        effectiveFrom,
      }));
      await putStatutoryBpjs(rowsToSend);
      toast({ title: t('hr.statutory.saveSuccess'), variant: 'success' });
      setEffectiveFrom('');
      reload();
    } catch {
      setError(t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EffectiveWindowEditor<BpjsRow>
      title={t('hr.statutory.bpjsTitle')}
      description={t('hr.statutory.bpjsDescription')}
      rows={rows}
      loading={loading}
      historyColumns={[
        t('hr.statutory.program'),
        t('hr.statutory.employerPct'),
        t('hr.statutory.employeePct'),
        t('hr.statutory.floor'),
        t('hr.statutory.cap'),
      ]}
      renderHistoryRow={(row) => (
        <>
          <td className="px-3 py-2.5">{t(`hr.statutory.bpjsProgram.${row.program}`)}</td>
          <td className="px-3 py-2.5">{row.employerPct}%</td>
          <td className="px-3 py-2.5">{row.employeePct}%</td>
          <td className="px-3 py-2.5">{row.salaryFloor ? formatMoney(row.salaryFloor) : '—'}</td>
          <td className="px-3 py-2.5">{row.salaryCap ? formatMoney(row.salaryCap) : '—'}</td>
        </>
      )}
      effectiveFrom={effectiveFrom}
      onEffectiveFromChange={setEffectiveFrom}
      onSubmit={submit}
      submitting={submitting}
      error={error}
      formFields={
        <div className="flex flex-col gap-2">
          {BPJS_PROGRAMS.map((program) => (
            <div key={program} className="grid grid-cols-2 gap-2 sm:grid-cols-5 sm:items-end">
              <span className="text-sm font-medium text-text-primary sm:col-span-1">
                {t(`hr.statutory.bpjsProgram.${program}`)}
              </span>
              <Input
                label={t('hr.statutory.employerPct')}
                value={draft[program]!.employerPct}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [program]: { ...d[program]!, employerPct: e.target.value },
                  }))
                }
                placeholder="4.000"
                size="sm"
              />
              <Input
                label={t('hr.statutory.employeePct')}
                value={draft[program]!.employeePct}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [program]: { ...d[program]!, employeePct: e.target.value },
                  }))
                }
                placeholder="1.000"
                size="sm"
              />
              <MoneyInput
                label={t('hr.statutory.floor')}
                value={draft[program]!.salaryFloor}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, [program]: { ...d[program]!, salaryFloor: v } }))
                }
                size="sm"
              />
              <MoneyInput
                label={t('hr.statutory.cap')}
                value={draft[program]!.salaryCap}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, [program]: { ...d[program]!, salaryCap: v } }))
                }
                size="sm"
              />
            </div>
          ))}
        </div>
      }
    />
  );
}

function TerEditor() {
  const { t } = useI18n();
  const [rows, setRows] = useState<TerBracketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draftRows, setDraftRows] = useState<
    { category?: 'A' | 'B' | 'C'; bracketMin: string; bracketMax: string; ratePct: string }[]
  >([{ category: 'A', bracketMin: '0', bracketMax: '', ratePct: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function reload() {
    setLoading(true);
    getStatutoryTer()
      .then(setRows)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      await putStatutoryTer(
        effectiveFrom,
        draftRows.map((r) => ({
          category: r.category ?? 'A',
          bracketMin: r.bracketMin,
          bracketMax: r.bracketMax || undefined,
          ratePct: r.ratePct,
        })),
      );
      toast({ title: t('hr.statutory.saveSuccess'), variant: 'success' });
      setEffectiveFrom('');
      reload();
    } catch {
      setError(t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EffectiveWindowEditor<TerBracketRow>
      title={t('hr.statutory.terTitle')}
      description={t('hr.statutory.terDescription')}
      rows={rows}
      loading={loading}
      historyColumns={[
        t('hr.statutory.category'),
        t('hr.statutory.bracketMin'),
        t('hr.statutory.bracketMax'),
        t('hr.statutory.ratePct'),
      ]}
      renderHistoryRow={(row) => (
        <>
          <td className="px-3 py-2.5">{row.category}</td>
          <td className="px-3 py-2.5">{formatMoney(row.bracketMin)}</td>
          <td className="px-3 py-2.5">
            {row.bracketMax ? formatMoney(row.bracketMax) : t('hr.statutory.openEnded')}
          </td>
          <td className="px-3 py-2.5">{row.ratePct}%</td>
        </>
      )}
      effectiveFrom={effectiveFrom}
      onEffectiveFromChange={setEffectiveFrom}
      onSubmit={submit}
      submitting={submitting}
      submitDisabled={draftRows.length === 0}
      error={error}
      formFields={
        <BracketRowsEditor
          rows={draftRows}
          onChange={setDraftRows}
          categoryOptions={TER_CATEGORIES}
        />
      }
    />
  );
}

function PtkpEditor() {
  const { t } = useI18n();
  const [rows, setRows] = useState<PtkpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draftRows, setDraftRows] = useState<
    { ptkpCode: string; annualAmount: string | null; terCategory: 'A' | 'B' | 'C' }[]
  >([{ ptkpCode: 'TK/0', annualAmount: null, terCategory: 'A' }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function reload() {
    setLoading(true);
    getStatutoryPtkp()
      .then(setRows)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      await putStatutoryPtkp(
        effectiveFrom,
        draftRows.map((r) => ({
          ptkpCode: r.ptkpCode,
          annualAmount: r.annualAmount ?? '0.00',
          terCategory: r.terCategory,
        })),
      );
      toast({ title: t('hr.statutory.saveSuccess'), variant: 'success' });
      setEffectiveFrom('');
      reload();
    } catch {
      setError(t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EffectiveWindowEditor<PtkpRow>
      title={t('hr.statutory.ptkpTitle')}
      description={t('hr.statutory.ptkpDescription')}
      rows={rows}
      loading={loading}
      historyColumns={[
        t('hr.statutory.ptkpCode'),
        t('hr.statutory.annualAmount'),
        t('hr.statutory.category'),
      ]}
      renderHistoryRow={(row) => (
        <>
          <td className="px-3 py-2.5">{row.ptkpCode}</td>
          <td className="px-3 py-2.5">{formatMoney(row.annualAmount)}</td>
          <td className="px-3 py-2.5">{row.terCategory}</td>
        </>
      )}
      effectiveFrom={effectiveFrom}
      onEffectiveFromChange={setEffectiveFrom}
      onSubmit={submit}
      submitting={submitting}
      submitDisabled={draftRows.length === 0}
      error={error}
      formFields={
        <div className="flex flex-col gap-2">
          {draftRows.map((row, i) => (
            <div key={i} className="grid grid-cols-3 items-end gap-2">
              <Input
                label={t('hr.statutory.ptkpCode')}
                value={row.ptkpCode}
                onChange={(e) =>
                  setDraftRows((rs) =>
                    rs.map((r, j) => (j === i ? { ...r, ptkpCode: e.target.value } : r)),
                  )
                }
                size="sm"
              />
              <MoneyInput
                label={t('hr.statutory.annualAmount')}
                value={row.annualAmount}
                onChange={(v) =>
                  setDraftRows((rs) => rs.map((r, j) => (j === i ? { ...r, annualAmount: v } : r)))
                }
                size="sm"
              />
              <div className="flex items-end gap-2">
                <Select
                  label={t('hr.statutory.category')}
                  value={row.terCategory}
                  onValueChange={(v) =>
                    setDraftRows((rs) =>
                      rs.map((r, j) => (j === i ? { ...r, terCategory: v as 'A' | 'B' | 'C' } : r)),
                    )
                  }
                  options={TER_CATEGORIES.map((c) => ({ value: c, label: c }))}
                  size="sm"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraftRows((rs) => rs.filter((_, j) => j !== i))}
                  aria-label={t('common.delete')}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Plus className="size-4" />}
            onClick={() =>
              setDraftRows((rs) => [...rs, { ptkpCode: '', annualAmount: null, terCategory: 'A' }])
            }
          >
            {t('hr.statutory.addRow')}
          </Button>
        </div>
      }
    />
  );
}

function Article17Editor() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Article17BracketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [draftRows, setDraftRows] = useState<
    { bracketMin: string; bracketMax: string; ratePct: string }[]
  >([{ bracketMin: '0', bracketMax: '', ratePct: '' }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function reload() {
    setLoading(true);
    getStatutoryArticle17()
      .then(setRows)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      await putStatutoryArticle17(
        effectiveFrom,
        draftRows.map((r) => ({
          bracketMin: r.bracketMin,
          bracketMax: r.bracketMax || undefined,
          ratePct: r.ratePct,
        })),
      );
      toast({ title: t('hr.statutory.saveSuccess'), variant: 'success' });
      setEffectiveFrom('');
      reload();
    } catch {
      setError(t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EffectiveWindowEditor<Article17BracketRow>
      title={t('hr.statutory.article17Title')}
      description={t('hr.statutory.article17Description')}
      rows={rows}
      loading={loading}
      historyColumns={[
        t('hr.statutory.bracketMin'),
        t('hr.statutory.bracketMax'),
        t('hr.statutory.ratePct'),
      ]}
      renderHistoryRow={(row) => (
        <>
          <td className="px-3 py-2.5">{formatMoney(row.bracketMin)}</td>
          <td className="px-3 py-2.5">
            {row.bracketMax ? formatMoney(row.bracketMax) : t('hr.statutory.openEnded')}
          </td>
          <td className="px-3 py-2.5">{row.ratePct}%</td>
        </>
      )}
      effectiveFrom={effectiveFrom}
      onEffectiveFromChange={setEffectiveFrom}
      onSubmit={submit}
      submitting={submitting}
      submitDisabled={draftRows.length === 0}
      error={error}
      formFields={<BracketRowsEditor rows={draftRows} onChange={setDraftRows} />}
    />
  );
}

/** Shared "N brackets, add/remove rows" editor for TER (with a category select) and Article-17 (no category). */
function BracketRowsEditor<C extends string>({
  rows,
  onChange,
  categoryOptions,
}: {
  rows: { category?: C; bracketMin: string; bracketMax: string; ratePct: string }[];
  onChange: (
    rows: { category?: C; bracketMin: string; bracketMax: string; ratePct: string }[],
  ) => void;
  categoryOptions?: readonly C[];
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-5">
          {categoryOptions && (
            <Select
              label={t('hr.statutory.category')}
              value={String(row.category ?? categoryOptions[0] ?? '')}
              onValueChange={(v) =>
                onChange(rows.map((r, j) => (j === i ? { ...r, category: v as C } : r)))
              }
              options={categoryOptions.map((c) => ({ value: c, label: c }))}
              size="sm"
            />
          )}
          <Input
            label={t('hr.statutory.bracketMin')}
            value={row.bracketMin}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, bracketMin: e.target.value } : r)))
            }
            size="sm"
          />
          <Input
            label={t('hr.statutory.bracketMax')}
            placeholder={t('hr.statutory.openEnded')}
            value={row.bracketMax}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, bracketMax: e.target.value } : r)))
            }
            size="sm"
          />
          <Input
            label={t('hr.statutory.ratePct')}
            placeholder="15.000"
            value={row.ratePct}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, ratePct: e.target.value } : r)))
            }
            size="sm"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label={t('common.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        leftIcon={<Plus className="size-4" />}
        onClick={() =>
          onChange([
            ...rows,
            { category: categoryOptions?.[0], bracketMin: '', bracketMax: '', ratePct: '' },
          ])
        }
      >
        {t('hr.statutory.addRow')}
      </Button>
    </div>
  );
}
