import { apiFetch } from './client';

export const listConversations = () => apiFetch('/api/chat/conversations/');

export const startConversation = (targetUserId) =>
  apiFetch('/api/chat/conversations/', { method: 'POST', body: { target_user_id: targetUserId } });

export const getConversation = (id) => apiFetch(`/api/chat/conversations/${id}/`);

export const listMessages = (conversationId) =>
  apiFetch(`/api/chat/conversations/${conversationId}/messages/`);

export const sendMessage = (conversationId, body, attachment) => {
  if (attachment) {
    const form = new FormData();
    if (body) form.append('body', body);
    form.append('attachment', attachment);
    return apiFetch(`/api/chat/conversations/${conversationId}/messages/`, { method: 'POST', body: form });
  }
  return apiFetch(`/api/chat/conversations/${conversationId}/messages/`, { method: 'POST', body: { body } });
};

export const markConversationRead = (conversationId) =>
  apiFetch(`/api/chat/conversations/${conversationId}/read/`, { method: 'POST' });

export const editMessage = (messageId, body) =>
  apiFetch(`/api/chat/messages/${messageId}/`, { method: 'PATCH', body: { body } });

export const deleteMessage = (messageId) =>
  apiFetch(`/api/chat/messages/${messageId}/`, { method: 'DELETE' });

// Short-lived STUN/TURN credentials for video calls.
export const getIceServers = () => apiFetch('/api/chat/ice-servers/');

// Calls ringing for me right now. Fallback for the site-wide call socket (see IncomingCallNotifier).
export const listIncomingCalls = () => apiFetch('/api/chat/calls/incoming/');

// Call log (audit trail). The server records every call itself from the call signaling, so the
// browser only reads it. Staff can pass scope='all' to see every call on the site.
export const listCallLogs = ({ scope = 'mine', page = 1 } = {}) =>
  apiFetch('/api/chat/calls/', { query: { scope, page } });
