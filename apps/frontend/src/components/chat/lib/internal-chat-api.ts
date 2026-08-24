import { api } from '@/lib/api';
import type { UUID } from '@/lib/shared-types';
import type { ChatMessage } from './chat-api';

/**
 * Internal (staff-to-staff) chat — paths transcribed from
 * `apps/backend/src/modules/chat/internal-chat.controller.ts`. Separate
 * client module from `chat-api.ts` (the WhatsApp admin inbox) because the
 * two are genuinely different surfaces reached by different audiences —
 * `chat-api.ts` stays exactly as it was.
 */

export interface InternalConversation {
  id: UUID;
  kind: 'direct' | 'group';
  /** Group name for a 'group' row; the other person's display name for a 'direct' row. */
  name: string | null;
  myRole: 'member' | 'admin';
  participantCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

export interface ChatParticipant {
  userId: UUID;
  name: string;
  role: 'member' | 'admin';
  joinedAt: string;
}

export interface InternalConversationDetail extends InternalConversation {
  participants: ChatParticipant[];
}

export interface DirectoryUser {
  id: UUID;
  name: string;
  roleName: string;
}

export function listMyConversations() {
  return api.get<InternalConversation[]>('/chat/internal/conversations');
}

/** The member-picker's data source. An empty/omitted `query` returns the first page of everyone (server caps at 20). */
export function searchDirectory(query?: string) {
  const qs = query ? `?query=${encodeURIComponent(query)}` : '';
  return api.get<DirectoryUser[]>(`/chat/internal/directory${qs}`);
}

export function openDirect(userId: string) {
  return api.post<InternalConversation>('/chat/internal/direct', { userId });
}

export function createGroup(name: string, memberIds: string[]) {
  return api.post<InternalConversation>('/chat/internal/groups', { name, memberIds });
}

export function renameGroup(conversationId: string, name: string) {
  return api.patch<InternalConversation>(`/chat/internal/groups/${conversationId}`, { name });
}

export function addGroupMember(conversationId: string, userId: string) {
  return api.post<{ ok: true }>(`/chat/internal/groups/${conversationId}/members`, { userId });
}

export function removeGroupMember(conversationId: string, userId: string) {
  return api.delete<{ ok: true }>(`/chat/internal/groups/${conversationId}/members/${userId}`);
}

export function leaveGroup(conversationId: string) {
  return api.post<{ ok: true }>(`/chat/internal/groups/${conversationId}/leave`, {});
}

export function getConversationDetail(conversationId: string) {
  return api.get<InternalConversationDetail>(`/chat/internal/${conversationId}`);
}

export function getInternalMessages(conversationId: string) {
  return api.get<ChatMessage[]>(`/chat/internal/${conversationId}/messages`);
}

export function sendInternalMessage(conversationId: string, body: string) {
  return api.post<ChatMessage>(`/chat/internal/${conversationId}/messages`, { body });
}

export function markInternalRead(conversationId: string) {
  return api.post<{ ok: true }>(`/chat/internal/${conversationId}/read`, {});
}
