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

/**
 * A pool whose `tenant_email_settings` lookup finds nothing, so the service
 * falls back to the environment. That is the path these tests exercise:
 * per-tenant configuration has its own live-DB spec, because a fake pool
 * cannot prove anything about RLS or the sealed password.
 */
function fakePool(rows: Record<string, unknown>[] = []) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/tenant_email_settings/.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as never;
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
    const service = new EmailChannelService(fakeConfig({ SMTP_HOST: '' }), outbox, fakePool());

    expect(await service.isConfigured('tenant-1')).toBe(false);
    const result = await service.send(
      'tenant-1',
      'owner@mimichicken.local',
      'low_stock',
      'Subject',
      'Body',
    );

    expect(result.success).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(
      'outbox-1',
      'No SMTP configured for this tenant',
    );
  });

  it('sends via nodemailer and marks the outbox row sent when SMTP is configured', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    const outbox = fakeOutbox();
    const service = new EmailChannelService(
      fakeConfig({ SMTP_HOST: 'smtp.example.com', SMTP_FROM_EMAIL: 'noreply@mimichicken.local' }),
      outbox,
      fakePool(),
    );

    expect(await service.isConfigured('tenant-1')).toBe(true);
    const result = await service.send(
      'tenant-1',
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
    const service = new EmailChannelService(
      fakeConfig({ SMTP_HOST: 'smtp.example.com' }),
      outbox,
      fakePool(),
    );

    const result = await service.send(
      'tenant-1',
      'owner@mimichicken.local',
      'low_stock',
      'Subject',
      'Body',
    );

    expect(result.success).toBe(false);
    expect(outbox.markFailed).toHaveBeenCalledWith('outbox-1', 'connection refused');
  });

  it("uses the TENANT's own SMTP rather than the environment when one is configured", async () => {
    // The whole point of migration 264. With a row present, the environment
    // fallback must not win — otherwise every tenant would silently send from
    // whichever mailbox the deployment happened to be started with.
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    const outbox = fakeOutbox();
    const service = new EmailChannelService(
      fakeConfig({ SMTP_HOST: 'env-host.example.com', SMTP_FROM_EMAIL: 'env@example.com' }),
      outbox,
      fakePool([
        {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          username: 'client-a@gmail.com',
          password_encrypted: null,
          from_email: 'client-a@gmail.com',
          from_name: 'Client A',
          is_enabled: true,
        },
      ]),
    );

    await service.send('tenant-a', 'staff@client-a.com', 'low_stock', 'Subject', 'Body');

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"Client A" <client-a@gmail.com>' }),
    );
  });

  it('does not send for a tenant who has switched sending off', async () => {
    // `is_enabled=false` lets a tenant stop sending without deleting their
    // credentials. Ignoring it would keep mailing from an account they have
    // deliberately parked.
    const outbox = fakeOutbox();
    const service = new EmailChannelService(
      fakeConfig({ SMTP_HOST: 'env-host.example.com' }),
      outbox,
      fakePool([
        {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          username: 'client-a@gmail.com',
          password_encrypted: null,
          from_email: 'client-a@gmail.com',
          from_name: null,
          is_enabled: false,
        },
      ]),
    );

    const result = await service.send('tenant-a', 'staff@x.com', 'low_stock', 'S', 'B');

    expect(result.success).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
