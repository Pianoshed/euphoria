import { apiFetch } from './client';

// Accepts both a plain list and a paginated { results: [...] } reply, so categories show up either way.
export const listCategories = () => apiFetch('/api/services/categories/')
  .then((data) => (Array.isArray(data) ? data : (data?.results ?? [])));

export const listServices = (params) => apiFetch('/api/services/', { query: params });

export const getService = (id) => apiFetch(`/api/services/${id}/`);

export const createService = (fields) => apiFetch('/api/services/', { method: 'POST', body: fields });

export const updateService = (id, fields) =>
  apiFetch(`/api/services/${id}/`, { method: 'PATCH', body: fields });

export const transitionService = (id, to_status) =>
  apiFetch(`/api/services/${id}/transition/`, { method: 'POST', body: { to_status } });

export const listServiceReviews = (id) => apiFetch(`/api/services/${id}/reviews/`);
