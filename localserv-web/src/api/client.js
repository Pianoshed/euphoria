export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

// One websocket base for chat and calls. It follows VITE_API_BASE unless VITE_WS_BASE
// says otherwise, and it upgrades to wss:// on an https page (browsers block ws:// there).
export const WS_BASE = (() => {
  let base = (import.meta.env.VITE_WS_BASE || API_BASE).replace(/^http/, 'ws');
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    base = base.replace(/^ws:/, 'wss:');
  }
  return base.replace(/\/$/, '');
})();

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

// Make sure the first write request waits for the CSRF token instead of racing
// the startup bootstrapCsrf() call (which showed up as a 403 followed by a retry).
let csrfPromise = null;
function ensureCsrf() {
  if (csrfToken) return Promise.resolve();
  if (!csrfPromise) {
    csrfPromise = bootstrapCsrf()
      .catch(() => {})
      .finally(() => {
        csrfPromise = null;
      });
  }
  return csrfPromise;
}

// When the frontend and API are on different domains, JS cannot read the API's
// csrftoken cookie via document.cookie. The /csrf/ endpoint returns the token in
// its JSON body instead, and we keep it here and send it as X-CSRFToken.
let csrfToken = null;

// Django rotates the CSRF token whenever a user logs in, so after any of these
// succeed we fetch a fresh one.
const LOGIN_PATHS = new Set([
  '/api/accounts/login/',
  '/api/accounts/login/verify-2fa/',
  '/api/accounts/google/',
  '/api/accounts/google/register/',
]);

/**
 * @param {string} path - e.g. '/api/accounts/login/'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object|FormData} [options.body] - plain object is JSON-encoded; FormData is sent as-is (for file uploads)
 * @param {URLSearchParams|object} [options.query]
 */
export async function apiFetch(path, { method = 'GET', body, query } = {}, _retried = false) {
  let url = `${API_BASE}${path}`;
  if (query) {
    const cleaned = Object.fromEntries(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = new URLSearchParams(cleaned).toString();
    if (qs) url += `?${qs}`;
  }

  if (UNSAFE_METHODS.has(method) && !csrfToken) await ensureCsrf();

  const headers = {};
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (UNSAFE_METHODS.has(method)) {
    // Prefer the token we stored from /csrf/ (works cross-domain). Fall back to
    // the cookie, which only works when frontend and API share a domain
    // (e.g. localhost in development).
    const token = csrfToken || getCookie('csrftoken');
    if (token) headers['X-CSRFToken'] = token;
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

  // A 403 whose message mentions CSRF usually means our token is stale or was
  // never fetched. Refresh it and retry once.
  if (
    resp.status === 403 &&
    !_retried &&
    UNSAFE_METHODS.has(method) &&
    typeof data?.detail === 'string' &&
    data.detail.toLowerCase().includes('csrf')
  ) {
    await bootstrapCsrf();
    return apiFetch(path, { method, body, query }, true);
  }

  if (!resp.ok) {
    // Diagnostic: shows the server's reason in the console. Safe to remove later.
    console.error('[api]', method, path, resp.status, JSON.stringify(data), {
      sentCsrfHeader: !!headers['X-CSRFToken'],
    });
    throw new ApiError(resp.status, data);
  }

  if (method === 'POST' && LOGIN_PATHS.has(path)) {
    await bootstrapCsrf().catch(() => {});
  }

  return data;
}

export async function bootstrapCsrf() {
  const data = await apiFetch('/api/accounts/csrf/');
  csrfToken = data?.csrfToken || null;
}