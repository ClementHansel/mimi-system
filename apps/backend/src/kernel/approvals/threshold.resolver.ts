import {
  ApprovalDocumentType,
  compareMoney,
  DEFAULT_APPROVAL_THRESHOLDS,
  type Money,
  type SettingsKey,
} from '@mimi/shared';
import type { DbClient } from './types';

/**
 * Live threshold evaluation (CONTRACTS.md §5 preamble: "Threshold steps read
 * `settings.approval.threshold.*`") — the one thing `@mimi/shared`'s pure
 * `transition()` explicitly does NOT do (its own file header: "holds no...
 * approval-chain-threshold routing — that reads `settings[...]` at runtime
 * and is the engine's job, not this pure function's").
 *
 * `approval_chain_steps.min_amount`/`max_amount` are seeded once from the
 * SAME values (see `database/migrations/069_indexes_rls_060.sql`) but are a
 * point-in-time copy; M20 (`settings`) can change the live threshold at any
 * time without touching the chain-step rows. This resolver treats `settings`
 * as authoritative and the chain-step columns as the fallback (covers the
 * document types below that have no live-settings mapping at all, and
 * covers `settings` rows that are missing/malformed defensively).
 */

interface ThresholdMapping {
  settingsKey: SettingsKey;
  /** Field name inside the settings JSONB value, e.g. `'managerAboveIdr'`. */
  field: string;
}

const THRESHOLD_MAPPINGS: Partial<
  Record<ApprovalDocumentType, Partial<Record<number, ThresholdMapping>>>
> = {
  [ApprovalDocumentType.VOID_REFUND]: {
    2: { settingsKey: 'approval.threshold.void', field: 'managerAboveIdr' },
  },
  [ApprovalDocumentType.STOCK_OPNAME]: {
    2: { settingsKey: 'approval.threshold.opname', field: 'managerAboveIdr' },
  },
  [ApprovalDocumentType.PURCHASE_ORDER]: {
    2: { settingsKey: 'approval.threshold.po', field: 'ownerAboveIdr' },
  },
  [ApprovalDocumentType.PAYMENT_VERIFICATION]: {
    1: { settingsKey: 'approval.threshold.payment', field: 'ownerAboveIdr' },
  },
};

/** The static fallback table (mirrors `@mimi/shared`'s `DEFAULT_APPROVAL_THRESHOLDS`) used when `settings` has no row or an unreadable shape. */
const FALLBACK_BY_KEY: Record<string, Record<string, Money>> = {
  'approval.threshold.void': DEFAULT_APPROVAL_THRESHOLDS.void,
  'approval.threshold.opname': DEFAULT_APPROVAL_THRESHOLDS.opname,
  'approval.threshold.po': DEFAULT_APPROVAL_THRESHOLDS.po,
  'approval.threshold.payment': DEFAULT_APPROVAL_THRESHOLDS.payment,
};

export interface StepAmountWindow {
  minAmount: Money | null;
  maxAmount: Money | null;
}

/**
 * Resolves the effective `[minAmount, maxAmount)` window for a step: live
 * `settings` value when a mapping exists for `(documentType, stepNo)`,
 * else the chain-seeded `min_amount`/`max_amount` columns verbatim (every
 * document type without a live-settings escalation: replenishment, PR,
 * return, waste, payroll, leave, loan, cash-variance).
 */
export async function resolveStepWindow(
  client: DbClient,
  documentType: ApprovalDocumentType,
  stepNo: number,
  seeded: { minAmount: Money | null; maxAmount: Money | null },
): Promise<StepAmountWindow> {
  const mapping = THRESHOLD_MAPPINGS[documentType]?.[stepNo];
  if (!mapping) return seeded;

  const live = await readThresholdField(client, mapping.settingsKey, mapping.field);
  if (live !== undefined) return { minAmount: live, maxAmount: null };

  const fallback = FALLBACK_BY_KEY[mapping.settingsKey]?.[mapping.field];
  return { minAmount: fallback ?? seeded.minAmount, maxAmount: seeded.maxAmount };
}

async function readThresholdField(
  client: DbClient,
  settingsKey: string,
  field: string,
): Promise<Money | undefined> {
  const res = await client.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [
    settingsKey,
  ]);
  const value = res.rows[0]?.value;
  if (value == null || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : undefined;
}

/** `true` when `amount` falls inside `[minAmount, maxAmount)` — both bounds null-safe (`null` = unbounded on that side). */
export function isAmountInWindow(amount: Money | null, window: StepAmountWindow): boolean {
  if (window.minAmount !== null) {
    if (amount === null) return false; // no amount recorded ⇒ cannot prove the threshold is reached; the step does not escalate.
    if (compareMoney(amount, window.minAmount) < 0) return false;
  }
  if (window.maxAmount !== null) {
    if (amount === null) return true; // a max-only window with no amount is treated as "within" (nothing to exceed).
    if (compareMoney(amount, window.maxAmount) >= 0) return false;
  }
  return true;
}
