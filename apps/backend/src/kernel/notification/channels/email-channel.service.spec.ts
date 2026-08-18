import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailChannelService } from './email-channel.service';
import { NotificationOutboxRepository } from './notification-outbox.repository';

const sendMailMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

function fakeConfig(values: Record<string, string>) {
  return { get: (key: string, def?: unknown) => values[key] ?? def } as never;
}

function fakeOutbox() {
  return {
    create: vi.fn().mockResolvedValue('outbox-1'),
    markSent: vi.fn(),
    markFailed: vi.fn(),
  } as unknown as NotificationOutboxRepository;
}

describe('EmailChannelService', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
  });

  it('is unconfigured when SMTP_HOST is unset, and records a failed outbox row instead of throwing', async () => {
    const outbox = fakeOutbox();
    const service = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outbox);

    expect(service.isConfigured()).toBe(false);
    const result = await service.send('owner@mimichicken.local', 'low_stock', 'Subject', 'Body');

    expect(result.success).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith('outbox-1', 'SMTP not configured');
  });

  it('sends via nodemailer and marks the outbox row sent when SMTP is configured', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    const outbox = fakeOutbox();
    const service = new EmailChannelService(
      fakeConfig({ SMTP_HOST: 'smtp.example.com', SMTP_FROM_EMAIL: 'noreply@mimichicken.local' }),
      outbox,
    );

    expect(service.isConfigured()).toBe(true);
    const result = await service.send(
      'owner@mimichicken.local',
      'low_stock',
      'Stok menipis',
      'Body text',
    );

    expect(result.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledWith({
      from: 'noreply@mimichicken.local',
      to: 'owner@mimichicken.local',
      subject: 'Stok menipis',
      text: 'Body text',
    });
    expect(outbox.markSent).toHaveBeenCalledWith('outbox-1');
  });

  it('marks the outbox row failed when nodemailer throws', async () => {
    sendMailMock.mockRejectedValue(new Error('connection refused'));
    const outbox = fakeOutbox();
    const service = new EmailChannelService(fakeConfig({ SMTP_HOST: 'smtp.example.com' }), outbox);

    const result = await service.send('owner@mimichicken.local', 'low_stock', 'Subject', 'Body');

    expect(result.success).toBe(false);
    expect(outbox.markFailed).toHaveBeenCalledWith('outbox-1', 'connection refused');
  });
});
