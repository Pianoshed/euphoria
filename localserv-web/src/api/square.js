import { apiFetch } from './client';

export const listStatuses = () => apiFetch('/api/square/statuses/');
// formData: text?, file?, duration? (seconds, videos only)
export const createStatus = (formData) => apiFetch('/api/square/statuses/', { method: 'POST', body: formData });
export const reactStatus = (id, emoji) =>
  apiFetch(`/api/square/statuses/${id}/react/`, { method: 'POST', body: { emoji } });

export const listThoughts = () => apiFetch('/api/square/thoughts/');
export const createThought = (text) => apiFetch('/api/square/thoughts/', { method: 'POST', body: { text } });
export const reactThought = (id, emoji) =>
  apiFetch(`/api/square/thoughts/${id}/react/`, { method: 'POST', body: { emoji } });

export const getTrending = () => apiFetch('/api/square/trending/');

// Friend trees: only the owner and tagged people ever get these back.
export const listTrees = () => apiFetch('/api/square/trees/');
// labels: { [personId]: 'family' | 'friends' | 'work' | ... } (see pages/square/circles.js)
export const createTree = (title, members, note = '', labels) =>
  apiFetch('/api/square/trees/', { method: 'POST', body: { title, members, note, labels } });
export const updateTree = (id, fields) => apiFetch(`/api/square/trees/${id}/`, { method: 'PATCH', body: fields });
// Owner: deletes the tree. Tagged friend: removes themselves from it.
export const removeTree = (id) => apiFetch(`/api/square/trees/${id}/`, { method: 'DELETE' });
