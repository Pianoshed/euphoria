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

// Endpoints after which Django rotates the CSRF token (session changes).
const TOKEN_ROTATING_PATHS = [
  '/api/accounts/login/',
  '/api/accounts/login/verify-2fa/',
  '/api/accounts/google/',
  '/api/accounts/google/register/',
  '/api/accounts/logout/',
];

// When the frontend and API are on different domains, JS can't read the
// API's csrftoken cookie, so we keep the token returned in the response
// body of /api/accounts/csrf/ and send that as X-CSRFToken instead.
let csrfToken = null;

export function resetCsrf() {
  csrfToken = null;
}

async function fetchCsrfToken() {
  const resp = await fetch(`${API_BASE}/api/accounts/csrf/`, { credentials: 'include' });
  const data = await resp.json().catch(() => null);
  csrfToken = data?.csrfToken || null;
  return csrfToken;
}

async function getCsrfToken() {
  // Cached body token first; cookie only works when same-origin (e.g. localhost).
  return csrfToken || getCookie('csrftoken') || (await fetchCsrfToken());
}

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

  const isFormData = body instanceof FormData;
  const unsafe = UNSAFE_METHODS.has(method);

  const send = async (token) => {
    const headers = {};
    if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
    if (unsafe && token) headers['X-CSRFToken'] = token;
    return fetch(url, {
      method,
      headers,
      credentials: 'include', // send the session + csrftoken cookies
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
    });
  };

  let resp = await send(unsafe ? await getCsrfToken() : null);

  // Stale or missing token: fetch a fresh one and retry once.
  if (unsafe && resp.status === 403) {
    const text = await resp.clone().text();
    if (text.includes('CSRF')) {
      resp = await send(await fetchCsrfToken());
    }
  }

  if (resp.ok && TOKEN_ROTATING_PATHS.includes(path)) resetCsrf();

  if (resp.status === 204) return null;

  const contentType = resp.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await resp.json().catch(() => null) : null;

  if (!resp.ok) throw new ApiError(resp.status, data);
  return data;
}

export async function bootstrapCsrf() {
  await fetchCsrfToken();
}