import { apiFetch } from './client';

export const listCategories = () => apiFetch('/api/services/categories/');

export const listServices = (params) => apiFetch('/api/services/', { query: params });

export const getService = (id) => apiFetch(`/api/services/${id}/`);

export const createService = (fields) => apiFetch('/api/services/', { method: 'POST', body: fields });

export const updateService = (id, fields) =>
  apiFetch(`/api/services/${id}/`, { method: 'PATCH', body: fields });

export const transitionService = (id, to_status) =>
  apiFetch(`/api/services/${id}/transition/`, { method: 'POST', body: { to_status } });

export const listServiceReviews = (id) => apiFetch(`/api/services/${id}/reviews/`);
