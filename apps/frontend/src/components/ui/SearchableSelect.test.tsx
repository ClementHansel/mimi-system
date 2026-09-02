import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SearchableSelect } from './SearchableSelect';

/**
 * THE COMBOBOX MUST SAY WHAT IT IS FOR.
 *
 * `SearchableSelect` renders a `role="combobox"` BUTTON whose visible text is
 * the placeholder ("Pilih…"). Its `<label htmlFor>` is a valid association for
 * a button in HTML, but the accessible-name algorithm does not use it for one:
 * a button is named by `aria-label`, `aria-labelledby`, or its own text — in
 * that order — and never by a `for` attribute pointing at it.
 *
 * So every one of these announced itself as "Pilih…". The purchase-request
 * dialog has THREE (warehouse, item, supplier) and to anyone not looking at the
 * screen they were indistinguishable. Found 2026-09-02 while driving that form
 * in a browser test, which could not tell them apart either — exactly the
 * information a screen reader was missing.
 *
 * ── WHY THESE ASSERT ON THE ATTRIBUTE, NOT ON THE ROLE NAME ─────────────────
 * The obvious test — `getByRole('combobox', { name: /Tujuan Pengiriman/ })` —
 * PASSES WITHOUT THE FIX. jsdom's accessible-name computation follows
 * `<label for>` to a button; real browsers do not. That was verified by
 * deleting `aria-labelledby` and watching all three role-name assertions stay
 * green, which is worse than having no test at all: it is a guard that reports
 * safety while the defect is present.
 *
 * So the unit layer asserts the WIRING it can actually see, and the real
 * accessible name is asserted in the browser, where the computation is the one
 * a screen reader uses — `ops-purchasing.spec.ts` selects these pickers by
 * their accessible name and fails if they are anonymous again.
 */
describe('SearchableSelect — accessible name wiring', () => {
  const OPTIONS = [
    { value: 'a', label: 'Gudang Pusat Balikpapan' },
    { value: 'b', label: 'Gudang Samarinda' },
  ];

  it('points aria-labelledby at its own rendered label', () => {
    render(
      <SearchableSelect
        label="Tujuan Pengiriman (Gudang)"
        options={OPTIONS}
        value=""
        onValueChange={() => {}}
      />,
    );

    const combobox = screen.getByRole('combobox');
    const labelledBy = combobox.getAttribute('aria-labelledby');
    expect(labelledBy, 'the combobox is anonymous — it will announce "Pilih…"').toBeTruthy();

    const label = document.getElementById(labelledBy!);
    expect(label, 'aria-labelledby points at an element that does not exist').not.toBeNull();
    expect(label!.textContent).toContain('Tujuan Pengiriman');
  });

  it('gives two pickers on one form two different names', () => {
    // The actual defect was several identical announcements on one form, so one
    // control being named proves nothing on its own.
    render(
      <div>
        <SearchableSelect label="Item" options={OPTIONS} value="" onValueChange={() => {}} />
        <SearchableSelect label="Supplier" options={OPTIONS} value="" onValueChange={() => {}} />
      </div>,
    );

    const [first, second] = screen.getAllByRole('combobox');
    const nameOf = (el: HTMLElement) =>
      document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? '';

    expect(nameOf(first)).toContain('Item');
    expect(nameOf(second)).toContain('Supplier');
    expect(nameOf(first)).not.toBe(nameOf(second));
  });

  it('carries no dangling reference when it has no label', () => {
    // `aria-labelledby` must never point at an element that was not rendered:
    // assistive tech resolves a dangling id to the empty string, so the control
    // becomes anonymous with no fallback to its own text.
    render(<SearchableSelect options={OPTIONS} value="" onValueChange={() => {}} />);

    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-labelledby');
  });
});
