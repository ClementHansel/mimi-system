import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DocPayload } from '@/lib/shared-types';

const get = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: (...args: unknown[]) => get(...args) } };
});

const { docDataFromPayload, docDataFromCopySet, clearAttachmentUrlCache } =
  await import('./doc-payload');

/**
 * The merge direction is the whole contract of `DocPayload`, and getting it
 * backwards is invisible until somebody holds the paper: the server sends a
 * machine-safe stand-in in `fields` for a token whose real value is COPY, plus
 * the i18n key it should be replaced with. Merge the wrong way round and an
 * invoice's heading prints as `document_title` or as the enum literal instead
 * of "FAKTUR".
 *
 * See `packages/shared/src/documents/payload.ts` for why the split exists at
 * all (the backend may not hold Bahasa Indonesia copy — BUILD-PLAN §6.9).
 */

function payload(overrides: Partial<DocPayload> = {}): DocPayload {
  return {
    kind: 'invoice',
    fields: {
      document_title: 'invoice',
      party_label: 'customer',
      invoice_number: 'INV-202608-0147',
    },
    labelKeys: {
      document_title: 'doc.title.invoice',
      party_label: 'doc.party.customer',
    },
    items: [],
    totals: [{ key: 'total', value: 'Rp36.000', strong: true }],
    codes: { invoice_number: 'INV-202608-0147' },
    logoAttachmentId: null,
    backgroundAttachmentId: null,
    brand: { primary: '#a8481a', accent: '#c85f26', ink: '#1c1917', muted: '#78716c' },
    documentNumber: 'INV-202608-0147',
    ...overrides,
  };
}

describe('docDataFromPayload — labelKeys merge OVER fields', () => {
  beforeEach(() => {
    get.mockReset();
    clearAttachmentUrlCache();
  });

  it('replaces a field value with its resolved label', async () => {
    const data = await docDataFromPayload(payload());
    expect(data.fields.document_title).toBe('FAKTUR');
    expect(data.fields.party_label).toBe('Ditagihkan Kepada');
  });

  it('leaves fields that have no labelKey untouched', async () => {
    const data = await docDataFromPayload(payload());
    expect(data.fields.invoice_number).toBe('INV-202608-0147');
  });

  it('never lets an unresolvable key reach the paper — it keeps the server value', async () => {
    // The failure this prevents: `doc.title.kwitansi` printed in 30pt bold at
    // the top of a customer's invoice because the backend named a key this
    // dictionary does not have.
    const data = await docDataFromPayload(
      payload({
        fields: { document_title: 'FAKTUR PENJUALAN' },
        labelKeys: { document_title: 'doc.title.does_not_exist' },
      }),
    );
    expect(data.fields.document_title).toBe('FAKTUR PENJUALAN');
  });

  it('tolerates the sibling namespace a parallel backend may emit', async () => {
    // `docs.*` vs `doc.*` — see the shim's comment in `doc-payload.ts` and the
    // long note above `doc:` in `lib/i18n/id.ts`. This is a compatibility
    // bridge with an owner and an expiry, not a permanent feature.
    const data = await docDataFromPayload(
      payload({ labelKeys: { document_title: 'docs.title.invoice' } }),
    );
    expect(data.fields.document_title).toBe('FAKTUR');
  });

  it('passes brand, totals and codes through unchanged', async () => {
    const data = await docDataFromPayload(payload());
    expect(data.brand.primary).toBe('#a8481a');
    expect(data.totals).toEqual([{ key: 'total', value: 'Rp36.000', strong: true }]);
    expect(data.codes.invoice_number).toBe('INV-202608-0147');
  });
});

describe('docDataFromPayload — attachment resolution', () => {
  beforeEach(() => {
    get.mockReset();
    clearAttachmentUrlCache();
  });

  it('presigns the logo once for a whole copy set', async () => {
    // A Surat Jalan is drops × 3 sheets and every one carries the same logo.
    // Without the cache this is one authenticated round trip per sheet before
    // a single page can render, on a tablet on mobile data.
    get.mockResolvedValue({ url: 'https://minio/logo', expiresAt: '2099-01-01T00:00:00.000Z' });
    const copies = [payload(), payload(), payload()].map((p) => ({
      ...p,
      logoAttachmentId: 'att-1',
    }));
    const sheets = await docDataFromCopySet({
      kind: 'surat_jalan',
      documentNumber: 'SJ-1',
      copies,
    });
    expect(sheets).toHaveLength(3);
    expect(sheets.every((s) => s.logoUrl === 'https://minio/logo')).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('renders the document without its logo rather than failing the print', async () => {
    // A print path that throws because a presign failed produces a blank page.
    // Returning null produces the document minus its letterhead, which is the
    // outcome every party in the room would choose.
    get.mockRejectedValue(new Error('boom'));
    const data = await docDataFromPayload(payload({ logoAttachmentId: 'att-1' }));
    expect(data.logoUrl).toBeNull();
  });
});
