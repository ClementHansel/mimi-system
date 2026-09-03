'use client';

import { use, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, EmptyState, Input, MoneyInput, QtyInput, Textarea } from '@/components/ui';
import { PrintFrame } from '@/components/print/PrintFrame';
import { DocumentRenderer, DocPageStyle } from '@/components/documents/DocumentRenderer';
import { docDataFromPayload } from '@/components/documents/doc-payload';
import {
  createManualInvoiceDocument,
  getDocTemplate,
  getInvoiceDocument,
  type ManualInvoiceLine,
} from '@/components/documents/doc-api';
import {
  isInvoiceSource,
  type DocData,
  type DocPayload,
  type DocTemplate,
  type Money,
  type Qty,
} from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * F-DOC print route — the printable invoice, for THREE different origins of
 * "who is being billed":
 *
 *  - `sale`           — a POS sale, resolved server-side from the order.
 *  - `purchase_order` — a PO, billed the other direction (we owe a supplier).
 *  - `manual`         — nobody's row exists yet; this page IS the entry form.
 *
 * One template (`getDocTemplate('invoice')`) serves all three, because
 * `DOC_CATALOGS.invoice` deliberately names its bill-to fields `party_*`
 * rather than `customer_*`/`supplier_*` (see `@mimi/shared`'s
 * `documents/catalog.ts`) — an owner who lays out one invoice layout should
 * not have to lay out three just because who is billed changes.
 *
 * `[id]` is a real UUID for `sale`/`purchase_order` and the literal string
 * `baru` ("new") for `manual` — there is no row to key on until the form
 * below creates one. That is why the manual branch never reads `id` at all;
 * it exists only so the URL shape (`/print/invoice/:source/:id`) stays
 * uniform across all three origins, which is what lets one dynamic route
 * serve them instead of a `/print/invoice-manual` route living apart from
 * its siblings.
 */
export default function PrintInvoicePage({
  params,
}: {
  params: Promise<{ source: string; id: string }>;
}) {
  const { source: rawSource, id } = use(params);
  const { t } = useI18n();

  // An unrecognised `source` segment is a bad link, not a data-load failure —
  // it never reaches the network, so it gets its own bare empty state rather
  // than being funnelled through `PrintFrame` (which expects a real title and
  // a document that might still arrive).
  if (!isInvoiceSource(rawSource)) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <EmptyState title={t('doc.print.notFound')} size="lg" />
      </div>
    );
  }

  return rawSource === 'manual' ? (
    <ManualInvoicePrint />
  ) : (
    <SourcedInvoicePrint source={rawSource} id={id} />
  );
}

/**
 * `sale` / `purchase_order`: a row already exists server-side, so this is the
 * same "fetch template + payload in parallel, then render" shape as every
 * other print route.
 */
function SourcedInvoicePrint({ source, id }: { source: 'sale' | 'purchase_order'; id: string }) {
  const { t } = useI18n();
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [data, setData] = useState<DocData | null>(null);
  const [documentNumber, setDocumentNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDocTemplate('invoice'), getInvoiceDocument(source, id)])
      .then(async ([tpl, payload]) => {
        const doc = await docDataFromPayload(payload, t);
        if (cancelled) return;
        setTemplate(tpl);
        setData(doc);
        setDocumentNumber(payload.documentNumber);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errMsg(err, t('doc.print.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [source, id, t]);

  const ready = !!template && !!data;

  return (
    <PrintFrame
      title={t('doc.print.invoiceTitle')}
      documentNumber={documentNumber}
      ready={ready}
      // A template-driven sheet carries its own letterhead — see
      // `PrintReceiptPage` for the fuller version of this note, which applies
      // identically here.
      letterhead={false}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!ready && !error && <p className="text-sm">{t('common.loading')}</p>}
      {ready && template && data && (
        <>
          <DocPageStyle width={template.width} height={template.height} />
          <div className="print-copy">
            <DocumentRenderer template={template} data={data} />
          </div>
        </>
      )}
    </PrintFrame>
  );
}

interface DraftLine {
  /** Local-only React key — never sent to the server. */
  key: number;
  name: string;
  qty: Qty | null;
  uom: string;
  unitPrice: Money | null;
}

function emptyLine(key: number): DraftLine {
  return { key, name: '', qty: null, uom: '', unitPrice: null };
}

/**
 * `manual`: there is no row to fetch, so this component IS the source of the
 * document until the operator submits it. Two phases, switched on whether
 * `payload` has been set: a form, then (after `createManualInvoiceDocument`
 * succeeds) the same print surface every other invoice source renders through
 * — `docDataFromPayload` + `DocumentRenderer` do not know or care that this
 * `DocPayload` came from a POST instead of a GET.
 */
function ManualInvoicePrint() {
  const { t } = useI18n();
  // Starts at 1 because the first line (key 0) is seeded below; keeps line
  // keys stable across add/remove without reusing an index that a removed
  // row already owned (an index-based key would make React reuse the wrong
  // `QtyInput`'s internal focus/draft state after a middle row is deleted).
  const nextKey = useRef(1);

  const [partyName, setPartyName] = useState('');
  const [partyAddress, setPartyAddress] = useState('');
  const [partyPhone, setPartyPhone] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(0)]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set together, once, on a successful submit — never partially, so the
  // print surface below never renders with a payload but no template.
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [payload, setPayload] = useState<DocPayload | null>(null);
  const [data, setData] = useState<DocData | null>(null);

  function addLine() {
    setLines((prev) => [...prev, emptyLine(nextKey.current++)]);
  }

  function removeLine(key: number) {
    // A manual invoice with zero lines is not really an invoice — keep at
    // least one row so there is always something to fill in rather than an
    // empty list the operator has to know to re-populate.
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.key !== key)));
  }

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setFormError(null);
    if (!partyName.trim()) {
      setFormError(t('doc.print.manualNeedsParty'));
      return;
    }
    // A row is only "real" once every field it needs is present — a half
    // typed line (a name but no price) is dropped rather than sent as a
    // partial line item, which the server would either reject or print with
    // a blank price on a document meant to be handed to a customer.
    const validLines: ManualInvoiceLine[] = lines
      .filter((l) => l.name.trim() && l.qty && l.uom.trim() && l.unitPrice)
      .map((l) => ({
        name: l.name.trim(),
        qty: l.qty as Qty,
        uom: l.uom.trim(),
        unitPrice: l.unitPrice as Money,
      }));
    if (validLines.length === 0) {
      setFormError(t('doc.print.manualNeedsLine'));
      return;
    }

    setSubmitting(true);
    try {
      // The template and the newly-created payload are independent once the
      // request is valid, so they are fetched in parallel — same reasoning
      // as every other print route in this feature.
      const [tpl, created] = await Promise.all([
        getDocTemplate('invoice'),
        createManualInvoiceDocument({
          partyName: partyName.trim(),
          partyAddress: partyAddress.trim() || undefined,
          partyPhone: partyPhone.trim() || undefined,
          dueDate: dueDate || undefined,
          notes: notes.trim() || undefined,
          lines: validLines,
        }),
      ]);
      const doc = await docDataFromPayload(created, t);
      setTemplate(tpl);
      setPayload(created);
      setData(doc);
    } catch (err) {
      setFormError(errMsg(err, t('doc.print.manualFailed')));
    } finally {
      setSubmitting(false);
    }
  }

  function backToEdit() {
    // The typed form state is left untouched — only the result is cleared.
    // A form the operator has to retype after glancing at the preview is the
    // kind of friction that gets a printed invoice corrected by hand instead,
    // which defeats the point of a data-driven document.
    setPayload(null);
    setData(null);
    setTemplate(null);
  }

  if (payload && data && template) {
    return (
      <PrintFrame
        title={t('doc.print.invoiceTitle')}
        documentNumber={payload.documentNumber}
        ready
        letterhead={false}
      >
        <div className="print-hide mb-4">
          <Button variant="outline" size="sm" onClick={backToEdit}>
            {t('doc.print.manualBack')}
          </Button>
        </div>
        <DocPageStyle width={template.width} height={template.height} />
        <div className="print-copy">
          <DocumentRenderer template={template} data={data} />
        </div>
      </PrintFrame>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div>
        <p className="font-display text-lg font-semibold text-text-primary">
          {t('doc.print.manualTitle')}
        </p>
        <p className="text-sm text-text-muted">{t('doc.print.manualDescription')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('doc.print.manualPartyName')}
          value={partyName}
          onChange={(e) => setPartyName(e.target.value)}
          required
        />
        <Input
          label={t('doc.print.manualPartyPhone')}
          value={partyPhone}
          onChange={(e) => setPartyPhone(e.target.value)}
        />
        <Input
          label={t('doc.print.manualPartyAddress')}
          value={partyAddress}
          onChange={(e) => setPartyAddress(e.target.value)}
          wrapperClassName="col-span-2"
        />
        <Input
          label={t('doc.print.manualDueDate')}
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-text-primary">{t('doc.print.manualLines')}</p>
        {lines.map((line) => (
          <div key={line.key} className="grid grid-cols-[1fr_6rem_5rem_8rem_2rem] items-end gap-2">
            <Input
              label={t('doc.print.manualLineName')}
              value={line.name}
              onChange={(e) => updateLine(line.key, { name: e.target.value })}
            />
            <QtyInput
              label={t('doc.print.manualLineQty')}
              value={line.qty}
              onChange={(qty) => updateLine(line.key, { qty })}
            />
            <Input
              label={t('doc.print.manualLineUom')}
              value={line.uom}
              onChange={(e) => updateLine(line.key, { uom: e.target.value })}
            />
            <MoneyInput
              label={t('doc.print.manualLineUnitPrice')}
              value={line.unitPrice}
              onChange={(unitPrice) => updateLine(line.key, { unitPrice })}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('doc.print.manualRemoveLine')}
              disabled={lines.length <= 1}
              onClick={() => removeLine(line.key)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Plus className="size-4" />}
          onClick={addLine}
        >
          {t('doc.print.manualAddLine')}
        </Button>
      </div>

      <Textarea
        label={t('doc.print.manualNotes')}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      {formError && <p className="text-sm text-danger-600">{formError}</p>}

      <Button onClick={submit} loading={submitting}>
        {t('doc.print.manualSubmit')}
      </Button>
    </div>
  );
}
