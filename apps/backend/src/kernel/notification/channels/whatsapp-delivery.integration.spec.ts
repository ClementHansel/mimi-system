/**
 * WhatsApp DELIVERY, against a sandbox gateway (RISK-P4).
 *
 * The existing `whatsapp-channel.service.spec.ts` stubs `globalThis.fetch`, so
 * it proves we call *a function* with the right arguments. It cannot prove we
 * speak HTTP correctly, that a 502 is distinguished from a 200, or that the
 * outbox row ends up in the right state — and with `WA_ENABLED=false` in every
 * environment that exists today, none of that had ever run. This file runs it:
 * the REAL `WhatsAppChannelService` with `WA_ENABLED=true`, the REAL
 * `NotificationOutboxRepository` against a live database, and a real socket to
 * a sandbox that answers the way the n8n `wa-notify` workflow answers.
 *
 * What it still cannot prove, stated plainly: no message reaches a handset.
 * Template approval, the 24-hour customer-service window, and Meta's rate
 * limits are outside anything we can test without client credentials. This
 * covers the half that is ours — and that half contained a real bug (see the
 * `pending` vs `failed` test at the bottom).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { WhatsAppChannelService } from './whatsapp-channel.service';
import { NotificationOutboxRepository } from './notification-outbox.repository';
import { startWaSandbox, type WaSandbox } from './test-support/wa-sandbox';
import { closePool, getAppPool, getOwnerPool } from '../../../modules/pos/test-support/live-db';

vi.setConfig({ testTimeout: 30_000 });

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

interface OutboxRow {
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  payload: Record<string, unknown>;
}

/** Marks every number this file uses, so cleanup can find its own rows and nothing else. */
const PHONE_PREFIX = '6288800';

describe('WhatsApp channel — sandbox gateway (no live DB)', () => {
  let sandbox: WaSandbox;

  /** In-memory outbox: these cases are about the HTTP conversation, not the table. */
  const memoryOutbox = () => {
    const calls = { created: [] as unknown[], sent: [] as string[], failed: [] as string[] };
    const repo = {
      create: vi.fn(async (...args: unknown[]) => {
        calls.created.push(args);
        return `outbox-${calls.created.length}`;
      }),
      markSent: vi.fn(async (id: string) => void calls.sent.push(id)),
      markFailed: vi.fn(async (_id: string, err: string) => void calls.failed.push(err)),
    } as unknown as NotificationOutboxRepository;
    return { repo, calls };
  };

  beforeAll(async () => {
    sandbox = await startWaSandbox({ timeoutMs: 200 });
  });

  afterEach(() => sandbox.reset());

  afterAll(async () => {
    await sandbox.close();
  });

  it('delivers the rendered Bahasa Indonesia text verbatim — the backend owns i18n, the gateway relays', async () => {
    const { repo } = memoryOutbox();
    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
      repo,
    );

    const text = 'Stok Ayam Potong di Gudang Pusat menipis: sisa 4 kg.';
    const result = await service.send(
      `${PHONE_PREFIX}001`,
      'low_stock',
      { itemName: 'Ayam' },
      text,
    );

    expect(result.success).toBe(true);
    const delivered = sandbox.lastMessage();
    expect(delivered).toBeDefined();
    expect(delivered!.to).toBe(`${PHONE_PREFIX}001`);
    // Verbatim matters: a gateway that re-rendered or truncated this would ship
    // a half-sentence to an outlet manager, and only a real socket can catch it.
    expect(delivered!.text).toBe(text);
    expect(delivered!.templateKey).toBe('low_stock');
    expect(delivered!.params).toEqual({ itemName: 'Ayam' });
  });

  it('treats a 502 from the gateway as a failure and keeps the gateway’s own words', async () => {
    const { repo, calls } = memoryOutbox();
    sandbox.setFailureMode('gateway-error');
    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
      repo,
    );

    const result = await service.send(`${PHONE_PREFIX}002`, 'chat.message', {}, 'Halo');

    expect(result.success).toBe(false);
    // The error text is what an operator reads six hours later while working
    // out why a supplier never replied, so it must be the gateway's, not ours.
    expect(result.error).toContain('WA gateway request failed');
    expect(calls.failed[0]).toContain('WA gateway request failed');
    expect(sandbox.messages()).toHaveLength(0);
  });

  it('reports a malformed payload as a failure instead of silently dropping it', async () => {
    const { repo } = memoryOutbox();
    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
      repo,
    );

    // An empty rendered body is a template bug on our side. The workflow's
    // `IF: payload has to + text` branch answers 400; nothing must be queued.
    const result = await service.send(`${PHONE_PREFIX}003`, 'chat.message', {}, '   ');

    expect(result.success).toBe(false);
    expect(result.error).toContain('to and text are required');
    expect(sandbox.messages()).toHaveLength(0);
  });

  it('survives an unreachable gateway rather than throwing into the caller', async () => {
    const { repo, calls } = memoryOutbox();
    const dead = await startWaSandbox();
    const url = dead.webhookUrl;
    await dead.close();

    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: url }),
      repo,
    );

    // n8n being down must not take down whatever business action triggered the
    // notification — a PO approval that throws because a WA container is
    // restarting is a far worse outcome than a missed message.
    const result = await service.send(`${PHONE_PREFIX}004`, 'chat.message', {}, 'Halo');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(calls.failed).toHaveLength(1);
  });

  it('WA_ENABLED=false with a healthy gateway in reach still sends nothing', async () => {
    const { repo, calls } = memoryOutbox();
    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'false', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
      repo,
    );

    // The kill switch is the whole safety story for RISK-P4: it must be the
    // flag that decides, not the reachability of the gateway.
    const result = await service.send(`${PHONE_PREFIX}005`, 'chat.message', {}, 'Halo');

    expect(result.success).toBe(false);
    expect(sandbox.messages()).toHaveLength(0);
    expect(calls.created).toHaveLength(1);
    expect(calls.sent).toHaveLength(0);
    expect(calls.failed).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  'WhatsApp channel — outbox transitions on a live database',
  () => {
    let sandbox: WaSandbox;
    /** Fixture/verification reads only, per the harness's two-pool rule. */
    let owner: Pool;
    /** What the repository under test runs on — `mimi_app`, the same identity as production `DATABASE_POOL`. */
    let app: Pool;

    const read = async (id: string): Promise<OutboxRow> => {
      const res = await owner.query<OutboxRow>(
        `SELECT status, attempts, last_error, sent_at, payload FROM notification_outbox WHERE id = $1`,
        [id],
      );
      expect(res.rows).toHaveLength(1);
      return res.rows[0]!;
    };

    beforeAll(async () => {
      sandbox = await startWaSandbox({ timeoutMs: 200 });
      owner = getOwnerPool();
      app = getAppPool();
    });

    afterEach(() => sandbox.reset());

    afterAll(async () => {
      // These rows are written by the channel's own pool, outside any test
      // transaction (that is the point — the outbox must survive a rollback of
      // the business operation), so they are cleaned up explicitly.
      await owner.query(`DELETE FROM notification_outbox WHERE recipient LIKE $1`, [
        `${PHONE_PREFIX}%`,
      ]);
      await sandbox.close();
      await closePool();
    });

    it('a delivered message leaves a sent row carrying the gateway’s message id', async () => {
      const service = new WhatsAppChannelService(
        fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
        new NotificationOutboxRepository(app),
      );

      const result = await service.send(`${PHONE_PREFIX}101`, 'low_stock', {}, 'Stok menipis');
      expect(result.success).toBe(true);

      const row = await read(result.outboxId);
      expect(row.status).toBe('sent');
      expect(row.attempts).toBe(1);
      expect(row.sent_at).not.toBeNull();
      expect(row.last_error).toBeNull();
      // Without the provider id there is no way to ask the gateway what became
      // of a message an outlet says never arrived — the trail would stop at our
      // own "sent". This is the correlation handle.
      expect(row.payload.providerMessageId).toBe(sandbox.lastMessage()!.wamid);
    });

    it('a rejected message leaves a failed row with the reason and an attempt counted', async () => {
      sandbox.setFailureMode('gateway-error');
      const service = new WhatsAppChannelService(
        fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
        new NotificationOutboxRepository(app),
      );

      const result = await service.send(`${PHONE_PREFIX}102`, 'low_stock', {}, 'Stok menipis');
      expect(result.success).toBe(false);

      const row = await read(result.outboxId);
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('WA gateway request failed');
      expect(row.sent_at).toBeNull();
    });

    it('WA_ENABLED=false leaves the row pending — a queue, not a failure', async () => {
      const service = new WhatsAppChannelService(
        fakeConfig({ WA_ENABLED: 'false', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
        new NotificationOutboxRepository(app),
      );

      const result = await service.send(`${PHONE_PREFIX}103`, 'low_stock', {}, 'Stok menipis');

      const row = await read(result.outboxId);
      // `pending` and `failed` must not be conflated: the first says "nobody
      // has tried yet, a retry sweep should pick this up", the second says
      // "someone tried and the gateway said no". W5-04's retry surface reads
      // exactly this column.
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.last_error).toBeNull();
    });
  },
);
