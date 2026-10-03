export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

/** Thrown for any non-2xx response. Carries the parsed body (if any)
 * so callers can read field-level validation errors DRF returns. */
export class ApiError extends Error {
  constructor(status, body) {
    super(typeof body?.detail === 'string' ? body.detail : `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * @param {string} path - e.g. '/api/accounts/login/'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object|FormData} [options.body] - plain object is JSON-encoded; FormData is sent as-is (for file uploads)
 * @param {URLSearchParams|object} [options.query]
 */
export async function apiFetch(path, { method = 'GET', body, query } = {}) {
  let url = `${API_BASE}${path}`;
  if (query) {
    const cleaned = Object.fromEntries(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = new URLSearchParams(cleaned).toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {};
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (UNSAFE_METHODS.has(method)) {
    // Django's CSRF cookie is only ever set after something calls
    // get_token() -- see the app-level bootstrapCsrf() call on
    // startup (App.jsx). If it's somehow missing, we still send the
    // request; Django will reject it with a clear 403 rather than us
    // failing silently here.
    const csrftoken = getCookie('csrftoken');
    if (csrftoken) headers['X-CSRFToken'] = csrftoken;
  }

  const resp = await fetch(url, {
    method,
    headers,
    credentials: 'include', // send the session + csrftoken cookies
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  if (resp.status === 204) return null;

  const contentType = resp.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await resp.json().catch(() => null) : null;

  if (!resp.ok) throw new ApiError(resp.status, data);
  return data;
}

export async function bootstrapCsrf() {
  await apiFetch('/api/accounts/csrf/');
}
