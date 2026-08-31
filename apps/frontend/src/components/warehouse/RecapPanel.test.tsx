import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecapPanel } from './RecapPanel';
import * as warehouseApi from './lib/warehouse-api';
import type { DailyRecap } from './lib/types';

/**
 * The recap used to render EVERY city's full item list, unconditionally, on one
 * page — no day total anywhere, so "how much chicken moves today" meant adding
 * four tables by eye. These tests pin the replacement: the panel opens on the
 * AGGREGATE, and the city/outlet filters narrow both the table and the headline
 * counts together.
 *
 * The fixture is deliberately built so a bug that merely CONCATENATES the city
 * lists cannot pass: `Ayam` appears in both cities and in both Balikpapan
 * outlets, so the aggregate row must be a SUM (10 + 4 + 6 = 20), and the two
 * Balikpapan outlets must fold to 14 rather than appear twice.
 *
 * It also pins the counts NOT being sums: SJ-2 drops at both Balikpapan
 * outlets, so the city sees 2 distinct Surat Jalan while its outlets report 2
 * and 1 — per-outlet counts that add to more than the city's are correct here,
 * and a "fix" that makes them add up would be the regression.
 */
const RECAP: DailyRecap = {
  date: '2026-08-30',
  sjCount: 3,
  dropCount: 4,
  frozenSjCount: 2,
  drySjCount: 1,
  byCity: [
    {
      city: 'Balikpapan',
      outlets: 2,
      sjCount: 2,
      dropCount: 3,
      frozenSjCount: 1,
      drySjCount: 1,
      items: [
        { itemId: 'i-ayam', itemName: 'Ayam', qty: '14' },
        { itemId: 'i-beras', itemName: 'Beras', qty: '5' },
      ],
      byOutlet: [
        {
          locationId: 'loc-bpp1',
          locationName: 'Outlet BPP 1',
          sjCount: 2,
          dropCount: 2,
          frozenSjCount: 1,
          drySjCount: 1,
          items: [
            { itemId: 'i-ayam', itemName: 'Ayam', qty: '10' },
            { itemId: 'i-beras', itemName: 'Beras', qty: '5' },
          ],
        },
        {
          locationId: 'loc-bpp2',
          locationName: 'Outlet BPP 2',
          sjCount: 1,
          dropCount: 1,
          frozenSjCount: 0,
          drySjCount: 1,
          items: [{ itemId: 'i-ayam', itemName: 'Ayam', qty: '4' }],
        },
      ],
    },
    {
      city: 'Samarinda',
      outlets: 1,
      sjCount: 1,
      dropCount: 1,
      frozenSjCount: 1,
      drySjCount: 0,
      items: [{ itemId: 'i-ayam', itemName: 'Ayam', qty: '6' }],
      byOutlet: [
        {
          locationId: 'loc-smd1',
          locationName: 'Outlet SMD 1',
          sjCount: 1,
          dropCount: 1,
          frozenSjCount: 1,
          drySjCount: 0,
          items: [{ itemId: 'i-ayam', itemName: 'Ayam', qty: '6' }],
        },
      ],
    },
  ],
};

vi.mock('./lib/warehouse-api', async (importOriginal) => {
  const actual = await importOriginal<typeof warehouseApi>();
  return { ...actual, getDailyRecap: vi.fn() };
});

/**
 * The scope heading. Queried by ROLE, not by text: 'Balikpapan' is also the
 * label of an <option> in the city dropdown, so a bare getByText matches twice.
 */
function scopeHeading(): string {
  return screen.getByRole('heading', { level: 3 }).textContent ?? '';
}

/** The qty cell of the row whose first cell is `name`. */
function qtyOf(name: string): string {
  const cell = screen.getByText(name);
  const row = cell.closest('tr');
  return row?.lastElementChild?.textContent?.trim() ?? '';
}

describe('RecapPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(warehouseApi.getDailyRecap).mockResolvedValue(RECAP);
  });

  it('opens on the all-cities aggregate, summing an item across cities and outlets', async () => {
    render(<RecapPanel />);
    await screen.findByRole('heading', { level: 3 });

    // One row per item for the whole day, not one table per city.
    expect(qtyOf('Ayam')).toBe('20');
    expect(qtyOf('Beras')).toBe('5');
    expect(scopeHeading()).toBe('Semua Kota & Outlet');
    expect(screen.getByText('3 outlet · 2 barang')).toBeInTheDocument();
  });

  it('narrows the table and the headline counts to the chosen city', async () => {
    render(<RecapPanel />);
    await screen.findByRole('heading', { level: 3 });

    fireEvent.change(screen.getByLabelText('Kota'), { target: { value: 'Balikpapan' } });

    await waitFor(() => expect(scopeHeading()).toBe('Balikpapan'));
    expect(qtyOf('Ayam')).toBe('14');
    // The cards followed the filter — day-wide they read 3 / 4.
    const sjCard = screen.getByText('Surat Jalan').previousElementSibling;
    expect(sjCard?.textContent).toBe('2');
    const dropCard = screen.getByText('Total Drop').previousElementSibling;
    expect(dropCard?.textContent).toBe('3');
  });

  it('narrows to a single outlet within the chosen city', async () => {
    render(<RecapPanel />);
    await screen.findByRole('heading', { level: 3 });

    fireEvent.change(screen.getByLabelText('Kota'), { target: { value: 'Balikpapan' } });
    fireEvent.change(screen.getByLabelText('Outlet'), { target: { value: 'loc-bpp2' } });

    await waitFor(() => expect(scopeHeading()).toBe('Balikpapan — Outlet BPP 2'));
    expect(qtyOf('Ayam')).toBe('4');
    expect(screen.queryByText('Beras')).not.toBeInTheDocument();
  });

  it('offers only the chosen city’s outlets, and drops the pick when the city changes', async () => {
    render(<RecapPanel />);
    await screen.findByRole('heading', { level: 3 });

    const outletSelect = screen.getByLabelText('Outlet') as HTMLSelectElement;
    // Nothing to pick before a city is chosen — an outlet list spanning every
    // city is exactly the flat, un-navigable list this panel replaced.
    expect(outletSelect).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Kota'), { target: { value: 'Balikpapan' } });
    fireEvent.change(outletSelect, { target: { value: 'loc-bpp1' } });
    expect(outletSelect.value).toBe('loc-bpp1');

    fireEvent.change(screen.getByLabelText('Kota'), { target: { value: 'Samarinda' } });
    // A stale 'loc-bpp1' here would be a select holding a value its own
    // dropdown no longer offers, and a table showing another city's outlet.
    await waitFor(() => expect(outletSelect.value).toBe('all'));
    await waitFor(() => expect(scopeHeading()).toBe('Samarinda'));
    expect(qtyOf('Ayam')).toBe('6');
  });

  it('filters the item list by name within the current scope', async () => {
    render(<RecapPanel />);
    await screen.findByRole('heading', { level: 3 });

    fireEvent.change(screen.getByPlaceholderText('Cari barang…'), { target: { value: 'ber' } });

    expect(screen.getByText('Beras')).toBeInTheDocument();
    expect(screen.queryByText('Ayam')).not.toBeInTheDocument();
  });
});
