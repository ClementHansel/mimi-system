import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScopeBanner } from './ScopeBanner';

/**
 * The ticket's non-negotiable requirement: "scope is visible in the
 * numbers." A Supervisor must never read their one-outlet figures as the
 * company total, and an Owner must never read a drill-down as the whole
 * business — this banner is the one place that distinction is spelled out.
 */
describe('ScopeBanner', () => {
  it('labels a company-wide view as covering every outlet, not one', () => {
    render(<ScopeBanner scope="company" />);
    expect(screen.getByText('Seluruh Perusahaan (Semua Outlet)')).toBeInTheDocument();
    expect(screen.getByText(/mencakup semua outlet/)).toBeInTheDocument();
  });

  it('labels a scoped view with the specific outlet name, not a generic label', () => {
    render(
      <ScopeBanner scope="outlet" outletName="Outlet Balikpapan Baru" outletCity="Balikpapan" />,
    );
    expect(screen.getByText('Outlet Anda: Outlet Balikpapan Baru')).toBeInTheDocument();
    expect(screen.getByText(/hanya untuk outlet ini \(Balikpapan\)/)).toBeInTheDocument();
  });

  it('falls back to an explicit "unknown" label rather than showing a blank outlet name', () => {
    render(<ScopeBanner scope="outlet" outletName={null} />);
    expect(screen.getByText('Outlet Anda: Tidak Diketahui')).toBeInTheDocument();
  });

  it('never shows the company-scope wording for an outlet-scoped view', () => {
    render(<ScopeBanner scope="outlet" outletName="Outlet A" />);
    expect(screen.queryByText('Seluruh Perusahaan (Semua Outlet)')).not.toBeInTheDocument();
  });
});
