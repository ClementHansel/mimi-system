import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';
import { Textarea } from './Textarea';

/**
 * The regression these tests exist for: typing inside a modal used to steal
 * focus back to the close button after EVERY keystroke.
 *
 * `Modal`'s setup effect (scroll lock, focus trap, initial focus) had `onClose`
 * in its dependency array, and every caller passes an inline arrow — a new
 * identity per render. So each character typed re-rendered the parent, tore the
 * effect down (restoring focus to the trigger) and set it up again (focusing
 * the dialog's first focusable, the X). The owner hit it on the "Nonaktifkan
 * Mode Statutori" reason box: write one letter, click the box, write one more.
 *
 * A `Controlled` wrapper with an inline `onClose` is therefore not incidental
 * to these tests — it is the exact shape that broke.
 */
function Controlled({ onClose }: { onClose?: () => void }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(true);
  return (
    <Modal
      open={open}
      // Inline arrow, re-created on every render — the trap.
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
      title="Nonaktifkan Mode Statutori?"
    >
      <Textarea label="Alasan" value={value} onChange={(e) => setValue(e.target.value)} required />
    </Modal>
  );
}

describe('Modal', () => {
  it('keeps focus in a field across keystrokes, despite an inline onClose', () => {
    render(<Controlled />);
    const field = screen.getByLabelText(/Alasan/);

    // Three separate change events — one per character, as real typing does.
    for (const text of ['t', 'te', 'tes']) {
      fireEvent.change(field, { target: { value: text } });
      expect(document.activeElement).toBe(field);
    }
    expect(field).toHaveValue('tes');
  });

  it('opens with the first field focused, not the close button', () => {
    render(<Controlled />);
    expect(document.activeElement).toBe(screen.getByLabelText(/Alasan/));
  });

  it('still closes on Escape after the parent has re-rendered', () => {
    // The ref must stay current: an Escape handler captured at open time would
    // call a stale closure. Typing first forces the re-render that would expose
    // that mistake.
    const onClose = vi.fn();
    render(<Controlled onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/Alasan/), { target: { value: 'x' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
