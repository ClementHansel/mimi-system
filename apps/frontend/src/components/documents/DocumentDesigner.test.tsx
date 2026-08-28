import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { defaultDocTemplate, type DocTemplate } from '@/lib/shared-types';

const getDocTemplate = vi.fn();
const putDocTemplate = vi.fn();
const resetDocTemplate = vi.fn();

vi.mock('./doc-api', () => ({
  getDocTemplate: (...args: unknown[]) => getDocTemplate(...args),
  putDocTemplate: (...args: unknown[]) => putDocTemplate(...args),
  resetDocTemplate: (...args: unknown[]) => resetDocTemplate(...args),
}));

// The designer resolves its background letterhead through the attachment
// presign path on mount. Stubbed so these tests do not depend on the network
// or on a session — the URL itself is irrelevant to everything asserted here.
vi.mock('@/lib/attachment-url', () => ({
  resolveAttachmentUrl: async () => null,
  clearAttachmentUrlCache: () => {},
}));

const { DocumentDesigner } = await import('./DocumentDesigner');

/**
 * What these tests protect, in order of how expensive the bug would be.
 *
 *  1. SAVE VALIDATION. The designer runs the SHARED `validateDocTemplate`
 *     before it sends, so it refuses exactly what the server would refuse.
 *     If that check were dropped, an owner would drag a total off the page,
 *     click Save, get a generic failure toast, and have no way to learn which
 *     element was wrong.
 *  2. KEYBOARD NUDGE. `aire`'s canvas is drag-only. Fine positioning and
 *     pointer-free use both depend on the arrow keys actually moving the
 *     selected element, and that is easy to break silently by changing where
 *     focus lives.
 *  3. ADD + SELECT. The palette is driven from `DOC_CATALOGS`, so an element
 *     that adds but cannot be selected is an element an owner cannot configure.
 */

async function renderDesigner(template: DocTemplate = defaultDocTemplate('invoice')) {
  getDocTemplate.mockResolvedValue(template);
  const view = render(<DocumentDesigner kind="invoice" />);
  await waitFor(() => expect(screen.getByText('Simpan Tata Letak')).toBeInTheDocument());
  return view;
}

/** The x-position field in the properties panel — the readable proxy for "where is it". */
function xField(): HTMLInputElement {
  return screen.getByLabelText('Posisi X') as HTMLInputElement;
}

describe('DocumentDesigner', () => {
  beforeEach(() => {
    getDocTemplate.mockReset();
    putDocTemplate.mockReset();
    resetDocTemplate.mockReset();
  });

  it('adds an element from the palette and selects it', async () => {
    await renderDesigner();

    // The palette button and the new element's canvas hitbox share a label;
    // only the hitbox carries it as an `aria-label`, which is what
    // `getByLabelText` matches.
    expect(screen.queryByLabelText('Teks')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Teks' }));

    const hitbox = await screen.findByLabelText('Teks');
    expect(hitbox).toBeInTheDocument();
    // Adding selects, so the properties panel is immediately usable — an owner
    // who has to hunt for the box they just added will assume the click failed.
    expect(hitbox).toHaveAttribute('aria-pressed', 'true');
    expect(xField()).toBeInTheDocument();
  });

  it('offers only the field tokens this kind advertises', async () => {
    await renderDesigner();
    // `getAllByRole`, not `getByRole`: a token that is ALREADY placed on the
    // seeded template has both a palette button and a canvas hitbox with the
    // same accessible name, which is correct — they are two ways to reach the
    // same idea.
    // Driven off `DOC_CATALOGS.invoice.fields`, never a list in the component.
    expect(screen.getAllByRole('button', { name: 'Nomor Faktur' }).length).toBeGreaterThan(0);
    // A receipt-only token must not be placeable on an invoice: a token no
    // invoice resolver fills prints as an empty box on a real customer's bill.
    expect(screen.queryAllByRole('button', { name: 'Kembalian' })).toHaveLength(0);
  });

  it('nudges the selected element with the arrow keys, and a grid step with Shift', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByRole('button', { name: 'Teks' }));
    const hitbox = await screen.findByLabelText('Teks');

    const before = Number(xField().value);

    fireEvent.keyDown(hitbox, { key: 'ArrowRight' });
    expect(Number(xField().value)).toBe(before + 1);

    fireEvent.keyDown(hitbox, { key: 'ArrowLeft' });
    expect(Number(xField().value)).toBe(before);

    // Shift moves by the snap grid, so a nudged element stays on the same
    // alignment as everything that was dragged.
    fireEvent.keyDown(hitbox, { key: 'ArrowRight', shiftKey: true });
    expect(Number(xField().value)).toBe(before + 4);
  });

  it('deletes the selected element from the keyboard', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByRole('button', { name: 'Teks' }));
    const hitbox = await screen.findByLabelText('Teks');

    fireEvent.keyDown(hitbox, { key: 'Delete' });

    await waitFor(() => expect(screen.queryByLabelText('Teks')).toBeNull());
  });

  it('refuses to save a layout the server would reject, and names the element', async () => {
    await renderDesigner();
    fireEvent.click(screen.getByRole('button', { name: 'Teks' }));
    await screen.findByLabelText('Teks');

    // Push the element hard against the right edge so it overhangs the page.
    fireEvent.change(xField(), { target: { value: '794' } });
    fireEvent.click(screen.getByText('Simpan Tata Letak'));

    const problems = await screen.findByText('Tata letak belum bisa disimpan');
    expect(problems).toBeInTheDocument();
    // The validator's own wording, verbatim — it names the index of the
    // offending element, which is the only thing that makes the error
    // actionable.
    expect(
      within(problems.parentElement as HTMLElement).getByText(
        /extends outside the 794px page width/,
      ),
    ).toBeInTheDocument();
    expect(putDocTemplate).not.toHaveBeenCalled();
  });

  it('sends a valid layout and adopts what the server stored', async () => {
    const template = defaultDocTemplate('invoice');
    await renderDesigner(template);
    putDocTemplate.mockImplementation(async (_kind: string, tpl: DocTemplate) => tpl);

    fireEvent.click(screen.getByRole('button', { name: 'Teks' }));
    await screen.findByLabelText('Teks');
    fireEvent.click(screen.getByText('Simpan Tata Letak'));

    await waitFor(() => expect(putDocTemplate).toHaveBeenCalledTimes(1));
    const [kind, sent] = putDocTemplate.mock.calls[0] as [string, DocTemplate];
    expect(kind).toBe('invoice');
    expect(sent.elements).toHaveLength(template.elements.length + 1);
  });

  it('keeps table column widths summing to the table width when one is resized', async () => {
    // Not cosmetic: the renderer emits a fixed-width `<colgroup>` inside a
    // `table-layout: fixed` table, so widths that do not sum to the element
    // silently compress every column and the rightmost money column loses its
    // last digits on paper.
    const template = defaultDocTemplate('invoice');
    await renderDesigner(template);

    const table = template.elements.find((e) => e.type === 'table');
    expect(table).toBeDefined();
    fireEvent.click(screen.getByLabelText('Tabel Barang'));

    const widthInputs = screen.getAllByLabelText('Lebar Kolom') as HTMLInputElement[];
    const first = widthInputs[0];
    expect(first).toBeDefined();
    fireEvent.change(first as HTMLInputElement, { target: { value: '120' } });

    const total = (screen.getAllByLabelText('Lebar Kolom') as HTMLInputElement[]).reduce(
      (sum, input) => sum + Number(input.value),
      0,
    );
    expect(total).toBe(table?.w);
  });
});
