import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { api } from '@/lib/api';
import { MasterDataPanel } from './MasterDataPanel';

/**
 * FIX-LOADS #4 — the recipe editor's "Bahan" ingredient dropdown came up
 * empty because this lookup fetch requested `pageSize=500`; the backend
 * caps `pageSize` at 200 (`ListItemsQueryDto`'s `@Max(200)`, CONTRACTS.md's
 * global pagination rule) and 400'd with ERR_VALIDATION on every call,
 * silently swallowed by `.catch(() => {})` — so `items` never populated.
 * Reproduced live via `GET /api/items?pageSize=500` returning
 * `{"code":"ERR_VALIDATION","details":[{"field":"pageSize",...}]}`.
 */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    },
  };
});

describe('MasterDataPanel — items lookup for the recipe editor', () => {
  it('requests the item lookup with a pageSize within the backend-enforced max of 200', async () => {
    render(<MasterDataPanel />);

    await waitFor(() => {
      const itemsLookupCall = vi
        .mocked(api.get)
        .mock.calls.find(([path]) => (path as string).startsWith('/items?'));
      expect(itemsLookupCall).toBeDefined();
      const qs = new URLSearchParams((itemsLookupCall![0] as string).split('?')[1]);
      if (qs.has('pageSize')) expect(Number(qs.get('pageSize'))).toBeLessThanOrEqual(200);
    });
  });
});
