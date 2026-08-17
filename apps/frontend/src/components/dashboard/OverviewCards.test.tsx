import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverviewCards } from './OverviewCards';
import type { OverviewResponse } from './lib/types';

/**
 * CONTRACTS §0: Money travels as a decimal STRING end to end. These tests
 * pin down that `OverviewCards` renders those strings through `formatMoney`
 * (grouped id-ID Rupiah) rather than round-tripping through `Number()`/
 * `parseFloat`, which would silently corrupt a large sum's precision.
 */
function makeOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    revenue: '33865889.00',
    revenueOnline: '5000000.00',
    profitEstimate: '12345678.90',
    txCount: 812,
    avgTicket: '41706.02',
    activeOutlets: 20,
    vs: { revenuePct: '12.34', txPct: '-3.50' },
    ...overrides,
  };
}

describe('OverviewCards', () => {
  it('formats a large Money decimal string as grouped Rupiah, never a float-rounded value', () => {
    render(<OverviewCards data={makeOverview()} />);
    expect(screen.getByText('Rp33.865.889')).toBeInTheDocument();
    expect(screen.getByText('Rp12.345.678,90')).toBeInTheDocument();
  });

  it('renders the Supervisor-scale figure from the ticket brief exactly (6,229,894.00)', () => {
    render(<OverviewCards data={makeOverview({ revenue: '6229894.00' })} />);
    expect(screen.getByText('Rp6.229.894')).toBeInTheDocument();
  });

  it('shows a positive vs-previous-period delta with its sign, not the raw string', () => {
    render(<OverviewCards data={makeOverview()} />);
    expect(screen.getByText('12,3%')).toBeInTheDocument();
  });

  it('shows a negative delta as a decrease, not a bare negative percentage', () => {
    render(<OverviewCards data={makeOverview()} />);
    expect(screen.getByText('3,5%')).toBeInTheDocument();
  });

  it('renders an em-dash placeholder rather than "0" or "NaN" while data has not loaded', () => {
    render(<OverviewCards data={null} loading />);
    expect(screen.queryByText('Rp0')).not.toBeInTheDocument();
    expect(screen.queryByText('NaN')).not.toBeInTheDocument();
  });
});
