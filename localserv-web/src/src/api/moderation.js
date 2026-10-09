import { apiFetch } from './client';

export const fileReport = (targetType, targetId, reason, detail) =>
  apiFetch('/api/moderation/reports/', {
    method: 'POST',
    body: { target_type: targetType, target_id: targetId, reason, detail },
  });

export const listReports = (params) => apiFetch('/api/moderation/reports/', { query: params });

export const getReport = (id) => apiFetch(`/api/moderation/reports/${id}/`);

export const resolveReport = (id, resolution, note) =>
  apiFetch(`/api/moderation/reports/${id}/resolve/`, { method: 'POST', body: { resolution, note } });

export const suspendAccount = (userId, reason) =>
  apiFetch(`/api/moderation/users/${userId}/suspend/`, { method: 'POST', body: { reason } });

export const banAccount = (userId, reason) =>
  apiFetch(`/api/moderation/users/${userId}/ban/`, { method: 'POST', body: { reason } });

export const reinstateAccount = (userId, reason) =>
  apiFetch(`/api/moderation/users/${userId}/reinstate/`, { method: 'POST', body: { reason } });

export const suspendListing = (serviceId, reason) =>
  apiFetch(`/api/moderation/services/${serviceId}/suspend/`, { method: 'POST', body: { reason } });

export const unsuspendListing = (serviceId) =>
  apiFetch(`/api/moderation/services/${serviceId}/unsuspend/`, { method: 'POST' });
