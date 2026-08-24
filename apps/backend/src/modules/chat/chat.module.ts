import { Module } from '@nestjs/common';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { ChatController, ChatInboundController, MyChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { InternalChatController } from './internal-chat.controller';
import { InternalChatService } from './internal-chat.service';

/**
 * W7 chat — two-way messaging over WhatsApp, PLUS internal staff-to-staff
 * chat (person-to-person and group; migration 243).
 *
 * Imports `NotificationModule` for `WhatsAppChannelService` rather than
 * talking to the gateway itself: that service already owns the n8n webhook,
 * the `notification_outbox` record of every attempt, and the `WA_ENABLED`
 * kill switch. Duplicating any of that here would give the system two
 * different answers to "did we actually send it".
 *
 * `InternalChatService` is a SEPARATE service from `ChatService`, not a
 * branch inside it: the two operate on genuinely different authorization
 * models (location/central-scoped WhatsApp inbox vs membership-scoped
 * internal chat) even though they share the underlying tables, and keeping
 * them apart is what let the WhatsApp surface ship here completely
 * unmodified.
 */
@Module({
  imports: [NotificationModule],
  controllers: [ChatController, MyChatController, ChatInboundController, InternalChatController],
  providers: [ChatService, InternalChatService],
  exports: [ChatService, InternalChatService],
})
export class ChatModule {}
