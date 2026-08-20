import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ERR_VALIDATION, type Paginated, type UUID } from '@mimi/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatService, type ChatConversation, type ChatMessage } from './chat.service';
import { requireDbClient } from './request-db-client';
import {
  InboundWebhookDto,
  OpenConversationDto,
  SendMessageDto,
  SetStatusDto,
} from './dto/chat.dto';

/**
 * W7 chat — the ADMIN inbox. Reading and replying to every conversation is a
 * head-office job, so all of it sits behind `chat.read` / `chat.send`.
 */
@Controller('chat/conversations')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly service: ChatService) {}

  @Get()
  @RequirePermission('chat.read')
  list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<ChatConversation>> {
    return this.service.listConversations(requireDbClient(req), {
      status,
      page: page ? Number.parseInt(page, 10) : undefined,
      pageSize: pageSize ? Number.parseInt(pageSize, 10) : undefined,
    });
  }

  @Get(':id/messages')
  @RequirePermission('chat.read')
  messages(@Req() req: Request, @Param('id') id: UUID): Promise<ChatMessage[]> {
    return this.service.getMessages(requireDbClient(req), id);
  }

  @Post()
  @RequirePermission('chat.send')
  @Audited({ entityType: 'chat_conversations', action: 'chat.send' })
  open(@Req() req: Request, @Body() dto: OpenConversationDto): Promise<ChatConversation> {
    return this.service.openConversation(requireDbClient(req), {
      phone: dto.phone,
      name: dto.name ?? null,
      supplierId: (dto.supplierId as UUID | undefined) ?? null,
    });
  }

  @Post(':id/messages')
  @RequirePermission('chat.send')
  @Audited({ entityType: 'chat_messages', action: 'chat.send' })
  send(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Param('id') id: UUID,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.service.sendMessage(requireDbClient(req), id, user.sub as UUID, dto.body);
  }

  @Post(':id/read')
  @RequirePermission('chat.read')
  markRead(@Req() req: Request, @Param('id') id: UUID): Promise<{ read: number }> {
    return this.service.markRead(requireDbClient(req), id);
  }

  @Post(':id/status')
  @RequirePermission('chat.manage')
  @Audited({ entityType: 'chat_conversations', action: 'chat.manage' })
  setStatus(
    @Req() req: Request,
    @Param('id') id: UUID,
    @Body() dto: SetStatusDto,
  ): Promise<ChatConversation> {
    return this.service.setStatus(requireDbClient(req), id, dto.status);
  }
}

/**
 * The CLIENT side: one staff member's own thread with head office.
 *
 * A separate controller rather than a branch inside the inbox, because the
 * permission is genuinely different — every role holds `chat.read.own`,
 * almost none hold `chat.read` — and a driver must never be one wrong
 * conditional away from the supplier negotiations.
 */
@Controller('chat/me')
@UseGuards(JwtAuthGuard)
export class MyChatController {
  constructor(private readonly service: ChatService) {}

  @Get()
  @RequirePermission('chat.read.own')
  async mine(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
    return this.service.getOwnConversation(requireDbClient(req), user.sub as UUID);
  }

  @Post('messages')
  @RequirePermission('chat.read.own')
  @Audited({ entityType: 'chat_messages', action: 'chat.read.own' })
  async send(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    const client = requireDbClient(req);
    // Resolved from the SESSION, never from a body parameter: accepting a
    // conversation id here would let any authenticated user post into someone
    // else's thread, which is the same class of hole as B-15's PIN oracle.
    const { conversation } = await this.service.getOwnConversation(client, user.sub as UUID);
    return this.service.sendMessage(client, conversation.id, user.sub as UUID, dto.body);
  }
}

/**
 * Inbound from the n8n WhatsApp workflow.
 *
 * `@Public` because the gateway holds no user session — and therefore it is
 * authenticated by a SHARED SECRET instead, compared here before anything is
 * written. An unauthenticated write endpoint would let anyone on the internet
 * inject messages that appear to come from a supplier.
 *
 * If `N8N_WEBHOOK_SECRET` is unset the endpoint REFUSES every request rather
 * than defaulting to open. Chat simply does not receive until the secret is
 * configured, which is the safe direction to fail in and matches how
 * `WA_ENABLED` already gates the outbound half.
 *
 * It runs under `withSystemContext`: there is no acting user, and the sender
 * is a member of the public whose message must land regardless of any
 * location scope.
 */
@Controller('chat/inbound')
export class ChatInboundController {
  constructor(
    private readonly service: ChatService,
    private readonly config: ConfigService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Post()
  @Public()
  async receive(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() dto: InboundWebhookDto,
  ): Promise<{ ok: true; duplicate: boolean }> {
    const expected = this.config.get<string>('N8N_WEBHOOK_SECRET', '');
    if (!expected || secret !== expected) {
      // Deliberately not "unauthorized": a public endpoint that distinguishes
      // "wrong secret" from "no secret configured" tells a prober which it is.
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'Invalid webhook request' });
    }
    const result = await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, (client) =>
      this.service.receiveInbound(client, {
        phone: dto.phone,
        body: dto.body,
        externalId: dto.externalId ?? null,
        occurredAt: dto.occurredAt ?? null,
      }),
    );
    return { ok: true, duplicate: result.duplicate };
  }
}
