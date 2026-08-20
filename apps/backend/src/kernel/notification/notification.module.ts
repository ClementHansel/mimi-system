import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationGateway } from './notification.gateway';
import { EmailChannelService } from './channels/email-channel.service';
import { WhatsAppChannelService } from './channels/whatsapp-channel.service';
import { InAppChannelService } from './channels/in-app-channel.service';
import { NotificationOutboxRepository } from './channels/notification-outbox.repository';

/**
 * kernel/notification — `NotificationService` with a template registry
 * (`template-registry.ts`) and three pluggable channels: in-app (DB row +
 * socket.io push), email (SMTP via nodemailer), and WhatsApp (n8n webhook,
 * outbox-mocked while `WA_ENABLED=false` — D-03, RISK-P4).
 *
 * Backs `GET /api/notifications`, `.../read`, `.../read-all`
 * (CONTRACTS.md §4.0). See `notification.service.ts` for the fan-out design
 * and `i18n/id-ID.ts` for why Indonesian copy lives in exactly one file.
 */
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationGateway,
    NotificationOutboxRepository,
    EmailChannelService,
    WhatsAppChannelService,
    InAppChannelService,
  ],
  // `WhatsAppChannelService` is exported for `modules/chat`, which sends
  // conversation messages through the SAME channel so that chat inherits the
  // outbox record and the `WA_ENABLED` kill switch instead of holding a second
  // opinion about whether a message was delivered.
  exports: [NotificationService, WhatsAppChannelService],
})
export class NotificationModule {}
