/**
 * W7 chat — DELIVERY, against a sandbox gateway.
 *
 * `chat.integration.spec.ts` opens by saying what it cannot prove: "no message
 * here reaches a phone… Delivery remains a staging test against a real n8n
 * workflow." That caveat was load-bearing — it meant the outbound half of chat
 * had never executed, in any environment, ever. This file closes as much of it
 * as can be closed without client credentials (RISK-P4):
 *
 *   - the REAL `WhatsAppChannelService` with `WA_ENABLED=true`, talking to a
 *     sandbox that answers like the n8n `wa-notify` workflow, so
 *     `chat_messages.delivery_status` is decided by a real HTTP exchange;
 *   - the REAL `ChatInboundController` behind a real socket, so the PUBLIC
 *     write endpoint's shared-secret gate and its idempotency are proven by
 *     requests arriving from outside the process rather than by a direct call.
 *
 * Still out of reach and still worth saying: nothing here proves a handset
 * receives anything, that the WA template was approved, or that the 24-hour
 * customer-service window permits the send.
 *
 * The `pending`-vs-`failed` test below is why this file exists. Building the
 * sandbox exposed the bug it pins: a gateway rejection used to be recorded as
 * `pending`, i.e. shown to staff as a message still on its way.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { ChatService } from './chat.service';
import { ChatInboundController } from './chat.controller';
import { WhatsAppChannelService } from '../../kernel/notification/channels/whatsapp-channel.service';
import { NotificationOutboxRepository } from '../../kernel/notification/channels/notification-outbox.repository';
import {
  startWaSandbox,
  type WaSandbox,
} from '../../kernel/notification/channels/test-support/wa-sandbox';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import {
  closePool,
  getAppPool,
  getOwnerPool,
  loadOutletFixture,
  withRollback,
  type OutletFixture,
} from '../pos/test-support/live-db';

vi.setConfig({ testTimeout: 60_000 });

const WEBHOOK_SECRET = 'sandbox-inbound-secret';
/** Marks every contact this file creates, so cleanup finds its own rows and nothing else. */
const PHONE_PREFIX = '6288811';

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

/** The real channel, enabled, pointed at the sandbox — this is the whole point of the file. */
function liveChannel(sandbox: WaSandbox, pool: Pool): WhatsAppChannelService {
  return new WhatsAppChannelService(
    fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
    new NotificationOutboxRepository(pool),
  );
}

describe.skipIf(!process.env.DATABASE_URL)('W7 chat — delivery against a WA sandbox', () => {
  let sandbox: WaSandbox;
  let fx: OutletFixture;
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    sandbox = await startWaSandbox({ timeoutMs: 200 });
    fx = await loadOutletFixture();
    owner = getOwnerPool();
    app = getAppPool();
  }, 60_000);

  afterEach(() => sandbox.reset());

  afterAll(async () => {
    // The outbox is written by the channel's own pool, deliberately outside the
    // test transaction — an attempt to notify someone must survive a rollback
    // of the business operation that triggered it — so it is cleaned up here.
    await owner.query(`DELETE FROM notification_outbox WHERE recipient LIKE $1`, [
      `${PHONE_PREFIX}%`,
    ]);
    await sandbox.close();
    await closePool();
  });

  it('a sent message reaches the gateway and is recorded as sent, linked to its outbox row', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(liveChannel(sandbox, app));
        const phone = `${PHONE_PREFIX}${Date.now().toString().slice(-4)}`;

        const convo = await service.openConversation(client, {
          phone,
          name: 'Supplier Ayam Sandbox',
          supplierId: null,
        });
        const message = await service.sendMessage(
          client,
          convo.id,
          fx.ownerId as never,
          'Halo, PO 12 kg ayam bisa dikirim besok pagi?',
        );

        expect(message.deliveryStatus).toBe('sent');
        // The gateway got the body verbatim — not a template key the recipient
        // cannot read, and not a truncation.
        expect(sandbox.lastMessage()!.text).toBe('Halo, PO 12 kg ayam bisa dikirim besok pagi?');
        expect(sandbox.lastMessage()!.to).toBe(phone);

        // chat_message → outbox → the gateway's own wamid: the full trail for
        // "the supplier says they never got it".
        const row = await client.query<{ outbox_id: string | null }>(
          `SELECT outbox_id FROM chat_messages WHERE id = $1`,
          [message.id],
        );
        const outboxId = row.rows[0]!.outbox_id;
        expect(outboxId).not.toBeNull();
        const outbox = await owner.query<{ status: string; payload: Record<string, unknown> }>(
          `SELECT status, payload FROM notification_outbox WHERE id = $1`,
          [outboxId],
        );
        expect(outbox.rows[0]!.status).toBe('sent');
        expect(outbox.rows[0]!.payload.providerMessageId).toBe(sandbox.lastMessage()!.wamid);
      },
    );
  });

  it('a gateway rejection is recorded as FAILED, never as still-on-its-way', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        sandbox.setFailureMode('gateway-error');
        const service = new ChatService(liveChannel(sandbox, app));
        const phone = `${PHONE_PREFIX}${(Date.now() + 1).toString().slice(-4)}`;

        const convo = await service.openConversation(client, {
          phone,
          name: 'Supplier Gagal',
          supplierId: null,
        });
        const message = await service.sendMessage(
          client,
          convo.id,
          fx.ownerId as never,
          'Konfirmasi pengiriman?',
        );

        // THE BUG THIS FILE FOUND. The old code wrote `pending` for every
        // unsuccessful send, conflating "the channel is switched off, this is
        // queued" with "the gateway refused it". A purchasing clerk reading
        // `pending` waits for a reply to a message that does not exist.
        expect(message.deliveryStatus).toBe('failed');
        // The message itself survives — only its delivery failed, so a retry
        // has something to retry.
        expect(message.body).toBe('Konfirmasi pengiriman?');
      },
    );
  });

  it('with WA disabled the same failure is `pending`, because nothing was attempted', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const disabled = new WhatsAppChannelService(
          fakeConfig({ WA_ENABLED: 'false', N8N_WEBHOOK_URL_WA: sandbox.webhookUrl }),
          new NotificationOutboxRepository(app),
        );
        const service = new ChatService(disabled);
        const phone = `${PHONE_PREFIX}${(Date.now() + 2).toString().slice(-4)}`;

        const convo = await service.openConversation(client, {
          phone,
          name: 'Supplier Antri',
          supplierId: null,
        });
        const message = await service.sendMessage(client, convo.id, fx.ownerId as never, 'Halo');

        expect(message.deliveryStatus).toBe('pending');
        expect(sandbox.messages()).toHaveLength(0);
      },
    );
  });
});

/**
 * The inbound webhook, over a real socket.
 *
 * Boots ONLY `ChatInboundController` rather than `AppModule`: the endpoint is
 * `@Public()`, so there is no guard chain to exercise, and its entire defence
 * is the shared-secret comparison plus `withSystemContext`. The globals below
 * mirror `main.ts` — without them the route would 404 on the missing `/api`
 * prefix and every assertion here would pass by testing nothing.
 */
describe.skipIf(!process.env.DATABASE_URL)('W7 chat — inbound webhook over HTTP', () => {
  let sandbox: WaSandbox;
  let nest: INestApplication;
  let inboundUrl: string;
  let owner: Pool;
  const phone = `${PHONE_PREFIX}9${Date.now().toString().slice(-3)}`;

  beforeAll(async () => {
    sandbox = await startWaSandbox();
    owner = getOwnerPool();

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatInboundController],
      providers: [
        { provide: ChatService, useValue: new ChatService(undefined as never) },
        {
          provide: (await import('@nestjs/config')).ConfigService,
          useValue: fakeConfig({ N8N_WEBHOOK_SECRET: WEBHOOK_SECRET }),
        },
        { provide: DATABASE_POOL, useValue: getAppPool() },
      ],
    }).compile();

    nest = moduleRef.createNestApplication();
    nest.useGlobalFilters(new AllExceptionsFilter());
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        // Mirrors main.ts's shape; the per-field detail it builds there is not
        // what this file asserts on, so the argument is deliberately ignored.
        exceptionFactory: () =>
          new BadRequestException({ code: 'ERR_VALIDATION', message: 'Validation failed' }),
      }),
    );
    nest.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.ALL }] });
    await nest.listen(0);
    const url = await nest.getUrl();
    inboundUrl = `${url.replace('[::1]', '127.0.0.1')}/api/chat/inbound`;
  }, 60_000);

  afterAll(async () => {
    await owner.query(
      `DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE contact_phone LIKE $1)`,
      [`${PHONE_PREFIX}%`],
    );
    await owner.query(`DELETE FROM chat_conversations WHERE contact_phone LIKE $1`, [
      `${PHONE_PREFIX}%`,
    ]);
    await nest.close();
    await sandbox.close();
    await closePool();
  });

  it('rejects a request with the wrong secret, and writes nothing', async () => {
    const response = await sandbox.deliverInbound(inboundUrl, 'not-the-secret', {
      phone,
      body: 'Saya mau pesan',
    });

    expect(response.status).toBe(400);
    const rows = await owner.query(`SELECT 1 FROM chat_conversations WHERE contact_phone = $1`, [
      phone,
    ]);
    // A public write endpoint that half-accepts an unauthenticated request is
    // an open door for injecting messages that appear to be from a supplier.
    expect(rows.rowCount).toBe(0);
  });

  it('accepts a signed webhook and opens the thread', async () => {
    const externalId = `wamid.SANDBOXIN${randomUUID().replace(/-/g, '')}`;
    const response = await sandbox.deliverInbound(inboundUrl, WEBHOOK_SECRET, {
      phone,
      body: 'Ayam sudah siap dikirim?',
      externalId,
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true, duplicate: false });

    const rows = await owner.query<{ body: string; direction: string }>(
      `SELECT m.body, m.direction FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE c.contact_phone = $1`,
      [phone],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.body).toBe('Ayam sudah siap dikirim?');
    expect(rows.rows[0]!.direction).toBe('inbound');
  });

  it('a redelivered webhook is a duplicate, not a second message', async () => {
    const externalId = `wamid.SANDBOXIN${randomUUID().replace(/-/g, '')}`;
    const first = await sandbox.deliverInbound(inboundUrl, WEBHOOK_SECRET, {
      phone,
      body: 'Sudah dikirim tadi pagi',
      externalId,
    });
    // Gateways retry. Without the `external_id` guard, one supplier reply
    // becomes three identical rows in the inbox and three unread counts.
    const second = await sandbox.deliverInbound(inboundUrl, WEBHOOK_SECRET, {
      phone,
      body: 'Sudah dikirim tadi pagi',
      externalId,
    });

    expect(first.body).toEqual({ ok: true, duplicate: false });
    expect(second.body).toEqual({ ok: true, duplicate: true });

    const rows = await owner.query(`SELECT 1 FROM chat_messages WHERE external_id = $1`, [
      externalId,
    ]);
    expect(rows.rowCount).toBe(1);
  });
});
