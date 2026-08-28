/** `documents` — read-only template-fill endpoints. See `document.service.ts`'s header. */
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { DocCopySet, DocPayload } from '@mimi/shared';
import { DocumentService } from './document.service';
import { PostManualInvoiceDto } from './document.dto';

@Controller('documents')
export class DocumentController {
  constructor(private readonly service: DocumentService) {}

  @Get('receipt/:saleId')
  @RequirePermission('pos.sale.read')
  getReceipt(
    @Param('saleId') saleId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<DocPayload> {
    return this.service.getReceipt(saleId, req.dbClient!);
  }

  @Get('invoice/sale/:saleId')
  @RequirePermission('pos.sale.read')
  getInvoiceFromSale(
    @Param('saleId') saleId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<DocPayload> {
    return this.service.getInvoiceFromSale(saleId, req.dbClient!);
  }

  @Get('invoice/purchase_order/:poId')
  @RequirePermission('purchasing.read')
  getInvoiceFromPurchaseOrder(
    @Param('poId') poId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<DocPayload> {
    return this.service.getInvoiceFromPurchaseOrder(poId, req.dbClient!);
  }

  @Post('invoice/manual')
  @RequirePermission('doc_template.manage')
  postInvoiceManual(
    @Body() dto: PostManualInvoiceDto,
    @Req() req: RequestWithDbContext,
  ): Promise<DocPayload> {
    return this.service.getInvoiceManual(
      {
        invoiceNumber: dto.invoiceNumber,
        invoiceDate: dto.invoiceDate,
        dueDate: dto.dueDate ?? '',
        partyName: dto.partyName,
        partyAddress: dto.partyAddress ?? '',
        partyPhone: dto.partyPhone ?? '',
        locationName: dto.locationName ?? '',
        issuedBy: dto.issuedBy ?? '',
        paymentMethod: dto.paymentMethod ?? '',
        paymentStatus: dto.paymentStatus ?? '',
        paidAmount: dto.paidAmount ?? '0.00',
        terms: dto.terms ?? '',
        notes: dto.notes ?? '',
        lines: dto.lines.map((line) => ({
          code: line.code,
          name: line.name,
          qty: line.qty,
          uom: line.uom,
          unitPrice: line.unitPrice,
          discount: line.discount,
        })),
      },
      req.dbClient!,
    );
  }

  @Get('surat-jalan/:id')
  @RequirePermission('delivery.read')
  getSuratJalan(@Param('id') id: string, @Req() req: RequestWithDbContext): Promise<DocCopySet> {
    return this.service.getSuratJalan(id, req.dbClient!);
  }

  @Get('voucher/:voucherId')
  @RequirePermission('voucher.read')
  getVoucher(
    @Param('voucherId') voucherId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<DocPayload> {
    return this.service.getVoucher(voucherId, req.dbClient!);
  }

  @Get('voucher/batch/:batchId')
  @RequirePermission('voucher.read')
  getVoucherBatch(
    @Param('batchId') batchId: string,
    @Req() req: RequestWithDbContext,
  ): Promise<DocCopySet> {
    return this.service.getVoucherBatch(batchId, req.dbClient!);
  }
}
