import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { UUID } from '@mimi/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient } from './request-db-client';
import type { ChatMessage } from './chat.service';
import {
  InternalChatService,
  type DirectoryUser,
  type InternalConversation,
  type InternalConversationDetail,
} from './internal-chat.service';
import { SendMessageDto } from './dto/chat.dto';
import {
  AddMemberDto,
  CreateGroupDto,
  OpenDirectDto,
  RenameGroupDto,
} from './dto/internal-chat.dto';

/**
 * Internal (staff-to-staff) chat — person-to-person and group, SEPARATE from
 * the WhatsApp inbox in `chat.controller.ts` above. Every route here is
 * gated by `chat.read.own`, the SAME key `/chat/me` already uses (226) —
 * not a new permission. It is granted to every role and already overloaded
 * to mean "read AND send your own chat surface" by that existing
 * controller; this reuses it because the shape is identical here too: what
 * you may see or do is bounded by YOUR OWN participation, not a role tier.
 *
 * Group-admin-only actions (rename/add/remove) are NOT gated by a
 * permission key at all — `chat_participants.role` is a per-conversation
 * fact, not a platform-wide one, so `InternalChatService` checks it
 * directly. A `superadmin` holds `chat.read.own` like everyone else, but is
 * not thereby an admin of a group they were never made admin of.
 *
 * Literal-segment routes (`conversations`, `direct`, `groups`) are declared
 * before the `:id` routes below on purpose: Nest/Express resolve routes in
 * declaration order, and a `:id` route declared first would swallow
 * `/conversations` as if `"conversations"` were an id.
 */
@Controller('chat/internal')
@UseGuards(JwtAuthGuard)
export class InternalChatController {
  constructor(private readonly service: InternalChatService) {}

  @Get('conversations')
  @RequirePermission('chat.read.own')
  list(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<InternalConversation[]> {
    return this.service.listMine(requireDbClient(req), user.sub as UUID);
  }

  /** The member-picker's data source — "who can I message" (see `InternalChatService.searchDirectory`'s comment on why this cannot just be a `users` query). */
  @Get('directory')
  @RequirePermission('chat.read.own')
  directory(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Query('query') query?: string,
  ): Promise<DirectoryUser[]> {
    return this.service.searchDirectory(requireDbClient(req), user.sub as UUID, query);
  }

  @Post('direct')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_conversations', action: 'chat.read.own' })
  openDirect(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Body() dto: OpenDirectDto,
  ): Promise<InternalConversation> {
    return this.service.openDirect(requireDbClient(req), user.sub as UUID, dto.userId as UUID);
  }

  @Post('groups')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_conversations', action: 'chat.read.own' })
  createGroup(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Body() dto: CreateGroupDto,
  ): Promise<InternalConversation> {
    return this.service.createGroup(
      requireDbClient(req),
      user.sub as UUID,
      dto.name,
      dto.memberIds as UUID[],
    );
  }

  @Patch('groups/:id')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_conversations', action: 'chat.read.own' })
  rename(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
    @Body() dto: RenameGroupDto,
  ): Promise<InternalConversation> {
    return this.service.renameGroup(requireDbClient(req), user.sub as UUID, id, dto.name);
  }

  @Post('groups/:id/members')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_participants', action: 'chat.read.own' })
  async addMember(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
    @Body() dto: AddMemberDto,
  ): Promise<{ ok: true }> {
    await this.service.addMember(requireDbClient(req), user.sub as UUID, id, dto.userId as UUID);
    return { ok: true };
  }

  @Delete('groups/:id/members/:userId')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_participants', action: 'chat.read.own' })
  async removeMember(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
    @Param('userId') userId: UUID,
  ): Promise<{ ok: true }> {
    await this.service.removeMember(requireDbClient(req), user.sub as UUID, id, userId as UUID);
    return { ok: true };
  }

  @Post('groups/:id/leave')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_participants', action: 'chat.read.own' })
  async leave(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
  ): Promise<{ ok: true }> {
    await this.service.leaveGroup(requireDbClient(req), user.sub as UUID, id);
    return { ok: true };
  }

  @Get(':id')
  @RequirePermission('chat.read.own')
  detail(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
  ): Promise<InternalConversationDetail> {
    return this.service.getDetail(requireDbClient(req), user.sub as UUID, id);
  }

  @Get(':id/messages')
  @RequirePermission('chat.read.own')
  messages(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
  ): Promise<ChatMessage[]> {
    return this.service.getMessages(requireDbClient(req), user.sub as UUID, id);
  }

  @Post(':id/messages')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_messages', action: 'chat.read.own' })
  send(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.service.sendMessage(requireDbClient(req), user.sub as UUID, id, dto.body);
  }

  @Post(':id/read')
  @RequirePermission('chat.read.own')
  async markRead(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
  ): Promise<{ ok: true }> {
    await this.service.markRead(requireDbClient(req), user.sub as UUID, id);
    return { ok: true };
  }
}
