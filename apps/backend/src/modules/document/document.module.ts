import { Module } from '@nestjs/common';
import { DocTemplateController } from './doc-template.controller';
import { DocTemplateService } from './doc-template.service';
import { DocTemplateRepository } from './doc-template.repository';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

/**
 * `document` — the invoice/receipt/voucher/Surat Jalan designer's storage
 * (`document_templates`, migration 253) plus the read-only resolvers that
 * fill a template with a real row for printing (`GET /api/documents/**`).
 *
 * Two controllers, one module, because they share the same table
 * (`document_templates` supplies both the CRUD surface AND every resolver's
 * `backgroundAttachmentId`) and the same `settings` reads
 * (`document-settings.util.ts`) — splitting them into two modules would only
 * buy a false separation.
 *
 * NOT registered in `app.module.ts` here — the coordinating senior wires
 * that in (BUILD-PLAN §6 hard boundary for this ticket).
 */
@Module({
  controllers: [DocTemplateController, DocumentController],
  providers: [DocTemplateService, DocTemplateRepository, DocumentService],
})
export class DocumentModule {}
