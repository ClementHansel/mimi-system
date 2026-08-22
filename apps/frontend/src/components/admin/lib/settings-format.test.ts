import { describe, it, expect } from 'vitest';
import { formatSettingValue } from './settings-format';
import { translate } from '@/lib/i18n';

/**
 * The value column is the whole point of the settings redesign — the old table
 * had none, so "what IS the void limit right now?" was unanswerable without
 * opening a JSON editor. These tests run against the REAL i18n table and the
 * REAL wire shapes taken from `settings` (migration 007 + 229), so a renamed
 * unit key or a changed shape fails here rather than rendering "[object
 * Object]" on the owner's screen.
 */
describe('formatSettingValue', () => {
  const t = translate;

  it('formats a money threshold object as rupiah, not braces', () => {
    expect(formatSettingValue('approval.threshold.void', { managerAboveIdr: '200000.00' }, t)).toBe(
      'Rp200.000',
    );
  });

  it('formats scalars with their unit', () => {
    expect(formatSettingValue('hr.geofence_radius_m', 200, t)).toBe('200 m');
    expect(formatSettingValue('hr.late_grace_minutes', 5, t)).toBe('5 menit');
    expect(formatSettingValue('auth.offline_credential_ttl_h', 24, t)).toBe('24 jam');
    expect(formatSettingValue('offline.approval_volume_cap', 20, t)).toBe('20×');
  });

  it('formats a bare money string', () => {
    expect(formatSettingValue('offline.selfie_required_above', '200000.00', t)).toBe('Rp200.000');
  });

  it('formats booleans as Ya/Tidak', () => {
    expect(formatSettingValue('wa.enabled', false, t)).toBe('Tidak');
    expect(formatSettingValue('wa.enabled', true, t)).toBe('Ya');
  });

  it('joins EVERY field of a multi-field object, not just the first', () => {
    // `hr.overtime`'s rate is meaningless without its minimum — a manager
    // comparing rows needs both on the line.
    expect(formatSettingValue('hr.overtime', { ratePerHour: '15000.00', minMinutes: 30 }, t)).toBe(
      'Rp15.000 · 30 menit',
    );
    expect(formatSettingValue('leave.quotas', { annual: 12, marriage: 3 }, t)).toBe(
      '12 hari · 3 hari',
    );
  });

  it('labels booleans inside an object so the line stays readable', () => {
    const out = formatSettingValue(
      'hr.deduction_rates',
      {
        perLateMinute: '500.00',
        sickPaid: true,
        permissionPaid: false,
        perAbsentDay: 'daily_rate',
      },
      t,
    );
    expect(out).toContain('Rp500');
    expect(out).toContain('Sakit tetap dibayar: Ya');
    expect(out).toContain('Izin tetap dibayar: Tidak');
  });

  it('falls back to compact JSON for a key with no spec, rather than hiding it', () => {
    // A setting added by a later migration must still show SOMETHING: the row
    // stays visible and editable via the raw editor.
    expect(formatSettingValue('some.future.setting', { a: 1 }, t)).toBe('{"a":1}');
  });

  it('truncates a pathological value instead of blowing the column open', () => {
    const long = { note: 'x'.repeat(200) };
    const out = formatSettingValue('some.future.setting', long, t);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never renders a newline into a table cell', () => {
    expect(formatSettingValue('some.future.setting', { a: 1, b: 2 }, t)).not.toContain('\n');
  });
});
