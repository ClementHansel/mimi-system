import { Module } from '@nestjs/common';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { ChatController, ChatInboundController, MyChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * W7 chat — two-way messaging over WhatsApp.
 *
 * Imports `NotificationModule` for `WhatsAppChannelService` rather than
 * talking to the gateway itself: that service already owns the n8n webhook,
 * the `notification_outbox` record of every attempt, and the `WA_ENABLED`
 * kill switch. Duplicating any of that here would give the system two
 * different answers to "did we actually send it".
 */
@Module({
  imports: [NotificationModule],
  controllers: [ChatController, MyChatController, ChatInboundController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
