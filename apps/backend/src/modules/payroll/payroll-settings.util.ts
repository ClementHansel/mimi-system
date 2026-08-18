import type { PoolClient } from 'pg';
import {
  DEFAULT_DEDUCTION_RATES,
  DEFAULT_OVERTIME_SETTINGS,
  DEFAULT_SO_SHORTFALL_SETTINGS,
  ANNUAL_LEAVE_QUOTA_DAYS,
  MARRIAGE_LEAVE_QUOTA_DAYS,
  type Money,
  type SettingsKey,
} from '@mimi/shared';

/**
 * Settings reads for M15 `payroll` — same read-only, fallback-to-default
 * pattern as `modules/hr/hr-settings.util.ts` (M20 `settings` is a stub, so
 * there is no `SettingsService` to inject; `settings` is class M, safe to
 * read directly). Never throws — a missing row must never block payroll
 * calculation; it falls back to the `@mimi/shared` seed default instead.
 */
async function readSetting<T>(client: PoolClient, key: SettingsKey, fallback: T): Promise<T> {
  const res = await client.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    key,
  ]);
  if (res.rows.length === 0 || res.rows[0]!.value === null || res.rows[0]!.value === undefined)
    return fallback;
  return res.rows[0]!.value as T;
}

export interface StatutoryGate {
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** CONTRACTS §4.20 `payroll.statutory` — Amendment 1's ONE gate, flipped only via the §4.15 wizard endpoints. */
export async function getStatutoryGate(client: PoolClient): Promise<StatutoryGate> {
  return readSetting<StatutoryGate>(client, 'payroll.statutory', {
    enabled: false,
    enabledAt: null,
    enabledBy: null,
  });
}

export async function getOvertimeSettings(
  client: PoolClient,
): Promise<{ ratePerHour: Money; minMinutes: number }> {
  return readSetting(
    client,
    'hr.overtime',
    DEFAULT_OVERTIME_SETTINGS as unknown as { ratePerHour: Money; minMinutes: number },
  );
}

export interface DeductionRates {
  perAbsentDay: 'daily_rate' | Money;
  perLateMinute: Money;
  sickPaid: boolean;
  permissionPaid: boolean;
}

export async function getDeductionRates(client: PoolClient): Promise<DeductionRates> {
  return readSetting<DeductionRates>(
    client,
    'hr.deduction_rates',
    DEFAULT_DEDUCTION_RATES as unknown as DeductionRates,
  );
}

export async function getLeaveQuotas(
  client: PoolClient,
): Promise<{ annual: number; marriage: number }> {
  return readSetting(client, 'leave.quotas', {
    annual: ANNUAL_LEAVE_QUOTA_DAYS,
    marriage: MARRIAGE_LEAVE_QUOTA_DAYS,
  });
}

export interface SoShortfallSettings {
  mode: 'attributable_only' | string;
  splitRule: 'equal_among_on_shift' | string;
}

export async function getSoShortfallSettings(client: PoolClient): Promise<SoShortfallSettings> {
  return readSetting<SoShortfallSettings>(
    client,
    'payroll.so_shortfall',
    DEFAULT_SO_SHORTFALL_SETTINGS as unknown as SoShortfallSettings,
  );
}
