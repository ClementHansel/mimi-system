import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { api } from '@/lib/api';
import { useSessionStore } from '@/stores/session-store';
import { MasterDataPanel } from './MasterDataPanel';

/**
 * F-POS-3 — "Product form in Data Master → Produk & Resep gains the two
 * channel prices, clearly labelled and clearly optional." This drives the
 * real create-product flow (tab -> "Tambah Produk" -> fill required fields
 * -> save) and asserts the POST body sends `priceGofood`/`priceShopeefood`
 * as explicit `null` when left empty — the form-level half of the
 * null->walk-in fallback contract (`channel-pricing.test.ts` pins the
 * pricing-function half).
 */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn((path: string) => {
        if (path.startsWith('/products/categories')) {
          return Promise.resolve([
            { id: 'c1', name: 'Ayam', sortOrder: 0, isActive: true, productCount: 0 },
          ]);
        }
        if (path.startsWith('/items?')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
      }),
      post: vi.fn().mockResolvedValue({ id: 'p1' }),
    },
  };
});

describe('MasterDataPanel — product form channel prices (F-POS-3)', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockClear();
    useSessionStore.setState({
      user: {
        id: 'u1',
        username: 'owner1',
        name: 'Owner Satu',
        roleKey: 'owner',
        permissions: ['product.manage'],
        locations: [],
        employeeId: null,
        mustSetPin: false,
      },
    });
  });

  it('creates a product with priceGofood/priceShopeefood explicitly null when left empty ("same as walk-in")', async () => {
    render(<MasterDataPanel />);

    fireEvent.click(await screen.findByText('Produk & Resep'));
    fireEvent.click(await screen.findByText('Tambah Produk'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Kode/), { target: { value: 'AYG01' } });
    fireEvent.change(within(dialog).getByLabelText(/^Nama/), { target: { value: 'Ayam Goreng' } });

    // Walk-in price is filled (MoneyInput commits on blur — type then blur).
    const walkInPrice = within(dialog).getByLabelText('Harga Jual (Kasir)');
    fireEvent.focus(walkInPrice);
    fireEvent.change(walkInPrice, { target: { value: '15000' } });
    fireEvent.blur(walkInPrice);

    // The two channel prices are deliberately left EMPTY — the "leave blank
    // = same as walk-in" case this test exists to pin.
    expect(within(dialog).getByLabelText('Harga GoFood')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Harga ShopeeFood')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText('Simpan'));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, body] = vi.mocked(api.post).mock.calls[0]!;
    expect(path).toBe('/products');
    expect(body).toMatchObject({
      code: 'AYG01',
      name: 'Ayam Goreng',
      price: '15000.00',
      priceGofood: null,
      priceShopeefood: null,
    });
  });
});
