import { describe, expect, it } from 'vitest';
import { isOpnameEditable, OpnameStatus } from './enums';

/**
 * The rule the count sheets and `StockOpnameService` must agree on.
 *
 * They did not: the service refuses `upsertLines` and `submit` on anything past
 * `counting`, while both sheets rendered their inputs and their Simpan/Ajukan
 * buttons for every status — the status appeared as a badge and nothing else.
 * So a submitted count could be edited and re-submitted, and doing so returned
 * an error the counter could not act on.
 */
describe('isOpnameEditable', () => {
  it('accepts a count still being taken', () => {
    expect(isOpnameEditable(OpnameStatus.COUNTING)).toBe(true);
    // `draft` is a count opened but not yet started — still the counter's.
    expect(isOpnameEditable(OpnameStatus.DRAFT)).toBe(true);
  });

  it('refuses every state somebody has already acted on', () => {
    // Submitted is the one from the report; the rest are the same argument —
    // each records a decision, and reopening it as a form would let a sheet be
    // changed under the person who approved or posted it.
    for (const status of [
      OpnameStatus.SUBMITTED,
      OpnameStatus.APPROVED,
      OpnameStatus.REJECTED,
      OpnameStatus.ADJUSTED,
      OpnameStatus.CANCELLED,
    ]) {
      expect(isOpnameEditable(status), `${status} must not be editable`).toBe(false);
    }
  });

  it('refuses a status it does not recognise', () => {
    // Fails closed: a status added to the enum later must not become editable
    // by default just because this function has not been taught about it.
    expect(isOpnameEditable('something_new')).toBe(false);
  });

  it('covers every member of the enum', () => {
    // Guards the test above from going stale — a new status forces a decision
    // here rather than silently inheriting "not editable".
    const known = [
      OpnameStatus.DRAFT,
      OpnameStatus.COUNTING,
      OpnameStatus.SUBMITTED,
      OpnameStatus.APPROVED,
      OpnameStatus.REJECTED,
      OpnameStatus.ADJUSTED,
      OpnameStatus.CANCELLED,
    ];
    expect(new Set(known)).toEqual(new Set(Object.values(OpnameStatus)));
  });
});
