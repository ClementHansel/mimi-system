import { describe, it, expect } from 'vitest';
import { SETTINGS_KEY_LIST, type SettingsKey } from './constants';

describe('SettingsKey — closed literal union, same discipline as PermissionKey/ErrorCode', () => {
  // The count is deliberately hardcoded: adding a key means adding a seeded
  // row and a validator schema too, and this failing is the reminder. Keep the
  // number and the sentence in step — the title said "21" while the assertion
  // said 23, which is exactly the drift that makes a pinning test stop being
  // read.
  it('lists all 24 seeded settings keys with no duplicates', () => {
    expect(SETTINGS_KEY_LIST).toHaveLength(24);
    expect(new Set(SETTINGS_KEY_LIST).size).toBe(24);
  });

  it('includes the D-16 tenure-tier key', () => {
    expect(SETTINGS_KEY_LIST).toContain('hr.tenure_tiers');
  });

  it('includes the D-18/D-19 amendment keys', () => {
    expect(SETTINGS_KEY_LIST).toContain('payroll.statutory');
    expect(SETTINGS_KEY_LIST).toContain('pos.cash_variance_propose_above');
  });

  it("rejects a typo'd key at COMPILE time", () => {
    // @ts-expect-error - 'aproval.threshold.void' is not a member of SettingsKey; this must fail to compile.
    const typo: SettingsKey = 'aproval.threshold.void';
    expect(typo).toBeDefined();
  });
});
