import { api } from '@/lib/api';
import type { Paginated, UUID } from '@/lib/shared-types';

/** W7 chat — paths transcribed from `apps/backend/src/modules/chat/chat.controller.ts`. */

export interface ChatConversation {
  id: UUID;
  contactPhone: string;
  contactName: string | null;
  supplierId: UUID | null;
  userId: UUID | null;
  locationId: UUID | null;
  status: 'open' | 'closed';
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

export interface ChatMessage {
  id: UUID;
  conversationId: UUID;
  direction: 'inbound' | 'outbound';
  body: string;
  senderUserId: UUID | null;
  senderName: string | null;
  /** `pending` genuinely means "not delivered yet" — with `WA_ENABLED=false` everything outbound stays pending. The UI must not render it as sent. */
  deliveryStatus: 'pending' | 'sent' | 'failed' | 'received';
  readAt: string | null;
  occurredAt: string;
}

export function listConversations(params: { status?: string; page?: number } = {}) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '50' });
  if (params.status) qs.set('status', params.status);
  return api.get<Paginated<ChatConversation>>(`/chat/conversations?${qs.toString()}`);
}

export function getMessages(conversationId: string) {
  return api.get<ChatMessage[]>(`/chat/conversations/${conversationId}/messages`);
}

export function sendMessage(conversationId: string, body: string) {
  return api.post<ChatMessage>(`/chat/conversations/${conversationId}/messages`, { body });
}

export function openConversation(body: { phone: string; name?: string; supplierId?: string }) {
  return api.post<ChatConversation>('/chat/conversations', body);
}

export function markRead(conversationId: string) {
  return api.post<{ read: number }>(`/chat/conversations/${conversationId}/read`, {});
}

export function setStatus(conversationId: string, status: 'open' | 'closed') {
  return api.post<ChatConversation>(`/chat/conversations/${conversationId}/status`, { status });
}

// ── the staff member's own thread ────────────────────────────────────────────

export function getMyChat() {
  return api.get<{ conversation: ChatConversation; messages: ChatMessage[] }>('/chat/me');
}

/** No conversation id: the server resolves the thread from the session, so one user can never post into another's. */
export function sendMyMessage(body: string) {
  return api.post<ChatMessage>('/chat/me/messages', { body });
}
