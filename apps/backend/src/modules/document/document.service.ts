/**
 * `documents` — read-only "fill a template with a real row" resolvers
 * (`GET /api/documents/**`). Orchestrates the DB round trips
 * (`document.repository.ts`, `document-settings.util.ts`) and hands the
 * fetched rows to the pure resolver functions in `resolvers/*` — see those
 * files' headers for why the split exists (testability without a live DB).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, type DocCopySet, type DocPayload } from '@mimi/shared';
import { getBrandPalette, getCompanyProfile, type CompanyProfile } from './document-settings.util';
import {
  selectBackgroundAttachmentId,
  selectLocationNames,
  selectPurchaseOrderHeader,
  selectPurchaseOrderLines,
  selectSaleHeader,
  selectSaleLines,
  selectSalePayments,
  selectSjDrops,
  selectSjHeader,
  selectSjLines,
  selectSjSeals,
  selectSjTempLogs,
  selectVoucher,
  selectVoucherBatch,
  selectVoucherCodeForSale,
  selectVouchersForBatch,
} from './document.repository';
import { resolveReceipt } from './resolvers/receipt.resolver';
import {
  resolveInvoiceFromPurchaseOrder,
  resolveInvoiceFromSale,
  resolveInvoiceManual,
  type ManualInvoiceInput,
} from './resolvers/invoice.resolver';
import { resolveSuratJalan } from './resolvers/surat-jalan.resolver';
import { resolveVoucher, resolveVoucherBatch } from './resolvers/voucher.resolver';
import type { DocRenderContext } from './resolvers/common';

@Injectable()
export class DocumentService {
  /**
   * Shared across every resolver call: brand palette, company profile, and
   * the stored template's `background_attachment_id` (if any) for that
   * `kind`. Bundled into ONE helper (rather than each `get*` method reading
   * `settings`/`document_templates` for itself) so `company.profile` and
   * `brand.identity` are each read exactly once per request, not once per
   * resolver input they happen to feed.
   */
  private async renderContext(
    client: PoolClient,
    kind: string,
  ): Promise<{ ctx: DocRenderContext; company: CompanyProfile }> {
    const [brand, backgroundAttachmentId, company] = await Promise.all([
      getBrandPalette(client),
      selectBackgroundAttachmentId(client, kind),
      getCompanyProfile(client),
    ]);
    return {
      ctx: { brand, backgroundAttachmentId, logoAttachmentId: company.logoAttachmentId },
      company,
    };
  }

  async getReceipt(saleId: string, client: PoolClient): Promise<DocPayload> {
    const sale = await this.requireSale(saleId, client);
    const [lines, payments, voucherCode, { ctx, company }] = await Promise.all([
      selectSaleLines(client, saleId),
      selectSalePayments(client, saleId),
      selectVoucherCodeForSale(client, saleId),
      this.renderContext(client, 'receipt'),
    ]);
    return resolveReceipt({ sale, lines, payments, voucherCode, companyName: company.name, ctx });
  }

  async getInvoiceFromSale(saleId: string, client: PoolClient): Promise<DocPayload> {
    const sale = await this.requireSale(saleId, client);
    const [lines, payments, { ctx, company }] = await Promise.all([
      selectSaleLines(client, saleId),
      selectSalePayments(client, saleId),
      this.renderContext(client, 'invoice'),
    ]);
    return resolveInvoiceFromSale({ sale, lines, payments, company, ctx });
  }

  async getInvoiceFromPurchaseOrder(poId: string, client: PoolClient): Promise<DocPayload> {
    const po = await selectPurchaseOrderHeader(client, poId);
    if (!po) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown purchase order '${poId}'` });
    }
    const [lines, { ctx, company }] = await Promise.all([
      selectPurchaseOrderLines(client, poId),
      this.renderContext(client, 'invoice'),
    ]);
    return resolveInvoiceFromPurchaseOrder({ po, lines, company, ctx });
  }

  async getInvoiceManual(
    body: Omit<ManualInvoiceInput, 'company' | 'ctx'>,
    client: PoolClient,
  ): Promise<DocPayload> {
    const { ctx, company } = await this.renderContext(client, 'invoice');
    return resolveInvoiceManual({ ...body, company, ctx });
  }

  async getSuratJalan(sjId: string, client: PoolClient): Promise<DocCopySet> {
    const header = await selectSjHeader(client, sjId);
    if (!header) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown Surat Jalan '${sjId}'` });
    }
    const [drops, lines, seals, tempLogs, { ctx, company }] = await Promise.all([
      selectSjDrops(client, sjId),
      selectSjLines(client, sjId),
      selectSjSeals(client, sjId),
      selectSjTempLogs(client, sjId),
      this.renderContext(client, 'surat_jalan'),
    ]);
    return resolveSuratJalan({
      header,
      drops,
      lines,
      seals,
      tempLogs,
      company: { name: company.name, address: company.address },
      ctx,
    });
  }

  async getVoucher(voucherId: string, client: PoolClient): Promise<DocPayload> {
    const voucher = await selectVoucher(client, voucherId);
    if (!voucher) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown voucher '${voucherId}'` });
    }
    const batch = await this.requireVoucherBatch(voucher.batch_id, client);
    const [locationNames, { ctx, company }] = await Promise.all([
      batch.location_ids ? selectLocationNames(client, batch.location_ids) : Promise.resolve([]),
      this.renderContext(client, 'voucher'),
    ]);
    return resolveVoucher({ voucher, batch, companyName: company.name, locationNames, ctx });
  }

  async getVoucherBatch(batchId: string, client: PoolClient): Promise<DocCopySet> {
    const batch = await this.requireVoucherBatch(batchId, client);
    const [vouchers, locationNames, { ctx, company }] = await Promise.all([
      selectVouchersForBatch(client, batchId),
      batch.location_ids ? selectLocationNames(client, batch.location_ids) : Promise.resolve([]),
      this.renderContext(client, 'voucher'),
    ]);
    return resolveVoucherBatch({ batch, vouchers, companyName: company.name, locationNames, ctx });
  }

  private async requireSale(saleId: string, client: PoolClient) {
    const sale = await selectSaleHeader(client, saleId);
    if (!sale) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown sale '${saleId}'` });
    }
    return sale;
  }

  private async requireVoucherBatch(batchId: string, client: PoolClient) {
    const batch = await selectVoucherBatch(client, batchId);
    if (!batch) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown voucher batch '${batchId}'` });
    }
    return batch;
  }
}
