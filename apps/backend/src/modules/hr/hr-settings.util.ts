import type { PoolClient } from 'pg';
import {
  ANNUAL_LEAVE_QUOTA_DAYS,
  DEFAULT_LATE_GRACE_MINUTES,
  DEFAULT_MAX_OFFLINE_WINDOW_HOURS,
  DEFAULT_OVERTIME_SETTINGS,
  MARRIAGE_LEAVE_QUOTA_DAYS,
  type SettingsKey,
} from '@mimi/shared';

/**
 * Reads one `settings` row by key (CONTRACTS.md §1.1 block 007, seeded by
 * W1-C — see `docs/CONTRACTS.md` §4.20's default table). M20 `settings` is a
 * stub (Wave 4), so there is no `SettingsService` to inject yet; `settings`
 * is class M (cloud-authoritative, read-only elsewhere) so a direct,
 * read-only SELECT from this module is safe and matches the pattern other
 * kernel code (`threshold.resolver.ts`) already uses for the same table.
 * Falls back to the `@mimi/shared` constant default when the row is
 * missing — never throws, since a missing settings row must never block an
 * attendance check-in or a leave submission.
 */
async function readSetting<T>(client: PoolClient, key: SettingsKey, fallback: T): Promise<T> {
  const res = await client.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    key,
  ]);
  if (res.rows.length === 0 || res.rows[0]!.value === null || res.rows[0]!.value === undefined)
    return fallback;
  return res.rows[0]!.value as T;
}

export async function getLateGraceMinutes(client: PoolClient): Promise<number> {
  return readSetting<number>(client, 'hr.late_grace_minutes', DEFAULT_LATE_GRACE_MINUTES);
}

export async function getOvertimeSettings(
  client: PoolClient,
): Promise<{ ratePerHour: string; minMinutes: number }> {
  return readSetting(
    client,
    'hr.overtime',
    DEFAULT_OVERTIME_SETTINGS as { ratePerHour: string; minMinutes: number },
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

export async function getMaxOfflineWindowHours(client: PoolClient): Promise<number> {
  return readSetting<number>(client, 'sync.max_offline_window_h', DEFAULT_MAX_OFFLINE_WINDOW_HOURS);
}
