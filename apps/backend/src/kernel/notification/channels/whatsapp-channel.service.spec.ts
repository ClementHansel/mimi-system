import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatsAppChannelService } from './whatsapp-channel.service';
import { NotificationOutboxRepository } from './notification-outbox.repository';

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

describe('WhatsAppChannelService', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('WA_ENABLED=false: writes a pending outbox row and calls the webhook zero times', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const outbox = {
      create: vi.fn().mockResolvedValue('outbox-1'),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as NotificationOutboxRepository;

    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'false', N8N_WEBHOOK_URL_WA: 'http://n8n:5678/webhook/wa-notify' }),
      outbox,
    );

    const result = await service.send(
      '628123456789',
      'low_stock',
      { itemName: 'Ayam' },
      'Stok Ayam menipis',
    );

    expect(service.isEnabled()).toBe(false);
    expect(result.success).toBe(false);
    expect(result.outboxId).toBe('outbox-1');
    expect(outbox.create).toHaveBeenCalledWith('whatsapp', '628123456789', 'low_stock', {
      params: { itemName: 'Ayam' },
      text: 'Stok Ayam menipis',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outbox.markSent).not.toHaveBeenCalled();
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it('WA_ENABLED=true: calls the n8n webhook and marks the outbox row sent on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"ok":true,"messageId":"wamid.HBgNNjI4MTIz"}',
    });
    globalThis.fetch = fetchSpy as never;

    const outbox = {
      create: vi.fn().mockResolvedValue('outbox-2'),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as NotificationOutboxRepository;

    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: 'http://n8n:5678/webhook/wa-notify' }),
      outbox,
    );

    const result = await service.send(
      '628123456789',
      'low_stock',
      { itemName: 'Ayam' },
      'Stok Ayam menipis',
    );

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://n8n:5678/webhook/wa-notify',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(outbox.markSent).toHaveBeenCalledWith('outbox-2', 'wamid.HBgNNjI4MTIz');
    expect(result.providerMessageId).toBe('wamid.HBgNNjI4MTIz');
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it('WA_ENABLED=true but the webhook call fails: marks the outbox row failed', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }) as never;

    const outbox = {
      create: vi.fn().mockResolvedValue('outbox-3'),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as NotificationOutboxRepository;

    const service = new WhatsAppChannelService(
      fakeConfig({ WA_ENABLED: 'true', N8N_WEBHOOK_URL_WA: 'http://n8n:5678/webhook/wa-notify' }),
      outbox,
    );

    const result = await service.send('628123456789', 'low_stock', {}, 'text');

    expect(result.success).toBe(false);
    expect(outbox.markFailed).toHaveBeenCalledWith('outbox-3', 'boom');
  });
});
