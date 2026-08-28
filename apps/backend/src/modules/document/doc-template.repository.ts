/**
 * Raw `pg` access for `document_templates` (migration 253). No RLS — the
 * table sits in CONTRACTS.md §1.14's "NONE" group (API-gated by
 * `PermissionsGuard` only, same as `settings`/`approval_chain_steps`), so
 * every method here runs on the request's `PoolClient` purely for
 * transaction consistency with `RlsContextGuard`'s BEGIN/`RlsCleanupInterceptor`'s
 * ROLLBACK, not because a policy needs the session vars.
 *
 * There are deliberately NO seed rows for this table (see migration 253's
 * comment): the absence of a row for a `kind` means "use
 * `defaultDocTemplate(kind)`", so `findByKind` returning `undefined` is the
 * normal, expected state for a kind nobody has customised yet — not an
 * error condition.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DocKind, DocTemplate } from '@mimi/shared';

export interface DocTemplateRow {
  kind: DocKind;
  layout: DocTemplate;
  background_attachment_id: string | null;
  updated_by: string | null;
  updated_at: Date;
}

@Injectable()
export class DocTemplateRepository {
  async findByKind(client: PoolClient, kind: DocKind): Promise<DocTemplateRow | undefined> {
    const res = await client.query<DocTemplateRow>(
      `SELECT kind, layout, background_attachment_id, updated_by, updated_at
         FROM document_templates
        WHERE kind = $1`,
      [kind],
    );
    return res.rows[0];
  }

  /**
   * `backgroundAttachmentId` is deliberately duplicated between the plain
   * column and `layout->>'backgroundAttachmentId'` (migration 253's own
   * comment) — this is the ONE write path for the row, so both are set here,
   * from the same value, in the same statement. Never write one without the
   * other from a second call site.
   */
  async upsert(
    client: PoolClient,
    kind: DocKind,
    layout: DocTemplate,
    updatedBy: string,
  ): Promise<DocTemplateRow> {
    const res = await client.query<DocTemplateRow>(
      `INSERT INTO document_templates (kind, layout, background_attachment_id, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, NOW())
       ON CONFLICT (kind) DO UPDATE
         SET layout = $2::jsonb,
             background_attachment_id = $3,
             updated_by = $4,
             updated_at = NOW()
       RETURNING kind, layout, background_attachment_id, updated_by, updated_at`,
      [kind, JSON.stringify(layout), layout.backgroundAttachmentId, updatedBy],
    );
    return res.rows[0]!;
  }

  /**
   * Idempotent reset — see `DocTemplateService.resetTemplate` for why
   * deleting zero rows is a SUCCESS, not `ERR_NOT_FOUND`.
   */
  async deleteByKind(client: PoolClient, kind: DocKind): Promise<void> {
    await client.query(`DELETE FROM document_templates WHERE kind = $1`, [kind]);
  }
}
