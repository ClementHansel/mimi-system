import { describe, it, expect, vi } from 'vitest';
import { ApprovalDocumentType } from '@mimi/shared';
import { isAmountInWindow, resolveStepWindow } from './threshold.resolver';

function makeClient(settingsRows: Array<{ key: string; value: unknown }>) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM settings')) {
        const key = params[0];
        const row = settingsRows.find((r) => r.key === key);
        return { rows: row ? [{ value: row.value }] : [] };
      }
      return { rows: [] };
    }),
  };
}

describe('resolveStepWindow', () => {
  it('reads the live settings value for a mapped (documentType, stepNo)', async () => {
    const client = makeClient([{ key: 'approval.threshold.void', value: { managerAboveIdr: '500000.00' } }]);
    const window = await resolveStepWindow(client as never, ApprovalDocumentType.VOID_REFUND, 2, { minAmount: '200000.00', maxAmount: null });
    expect(window).toEqual({ minAmount: '500000.00', maxAmount: null });
  });

  it('falls back to the shared default when the settings row is missing entirely', async () => {
    const client = makeClient([]);
    const window = await resolveStepWindow(client as never, ApprovalDocumentType.PURCHASE_ORDER, 2, { minAmount: null, maxAmount: null });
    expect(window.minAmount).toBe('10000000.00');
  });

  it('falls back to the seeded chain-step value when settings has no mapping for this (documentType, stepNo)', async () => {
    const client = makeClient([]);
    const seeded = { minAmount: '2000000.00', maxAmount: null };
    const window = await resolveStepWindow(client as never, ApprovalDocumentType.REPLENISHMENT_REQUEST, 2, seeded);
    expect(window).toEqual(seeded);
  });

  it('falls back to the seeded value when the settings row value is malformed (not an object)', async () => {
    const client = makeClient([{ key: 'approval.threshold.opname', value: 'not-an-object' }]);
    const seeded = { minAmount: '999.00', maxAmount: null };
    const window = await resolveStepWindow(client as never, ApprovalDocumentType.STOCK_OPNAME, 2, seeded);
    expect(window.minAmount).toBe('2000000.00'); // shared default, since the malformed settings row yields undefined
  });

  it('resolves payment_verification step 1 (owner gate) from live settings', async () => {
    const client = makeClient([{ key: 'approval.threshold.payment', value: { ownerAboveIdr: '25000000.00' } }]);
    const window = await resolveStepWindow(client as never, ApprovalDocumentType.PAYMENT_VERIFICATION, 1, { minAmount: '20000000.00', maxAmount: null });
    expect(window.minAmount).toBe('25000000.00');
  });
});

describe('isAmountInWindow', () => {
  it('is always in an unbounded window', () => {
    expect(isAmountInWindow('1.00', { minAmount: null, maxAmount: null })).toBe(true);
    expect(isAmountInWindow(null, { minAmount: null, maxAmount: null })).toBe(true);
  });

  it('excludes an amount below minAmount', () => {
    expect(isAmountInWindow('199999.99', { minAmount: '200000.00', maxAmount: null })).toBe(false);
  });

  it('includes an amount exactly at minAmount', () => {
    expect(isAmountInWindow('200000.00', { minAmount: '200000.00', maxAmount: null })).toBe(true);
  });

  it('treats a null amount against a minAmount window as NOT reaching the threshold', () => {
    expect(isAmountInWindow(null, { minAmount: '200000.00', maxAmount: null })).toBe(false);
  });

  it('excludes an amount at or above maxAmount (half-open window)', () => {
    expect(isAmountInWindow('500.00', { minAmount: null, maxAmount: '500.00' })).toBe(false);
    expect(isAmountInWindow('499.99', { minAmount: null, maxAmount: '500.00' })).toBe(true);
  });
});
