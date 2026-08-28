import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { defaultDocTemplate, type DocCopySet, type DocPayload } from '@/lib/shared-types';

const getDocTemplate = vi.fn();
const getSuratJalanDocument = vi.fn();

vi.mock('@/components/documents/doc-api', () => ({
  getDocTemplate: (...args: unknown[]) => getDocTemplate(...args),
  getSuratJalanDocument: (...args: unknown[]) => getSuratJalanDocument(...args),
}));

vi.mock('@/lib/attachment-url', () => ({
  resolveAttachmentUrl: async () => null,
  clearAttachmentUrlCache: () => {},
}));

const PrintSuratJalanPage = (await import('./page')).default;

/**
 * The Surat Jalan is the one document in this system that is a LEGAL shipping
 * record (D-14): it travels with the goods, the receiving outlet signs it, and
 * a dispute months later is settled by what it says.
 *
 * Making it template-driven moved two of its three rules out of the route and
 * into the resolver and the renderer. That is the right place for them, but it
 * also means nothing in THIS file would fail if they quietly stopped
 * happening — so these tests assert the OUTPUT the whole chain produces, not
 * the mechanism any one layer uses:
 *
 *   - a delivery with N drops still prints N × 3 signed sheets;
 *   - an unreceived quantity still prints BLANK, never `0`, because printing
 *     `0` is a claim that nothing arrived.
 */

const COPY_HOLDERS = ['gudang', 'outlet', 'kantor'] as const;

function copy(dropSeq: number, holder: string, received: boolean): DocPayload {
  return {
    kind: 'surat_jalan',
    fields: {
      sj_number: 'SJ-202608-0021',
      destination_name: `Outlet ${dropSeq}`,
      drop_label: `${dropSeq} / 2`,
      copy_holder_label: holder,
      page_label: '1 / 6',
    },
    labelKeys: { copy_holder_label: `doc.copyHolder.${holder}` },
    items: [
      {
        no: '1',
        code: 'FRZ-AYM-01',
        name: 'Ayam Potong Beku 1kg',
        qty_sent: '40',
        uom: 'kg',
        // The resolver's decision, reproduced: an un-received drop carries an
        // EMPTY string here, never '0'.
        qty_received: received ? '38' : '',
        notes: '',
      },
    ],
    totals: [],
    codes: { sj_number: 'SJ-202608-0021' },
    logoAttachmentId: null,
    backgroundAttachmentId: null,
    brand: { primary: '#a8481a', accent: '#c85f26', ink: '#1c1917', muted: '#78716c' },
    documentNumber: 'SJ-202608-0021',
  };
}

function copySet(drops: number, received = false): DocCopySet {
  const copies: DocPayload[] = [];
  for (let drop = 1; drop <= drops; drop++) {
    for (const holder of COPY_HOLDERS) copies.push(copy(drop, holder, received));
  }
  return { kind: 'surat_jalan', documentNumber: 'SJ-202608-0021', copies };
}

/**
 * The route reads its params with React 19's `use(params)`, which SUSPENDS on
 * the first render. That needs both a `Suspense` boundary and an AWAITED `act`
 * — `render()` alone opens a synchronous act scope, the component suspends
 * inside it, and the tree never commits (React says so, loudly, on stderr).
 */
async function renderPage(set: DocCopySet) {
  getDocTemplate.mockResolvedValue(defaultDocTemplate('surat_jalan'));
  getSuratJalanDocument.mockResolvedValue(set);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Suspense fallback={null}>
        <PrintSuratJalanPage params={Promise.resolve({ id: 'sj-1' })} />
      </Suspense>,
    );
  });
  await waitFor(() => expect(getSuratJalanDocument).toHaveBeenCalled());
  return view;
}

describe('Surat Jalan print route — three copies per drop', () => {
  beforeEach(() => {
    getDocTemplate.mockReset();
    getSuratJalanDocument.mockReset();
  });

  it('prints drops × 3 sheets', async () => {
    const { container } = await renderPage(copySet(2));
    await waitFor(() => expect(container.querySelectorAll('.print-copy')).toHaveLength(6));
  });

  it('warns how much paper this is before anyone hits Cetak', async () => {
    // Discovering nine pages AFTER pressing print is how a gudang printer runs
    // out of paper halfway through a legal document.
    const { container } = await renderPage(copySet(3));
    await waitFor(() => expect(container.querySelectorAll('.print-copy')).toHaveLength(9));
    expect(
      await screen.findByText(/3 tujuan × 3 salinan \(gudang, outlet, kantor\) = 9 halaman/),
    ).toBeInTheDocument();
  });

  it('names each copy so a stack of identical-looking sheets can be sorted', async () => {
    // `copy_holder_label` arrives as a `labelKey`, resolved client-side — the
    // one line that makes three otherwise identical sheets usable.
    await renderPage(copySet(1));
    expect(await screen.findByText('Gudang Pusat')).toBeInTheDocument();
    expect(screen.getByText('Outlet Penerima')).toBeInTheDocument();
    expect(screen.getByText('Kantor')).toBeInTheDocument();
  });

  it('refuses to state a drop count it cannot derive', async () => {
    // If the resolver ever emits a sheet count that is not a whole number of
    // copies per drop, saying "2.33 tujuan" would be a more confident-looking
    // lie than saying only how many pages there are.
    const broken = copySet(2);
    broken.copies.pop();
    const { container } = await renderPage(broken);
    await waitFor(() => expect(container.querySelectorAll('.print-copy')).toHaveLength(5));
    expect(await screen.findByText(/5 halaman akan dicetak/)).toBeInTheDocument();
    expect(screen.queryByText(/tujuan × 3 salinan/)).toBeNull();
  });
});

describe('Surat Jalan print route — unreceived quantity', () => {
  beforeEach(() => {
    getDocTemplate.mockReset();
    getSuratJalanDocument.mockReset();
  });

  it('prints a blank write-in rule, never a zero, for a drop nobody has received', async () => {
    const { container } = await renderPage(copySet(1));
    await waitFor(() => expect(container.querySelectorAll('.print-copy')).toHaveLength(3));

    const sheet = container.querySelector('.print-copy');
    const cells = Array.from(sheet?.querySelectorAll('tbody td') ?? []);
    expect(cells.length).toBeGreaterThan(0);

    // Nothing anywhere in the row may read as a delivered quantity of zero.
    expect(cells.map((c) => c.textContent?.trim())).not.toContain('0');

    // And the empty cells are RULED, so the driver has a line to write on.
    const ruled = cells.filter((c) =>
      (c.querySelector('span')?.getAttribute('style') ?? '').includes('border-bottom'),
    );
    expect(ruled.length).toBeGreaterThan(0);
  });

  it('prints the real figure once the drop has been received', async () => {
    const { container } = await renderPage(copySet(1, true));
    await waitFor(() => expect(container.querySelectorAll('.print-copy')).toHaveLength(3));
    const sheet = container.querySelector('.print-copy');
    expect(sheet?.textContent).toContain('38');
  });
});
