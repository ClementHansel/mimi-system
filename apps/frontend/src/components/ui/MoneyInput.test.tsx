import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { MoneyInput } from './MoneyInput';
import type { Money } from '@/lib/shared-types';

function Controlled({ initial, onChange }: { initial: Money | null; onChange: (v: Money | null) => void }) {
  const [value, setValue] = useState<Money | null>(initial);
  return (
    <MoneyInput
      label="Harga"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('MoneyInput', () => {
  it('shows the formatted value (no Rp prefix, grouped) when not focused', () => {
    render(<Controlled initial="125000.00" onChange={() => {}} />);
    expect(screen.getByLabelText('Harga')).toHaveValue('125.000');
  });

  it('switches to a raw digit buffer while focused', () => {
    render(<Controlled initial="125000.00" onChange={() => {}} />);
    const input = screen.getByLabelText('Harga');
    fireEvent.focus(input);
    expect(input).toHaveValue('125000');
  });

  it('strips non-digits as the user types', () => {
    render(<Controlled initial={null} onChange={() => {}} />);
    const input = screen.getByLabelText('Harga');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '45.000abc' } });
    expect(input).toHaveValue('45000');
  });

  it('commits the canonical Money decimal string on blur, never a float', () => {
    const onChange = vi.fn();
    render(<Controlled initial={null} onChange={onChange} />);
    const input = screen.getByLabelText('Harga');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '45000' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('45000.00');
  });

  it('reformats with the Rp-less grouped display after blur', () => {
    const onChange = vi.fn();
    render(<Controlled initial={null} onChange={onChange} />);
    const input = screen.getByLabelText('Harga');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '45000' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('45.000');
  });

  it('clears to null when blurred empty', () => {
    const onChange = vi.fn();
    render(<Controlled initial="1000.00" onChange={onChange} />);
    const input = screen.getByLabelText('Harga');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
