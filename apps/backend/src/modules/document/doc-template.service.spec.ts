/**
 * Unit suite for `DocTemplateService` — repository mocked (no live DB), per
 * the ticket: default fallback when no row, validation rejection, reset
 * returns the default.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultDocTemplate, type DocTemplate } from '@mimi/shared';
import { DocTemplateService } from './doc-template.service';
import type { DocTemplateRepository, DocTemplateRow } from './doc-template.repository';

const CALLER = { sub: 'user-1' };

function fakeClient(): PoolClient {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
}

function buildService(repo: Partial<DocTemplateRepository>): DocTemplateService {
  return new DocTemplateService(repo as DocTemplateRepository);
}

describe('DocTemplateService', () => {
  describe('getTemplate', () => {
    it('returns the seeded default when no row is stored', async () => {
      const findByKind = vi.fn().mockResolvedValue(undefined);
      const service = buildService({ findByKind });

      const result = await service.getTemplate('invoice', fakeClient());

      expect(findByKind).toHaveBeenCalledWith(expect.anything(), 'invoice');
      expect(result).toEqual(defaultDocTemplate('invoice'));
    });

    it('returns the stored layout when a row exists', async () => {
      const stored = defaultDocTemplate('receipt');
      stored.elements = []; // mutate so it's distinguishable from a fresh default
      const row: DocTemplateRow = {
        kind: 'receipt',
        layout: stored,
        background_attachment_id: null,
        updated_by: 'user-1',
        updated_at: new Date(),
      };
      const findByKind = vi.fn().mockResolvedValue(row);
      const service = buildService({ findByKind });

      const result = await service.getTemplate('receipt', fakeClient());

      expect(result).toBe(stored);
      expect(result.elements).toEqual([]);
    });

    it('rejects an unknown kind with ERR_VALIDATION', async () => {
      const service = buildService({});
      await expect(service.getTemplate('bogus', fakeClient())).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION' },
      });
    });
  });

  describe('putTemplate', () => {
    it('rejects a template with a bad field token, with non-empty details', async () => {
      const upsert = vi.fn();
      const service = buildService({ upsert });

      const badTemplate: DocTemplate = {
        ...defaultDocTemplate('invoice'),
        elements: [
          {
            id: 'bad-field',
            type: 'field',
            field: 'not_a_real_token',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
          },
        ],
      };

      await expect(
        service.putTemplate('invoice', badTemplate, CALLER, fakeClient()),
      ).rejects.toMatchObject({
        response: {
          code: 'ERR_VALIDATION',
        },
      });
      // The repository must never be reached for an invalid body — a rejected
      // save must not touch the row.
      expect(upsert).not.toHaveBeenCalled();

      try {
        await service.putTemplate('invoice', badTemplate, CALLER, fakeClient());
        throw new Error('unreachable');
      } catch (err) {
        const response = (err as { getResponse?: () => { details?: string[] } }).getResponse?.();
        expect(response?.details?.length).toBeGreaterThan(0);
      }
    });

    it('saves a structurally valid template and returns the saved layout', async () => {
      const template = defaultDocTemplate('voucher');
      const savedRow: DocTemplateRow = {
        kind: 'voucher',
        layout: template,
        background_attachment_id: template.backgroundAttachmentId,
        updated_by: CALLER.sub,
        updated_at: new Date(),
      };
      const upsert = vi.fn().mockResolvedValue(savedRow);
      const client = fakeClient();
      const service = buildService({ upsert });

      const result = await service.putTemplate('voucher', template, CALLER, client);

      expect(upsert).toHaveBeenCalledWith(client, 'voucher', template, CALLER.sub);
      expect(result).toBe(template);
      // withWrite must BEGIN/COMMIT — see db-tx.ts's header for why a
      // mutating method that never commits has its write silently rolled
      // back by RlsCleanupInterceptor.
      expect((client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
        'BEGIN',
        'COMMIT',
      ]);
    });
  });

  describe('resetTemplate', () => {
    it('deletes any stored row and returns the seeded default', async () => {
      const deleteByKind = vi.fn().mockResolvedValue(undefined);
      const service = buildService({ deleteByKind });

      const result = await service.resetTemplate('surat_jalan', fakeClient());

      expect(deleteByKind).toHaveBeenCalledWith(expect.anything(), 'surat_jalan');
      expect(result).toEqual(defaultDocTemplate('surat_jalan'));
    });

    it('is idempotent — deleting zero rows is still a success, not ERR_NOT_FOUND', async () => {
      // The repository's DELETE is a no-op when no row exists; the service
      // must not distinguish "deleted a row" from "there was never a row".
      const deleteByKind = vi.fn().mockResolvedValue(undefined);
      const service = buildService({ deleteByKind });

      await expect(service.resetTemplate('receipt', fakeClient())).resolves.toEqual(
        defaultDocTemplate('receipt'),
      );
      await expect(service.resetTemplate('receipt', fakeClient())).resolves.toEqual(
        defaultDocTemplate('receipt'),
      );
    });
  });
});
