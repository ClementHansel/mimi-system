import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ReturnPanel } from './ReturnPanel';
import { useSessionStore } from '@/stores/session-store';
import * as warehouseApi from './lib/warehouse-api';

/**
 * FIX-LOADS #2 — every `returns` call from this panel used Indonesian-slang
 * direction values ('gudang_to_supplier' / 'outlet_to_gudang') that don't
 * exist in `@mimi/shared`'s `ReturnDirection` enum
 * ('outlet_to_warehouse' | 'warehouse_to_supplier'), so the backend's
 * `@IsIn` 400'd every request with ERR_VALIDATION — reproduced live via
 * `POST /api/returns` returning
 * `{"code":"ERR_VALIDATION","details":[{"field":"direction",...}]}`.
 * Locks the corrected values in so this can't silently regress back to the
 * old strings.
 */
vi.mock('./lib/warehouse-api', async (importOriginal) => {
  const actual = await importOriginal<typeof warehouseApi>();
  return {
    ...actual,
    listReturns: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 }),
    getItems: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 }),
    getStorageAreas: vi.fn().mockResolvedValue([]),
    getSupplierDirectory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 }),
  };
});

describe('ReturnPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      user: {
        id: 'u1', username: 'kepalagudang1', name: 'Test KGD', roleKey: 'kepala_gudang',
        permissions: ['return.read', 'return.create', 'return.ship'],
        locations: [{ id: 'loc-gdg', code: 'GDG', name: 'Gudang Pusat', type: 'warehouse', city: 'Balikpapan' }],
        employeeId: null, mustSetPin: false,
      },
    });
  });

  it('lists retur-ke-supplier using the real ReturnDirection enum value', () => {
    render(<ReturnPanel />);
    expect(warehouseApi.listReturns).toHaveBeenCalledWith({ direction: 'warehouse_to_supplier' });
  });

  it('lists retur-dari-outlet using the real ReturnDirection enum value', () => {
    render(<ReturnPanel />);
    expect(warehouseApi.listReturns).toHaveBeenCalledWith({ direction: 'outlet_to_warehouse', status: 'in_transit' });
  });
});
