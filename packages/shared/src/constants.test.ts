import { describe, it, expect } from 'vitest';
import { SETTINGS_KEY_LIST, type SettingsKey } from './constants';

describe('SettingsKey — closed literal union, same discipline as PermissionKey/ErrorCode', () => {
  it('lists all 21 seeded settings keys with no duplicates', () => {
    expect(SETTINGS_KEY_LIST).toHaveLength(21);
    expect(new Set(SETTINGS_KEY_LIST).size).toBe(21);
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
