/**
 * `document_templates` CRUD (migration 253) — the invoice/receipt/voucher/
 * Surat Jalan designer's save/load/reset. No RLS on this table (§1.14
 * "NONE" group); `PermissionsGuard` (`doc_template.read` / `.manage`) is the
 * only gate, same shape as `modules/settings`.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  defaultDocTemplate,
  ERR_VALIDATION,
  isDocKind,
  validateDocTemplate,
  type DocKind,
  type DocTemplate,
} from '@mimi/shared';
import { DocTemplateRepository } from './doc-template.repository';
import { withWrite } from './db-tx';

@Injectable()
export class DocTemplateService {
  constructor(private readonly repo: DocTemplateRepository) {}

  private assertKind(kind: string): asserts kind is DocKind {
    if (!isDocKind(kind)) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `'${kind}' is not a document kind`,
      });
    }
  }

  /** No stored row = "use the seeded default", never a 404 — see `defaultDocTemplate`'s own header. */
  async getTemplate(kind: string, client: PoolClient): Promise<DocTemplate> {
    this.assertKind(kind);
    const row = await this.repo.findByKind(client, kind);
    return row ? row.layout : defaultDocTemplate(kind);
  }

  async putTemplate(
    kind: string,
    body: unknown,
    caller: { sub: string },
    client: PoolClient,
  ): Promise<DocTemplate> {
    this.assertKind(kind);

    // `validateDocTemplate` is the SOLE authority for structural correctness
    // (see `doc-template.dto.ts`'s header) — this is the one call site that
    // decides whether the PUT body is savable at all.
    const errors = validateDocTemplate(kind, body);
    if (errors.length > 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Invalid template for '${kind}'`,
        details: errors,
      });
    }
    const template = body as DocTemplate;

    return withWrite(client, async () => {
      const row = await this.repo.upsert(client, kind, template, caller.sub);
      return row.layout;
    });
  }

  /**
   * Resets a kind back to its seeded default by deleting any stored override.
   *
   * DELETING ZERO ROWS IS A SUCCESS, NOT `ERR_NOT_FOUND`. The caller's intent
   * is "make this kind print the default layout again", and that is already
   * true the moment no row exists — whether because nobody ever customised
   * it, or because this call is the second of two rapid resets from a
   * double-clicked "Reset" button. An idempotent reset that 404s on its
   * second call would force the designer UI to track "did I already reset
   * this" client-side for no benefit; treating "no row" and "deleted a row"
   * as the same outcome is what makes the endpoint safe to retry.
   */
  async resetTemplate(kind: string, client: PoolClient): Promise<DocTemplate> {
    this.assertKind(kind);
    return withWrite(client, async () => {
      await this.repo.deleteByKind(client, kind);
      return defaultDocTemplate(kind);
    });
  }
}
