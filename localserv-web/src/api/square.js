import { apiFetch } from './client';

export const listStatuses = () => apiFetch('/api/square/statuses/');
// formData: text?  +  EITHER file (one photo)  OR  slides (2-7 photos, repeat the field) with
// slide_seconds? and music? (JSON string {provider,id} from searchMusic). Videos are no longer uploaded.
export const createStatus = (formData) => apiFetch('/api/square/statuses/', { method: 'POST', body: formData });
export const reactStatus = (id, emoji) =>
  apiFetch(`/api/square/statuses/${id}/react/`, { method: 'POST', body: { emoji } });
// Owner only (anyone else gets 404). Removes the files and the row for good; resolves on 204.
export const deleteStatus = (id) => apiFetch(`/api/square/statuses/${id}/`, { method: 'DELETE' });

// Free-to-use (CC0 / public domain / CC-BY) tracks for slideshow music. Nothing is stored on our side.
export const searchMusic = (q) => apiFetch('/api/square/music/', { query: { q } });

// 2 random free tracks (shared server-side pool). `exclude` = ids already shown, so Shuffle gives a new pair.
export const suggestMusic = (exclude = []) =>
  apiFetch('/api/square/music/suggest/', { query: { exclude: exclude.join(',') } });

// Marks a status as watched (saved on the server so it survives refreshes and other devices).
export const markSeen = (id) => apiFetch(`/api/square/statuses/${id}/seen/`, { method: 'POST' });

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
