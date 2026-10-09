import { apiFetch } from './client';

export const listConversations = () => apiFetch('/api/chat/conversations/');

export const startConversation = (targetUserId) =>
  apiFetch('/api/chat/conversations/', { method: 'POST', body: { target_user_id: targetUserId } });

// Group chats. A group needs at least 2 other people; the creator becomes its admin.
export const createGroup = (memberIds, title) =>
  apiFetch('/api/chat/conversations/', { method: 'POST', body: { member_ids: memberIds, title: title || '' } });

export const addGroupMembers = (conversationId, userIds) =>
  apiFetch(`/api/chat/conversations/${conversationId}/members/`, { method: 'POST', body: { user_ids: userIds } });

// An admin removes someone, or pass your own id to leave.
export const removeGroupMember = (conversationId, userId) =>
  apiFetch(`/api/chat/conversations/${conversationId}/members/${userId}/`, { method: 'DELETE' });

export const renameGroup = (conversationId, title) =>
  apiFetch(`/api/chat/conversations/${conversationId}/`, { method: 'PATCH', body: { title } });

// Invite link + join requests. An admin shares the link; whoever opens it can only ASK to join.
export const getInviteCode = (conversationId, reset = false) =>
  apiFetch(`/api/chat/conversations/${conversationId}/invite/`, { method: 'POST', body: { reset } });
export const previewGroupInvite = (code) => apiFetch(`/api/chat/groups/join/${encodeURIComponent(code)}/`);
export const requestToJoin = (code) =>
  apiFetch(`/api/chat/groups/join/${encodeURIComponent(code)}/`, { method: 'POST', body: {} });
export const listJoinRequests = (conversationId) =>
  apiFetch(`/api/chat/conversations/${conversationId}/join-requests/`);
// action: 'approve' | 'decline'
export const decideJoinRequest = (conversationId, requestId, action) =>
  apiFetch(`/api/chat/conversations/${conversationId}/join-requests/${requestId}/`, { method: 'POST', body: { action } });

export const getConversation = (id) => apiFetch(`/api/chat/conversations/${id}/`);

// `after` (ISO time) asks only for messages created or changed since then: a quiet poll then
// returns a few bytes instead of the latest 30 messages.
export const listMessages = (conversationId, after) =>
  apiFetch(`/api/chat/conversations/${conversationId}/messages/`, { query: after ? { after } : undefined });

export const sendMessage = (conversationId, body, attachment) => {
  if (attachment) {
    const form = new FormData();
    if (body) form.append('body', body);
    form.append('attachment', attachment);
    return apiFetch(`/api/chat/conversations/${conversationId}/messages/`, { method: 'POST', body: form });
  }
  return apiFetch(`/api/chat/conversations/${conversationId}/messages/`, { method: 'POST', body: { body } });
};

// Group extras. Both are silent: no message is created and nobody is notified.
export const pinMessage = (messageId) => apiFetch(`/api/chat/messages/${messageId}/pin/`, { method: 'POST' });
export const unpinMessage = (messageId) => apiFetch(`/api/chat/messages/${messageId}/pin/`, { method: 'DELETE' });
// mood: 'happy' | 'calm' | 'meh' | 'low' | 'upset' | '' (clear)
export const setMood = (conversationId, mood) =>
  apiFetch(`/api/chat/conversations/${conversationId}/mood/`, { method: 'PUT', body: { mood } });

export const markConversationRead = (conversationId) =>
  apiFetch(`/api/chat/conversations/${conversationId}/read/`, { method: 'POST' });

export const editMessage = (messageId, body) =>
  apiFetch(`/api/chat/messages/${messageId}/`, { method: 'PATCH', body: { body } });

export const deleteMessage = (messageId) =>
  apiFetch(`/api/chat/messages/${messageId}/`, { method: 'DELETE' });

// Short-lived STUN/TURN credentials for video calls.
export const getIceServers = () => apiFetch('/api/chat/ice-servers/');

// Is a call going on in this group, and who is on it? { active, call_id, mode, participants, in_call, full, ... }
export const getGroupCall = (conversationId) => apiFetch(`/api/chat/conversations/${conversationId}/group-call/`);

// Calls ringing for me right now. Fallback for the site-wide call socket (see IncomingCallNotifier).
export const listIncomingCalls = () => apiFetch('/api/chat/calls/incoming/');

// Call log (audit trail). The server records every call itself from the call signaling, so the
// browser only reads it. Staff can pass scope='all' to see every call on the site.
export const listCallLogs = ({ scope = 'mine', page = 1 } = {}) =>
  apiFetch('/api/chat/calls/', { query: { scope, page } });
