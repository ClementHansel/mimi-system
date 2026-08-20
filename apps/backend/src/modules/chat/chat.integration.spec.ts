/**
 * W7 chat — live database.
 *
 * WHAT THIS CANNOT PROVE, stated up front: no message here reaches a phone.
 * `WA_ENABLED=false` and there are no gateway credentials (RISK-P4), so the
 * WhatsApp channel is stubbed. Everything below is therefore about the
 * behaviour that is ours — threading, idempotency, unread counting, and the
 * honesty of `delivery_status` — not about delivery. Delivery remains a
 * staging test against a real n8n workflow.
 *
 * That split is the point rather than an excuse: the failure mode of a chat
 * feature shipped blind is a message the UI calls "sent" that never left, so
 * these tests pin that the code never claims otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatService, normalisePhone } from './chat.service';
import type { WhatsAppChannelService } from '../../kernel/notification/channels/whatsapp-channel.service';
import {
  closePool,
  loadOutletFixture,
  withRollback,
  type OutletFixture,
} from '../pos/test-support/live-db';

vi.setConfig({ testTimeout: 30_000 });

let fx: OutletFixture;

/** Stands in for the real channel. `success: false` mirrors what `WhatsAppChannelService` actually returns while `WA_ENABLED=false` — the outbox row is written, the webhook is not called. */
function disabledWhatsApp(): WhatsAppChannelService {
  return {
    isEnabled: () => false,
    send: vi.fn().mockResolvedValue({ success: false, outboxId: null }),
  } as unknown as WhatsAppChannelService;
}

describe('normalisePhone', () => {
  it('treats a locally-written and an internationally-written number as one person', () => {
    expect(normalisePhone('0811 2233 44')).toBe(normalisePhone('+62 811-2233-44'));
  });

  it('strips punctuation so formatting never forks a thread', () => {
    expect(normalisePhone('+62 (811) 2233-44')).toBe('62811223344');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('ChatService — live database', () => {
  beforeAll(async () => {
    fx = await loadOutletFixture();
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  it('an inbound message opens a thread, previews it, and counts it unread', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const phone = `62811${Date.now().toString().slice(-8)}`;

        await service.receiveInbound(client, { phone, body: 'Ayam sudah siap dikirim?' });

        const list = await service.listConversations(client, {});
        const convo = list.rows.find((c) => c.contactPhone === phone);
        expect(convo).toBeDefined();
        expect(convo!.unreadCount).toBe(1);
        expect(convo!.lastMessagePreview).toBe('Ayam sudah siap dikirim?');

        const messages = await service.getMessages(client, convo!.id);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.direction).toBe('inbound');
        expect(messages[0]!.deliveryStatus).toBe('received');
      },
    );
  });

  it('a redelivered webhook does not duplicate the message or inflate the unread badge', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const phone = `62812${Date.now().toString().slice(-8)}`;
        const externalId = `wamid.${randomUUID()}`;

        const first = await service.receiveInbound(client, { phone, body: 'Halo', externalId });
        const second = await service.receiveInbound(client, { phone, body: 'Halo', externalId });

        expect(first.duplicate).toBe(false);
        expect(second.duplicate).toBe(true);
        expect(second.conversationId).toBe(first.conversationId);

        const messages = await service.getMessages(client, first.conversationId);
        expect(messages).toHaveLength(1);

        // The badge is the part that would rot silently: a retried webhook
        // that re-counted would leave an inbox permanently showing unread
        // messages that do not exist.
        const list = await service.listConversations(client, {});
        expect(list.rows.find((c) => c.id === first.conversationId)!.unreadCount).toBe(1);
      },
    );
  });

  it('the same number written two ways is ONE conversation', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const suffix = Date.now().toString().slice(-8);

        const a = await service.receiveInbound(client, { phone: `62813${suffix}`, body: 'satu' });
        const b = await service.receiveInbound(client, { phone: `0813${suffix}`, body: 'dua' });

        expect(b.conversationId).toBe(a.conversationId);
        expect(await service.getMessages(client, a.conversationId)).toHaveLength(2);
      },
    );
  });

  it('an outbound message is stored and shown PENDING, never as sent, while WA is disabled', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const convo = await service.openConversation(client, {
          phone: `62814${Date.now().toString().slice(-8)}`,
          name: 'CV Ayam Makmur',
        });

        const sent = await service.sendMessage(client, convo.id, fx.ownerId, 'Terima kasih');

        expect(sent.direction).toBe('outbound');
        expect(sent.body).toBe('Terima kasih');
        // The whole point: the gateway is off, so the message exists but has
        // NOT been delivered, and the record says so.
        expect(sent.deliveryStatus).toBe('pending');
      },
    );
  });

  it('replying does not mark the thread read — that is a separate, explicit act', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const phone = `62815${Date.now().toString().slice(-8)}`;
        const { conversationId } = await service.receiveInbound(client, { phone, body: 'Halo' });

        await service.sendMessage(client, conversationId, fx.ownerId, 'Sebentar ya');
        let list = await service.listConversations(client, {});
        expect(list.rows.find((c) => c.id === conversationId)!.unreadCount).toBe(1);

        const { read } = await service.markRead(client, conversationId);
        expect(read).toBe(1);
        list = await service.listConversations(client, {});
        expect(list.rows.find((c) => c.id === conversationId)!.unreadCount).toBe(0);
      },
    );
  });

  it('an inbound message reopens a closed thread', async () => {
    await withRollback(
      { userId: fx.ownerId, roleKey: 'owner', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());
        const phone = `62816${Date.now().toString().slice(-8)}`;
        const { conversationId } = await service.receiveInbound(client, { phone, body: 'Halo' });

        await service.setStatus(client, conversationId, 'closed');
        await service.receiveInbound(client, { phone, body: 'Masih di sana?' });

        const list = await service.listConversations(client, {});
        // A customer replying after someone marked the thread done is exactly
        // when it must come back, rather than sitting closed and unanswered.
        expect(list.rows.find((c) => c.id === conversationId)!.status).toBe('open');
      },
    );
  });

  it("a staff member's own thread is created on first open and reused after", async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'kasir', locationIds: [fx.locationId] },
      async (client) => {
        const service = new ChatService(disabledWhatsApp());

        const first = await service.getOwnConversation(client, fx.kasirId);
        const second = await service.getOwnConversation(client, fx.kasirId);

        expect(second.conversation.id).toBe(first.conversation.id);
        expect(first.conversation.userId).toBe(fx.kasirId);
        expect(first.messages).toEqual([]);
      },
    );
  });
});
