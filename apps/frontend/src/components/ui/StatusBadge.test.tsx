import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders the domain-specific Indonesian label', () => {
    render(<StatusBadge domain="replenishment" status="awaiting_approval" />);
    expect(screen.getByText('Menunggu Persetujuan')).toBeInTheDocument();
  });

  it('renders a different label for the same raw value in a different domain', () => {
    render(<StatusBadge domain="pettyCash" status="pending" />);
    expect(screen.getByText('Menunggu Verifikasi')).toBeInTheDocument();
  });

  it('falls back to a prettified raw value for an unrecognized status (schema drift safety)', () => {
    render(<StatusBadge domain="replenishment" status="some_future_status" />);
    expect(screen.getByText('Some Future Status')).toBeInTheDocument();
  });
});
