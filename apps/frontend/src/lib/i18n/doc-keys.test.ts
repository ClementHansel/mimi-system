import { describe, it, expect } from 'vitest';
import {
  DOC_CATALOGS,
  DOC_ELEMENT_TYPES,
  DOC_KINDS,
  DOC_TOTALS_ROWS,
  VoucherBatchStatus,
  VoucherStatus,
  VoucherType,
} from '@/lib/shared-types';
import { translate } from './index';

/**
 * The i18n key surface of the document layer is CATALOG-DRIVEN: the designer's
 * palette is `DOC_CATALOGS[kind].fields`, a table's headers are its `columns`,
 * a signature block's name is a `signatureRole`. Every one of those is looked
 * up with a TEMPLATE LITERAL (`t(\`doc.field.${token}\`)`), which no linter and
 * no compiler can check against the dictionary.
 *
 * So a token added to `@mimi/shared` — by anyone, in any repo, for any reason
 * — silently becomes a button labelled `doc.field.outlet_scope` in the
 * designer, or `doc.column.qty_received` printed as a table header on a legal
 * shipping document. `translate()` returns the raw key on a miss (see
 * `lib/i18n/index.tsx`), which is the right runtime behaviour and a terrible
 * thing to discover on paper.
 *
 * This test is the check that cannot exist at compile time. It walks the SAME
 * shared data the components walk and asserts the dictionary answers for every
 * value.
 *
 * (It also caught the real thing it was written for: the whole `doc.*`
 * namespace being silently lost to a concurrent edit of `id.ts`.)
 */

function expectResolves(key: string): void {
  // `translate` returns the key itself when nothing resolves — that IS the
  // failure signal, so it is what we assert against.
  expect(translate(key), `missing i18n key: ${key}`).not.toBe(key);
}

describe('doc.* covers every token the shared catalogs advertise', () => {
  it.each(DOC_KINDS)('%s: every field token has a label', (kind) => {
    for (const token of DOC_CATALOGS[kind].fields) expectResolves(`doc.field.${token}`);
  });

  it.each(DOC_KINDS)('%s: every table column has a printed header', (kind) => {
    for (const key of DOC_CATALOGS[kind].columns) expectResolves(`doc.column.${key}`);
  });

  it.each(DOC_KINDS)('%s: every totals row has a label', (kind) => {
    for (const key of DOC_TOTALS_ROWS[kind]) expectResolves(`doc.total.${key}`);
  });

  it.each(DOC_KINDS)('%s: every signature role names who signs', (kind) => {
    for (const role of DOC_CATALOGS[kind].signatureRoles) expectResolves(`doc.signature.${role}`);
  });

  it.each(DOC_KINDS)('%s: has a document title and a designer tab name', (kind) => {
    expectResolves(`doc.title.${kind}`);
    expectResolves(`doc.designer.kind.${kind}`);
  });

  it.each(DOC_KINDS)('%s: every element type it offers has a palette label', (kind) => {
    for (const type of DOC_CATALOGS[kind].elements) {
      expectResolves(`doc.designer.element.${type}`);
    }
  });

  it('labels every element type in the model, not just the ones a kind offers', () => {
    // The layer list and an element's accessible name are derived from
    // `el.type` directly, so a type that no CURRENT kind offers still needs a
    // name the moment a template holds one.
    for (const type of DOC_ELEMENT_TYPES) expectResolves(`doc.designer.element.${type}`);
  });
});

describe('doc.* covers the enum labels the resolvers name', () => {
  /**
   * These are the `labelKeys` the backend emits for tokens whose VALUE is copy
   * (`documents/payload.ts`). A missing one prints an enum literal —
   * `bank_transfer`, `shopeefood` — on a customer's receipt.
   */
  it('names every copy holder a Surat Jalan sheet can belong to', () => {
    for (const holder of ['gudang', 'outlet', 'kantor']) {
      expectResolves(`doc.copyHolder.${holder}`);
    }
  });

  it('names every invoice source and party label', () => {
    for (const source of ['sale', 'purchase_order', 'manual']) {
      expectResolves(`doc.source.${source}`);
    }
    for (const party of ['customer', 'supplier', 'manual']) expectResolves(`doc.party.${party}`);
  });

  it('names every POS channel, payment method and payment status', () => {
    for (const channel of ['walk_in', 'gofood', 'shopeefood']) {
      expectResolves(`doc.channel.${channel}`);
    }
    for (const method of ['cash', 'qris', 'bank_transfer']) {
      expectResolves(`doc.paymentMethod.${method}`);
    }
    for (const status of ['pending', 'verified', 'paid']) {
      expectResolves(`doc.paymentStatus.${status}`);
    }
  });

  it('names every shipment type and voucher type', () => {
    for (const type of ['dry', 'frozen']) expectResolves(`doc.shipmentType.${type}`);
    for (const type of Object.values(VoucherType)) expectResolves(`doc.voucherType.${type}`);
  });
});

describe('voucher.* covers both status ladders and every refusal', () => {
  it('names every batch status', () => {
    for (const status of Object.values(VoucherBatchStatus)) {
      expectResolves(`voucher.batchStatus.${status}`);
    }
  });

  it('names every single-voucher status', () => {
    // Deliberately a SEPARATE namespace from `batchStatus` — a closed batch
    // still holds active codes, so collapsing the two is how a screen tells a
    // cashier a live voucher is closed.
    for (const status of Object.values(VoucherStatus)) {
      expectResolves(`voucher.status.${status}`);
    }
  });

  it('gives every ERR_VOUCHER_* its own message', () => {
    // The closed list from `packages/shared/src/error-codes.ts`. `checkVoucher`
    // explains why each needs its own sentence: "tidak berlaku" with no reason
    // is what makes a queue argue.
    const codes = [
      'ERR_VOUCHER_NOT_FOUND',
      'ERR_VOUCHER_NOT_ACTIVE',
      'ERR_VOUCHER_NOT_STARTED',
      'ERR_VOUCHER_EXPIRED',
      'ERR_VOUCHER_BELOW_MINIMUM',
      'ERR_VOUCHER_WRONG_LOCATION',
      'ERR_VOUCHER_OFFLINE_BLOCKED',
    ];
    for (const code of codes) expectResolves(`voucher.pos.error.${code}`);
    expectResolves('voucher.pos.error.unknown');

    const messages = codes.map((code) => translate(`voucher.pos.error.${code}`));
    expect(new Set(messages).size, 'two refusals share one message').toBe(messages.length);
  });
});
