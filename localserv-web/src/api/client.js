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

// Shown instead of "Failed to fetch" / "Request failed (500)" so people don't panic on a bad network.
export const CALM_NETWORK_MESSAGE = 'Your connection seems slow. Give it a moment and try again.';

/** Thrown for any non-2xx response (status 0 = the network itself failed). Carries the parsed body (if any)
 * so callers can read field-level validation errors DRF returns. */
export class ApiError extends Error {
  constructor(status, body) {
    const transient = !status || status >= 500;
    super(transient ? CALM_NETWORK_MESSAGE : typeof body?.detail === 'string' ? body.detail : `Request failed (${status})`);
    this.status = status;
    this.body = body;
    this.transient = transient;
  }
}

/** True for "the network or server hiccuped" errors (offline, timeouts, 5xx), as opposed to a real answer like 400/403/404. */
export const isTransientError = (error) =>
  !!error && (error.transient === true || error.status === 0 || error.status >= 500 || error instanceof TypeError);

// Reads are safe to repeat, so a flaky connection or a 5xx quietly retries (the page keeps showing its loader).
// Writes are never repeated automatically: that could double-submit a payment.
const RETRY_DELAYS_MS = [800, 2000, 4500];
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchResilient(url, init, canRetry) {
  for (let attempt = 0; ; attempt += 1) {
    const lastTry = !canRetry || attempt >= RETRY_DELAYS_MS.length;
    try {
      const resp = await fetch(url, init);
      if (canRetry && RETRY_STATUS.has(resp.status) && !lastTry) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return resp;
    } catch (networkErr) {
      if (lastTry) throw new ApiError(0, null);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Fired when the server says "you are not signed in" on a request that needed a session
// (idle timeout, browser was closed, cookie blocked). AuthContext listens and signs the user out in the UI.
export const AUTH_EXPIRED_EVENT = 'auth:expired';

function sessionIsGone(status, data) {
  if (status === 401) return true;
  const detail = typeof data?.detail === 'string' ? data.detail.toLowerCase() : '';
  return status === 403 && (detail.includes('authentication credentials were not provided') || detail.includes('not authenticated'));
}

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
  '/api/accounts/login/confirm-device/',
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

  const resp = await fetchResilient(url, {
    method,
    headers,
    credentials: 'include', // send the session + csrftoken cookies
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  }, method === 'GET');

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

  if (!resp.ok && !LOGIN_PATHS.has(path) && sessionIsGone(resp.status, data)) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
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

/**
 * Like apiFetch but returns the response body as a Blob (for images).
 * Sends the session cookie and CSRF header the same way.
 */
export async function apiBlob(path, { method = 'POST' } = {}) {
  if (UNSAFE_METHODS.has(method) && !csrfToken) await ensureCsrf();
  const headers = {};
  if (UNSAFE_METHODS.has(method)) {
    const token = csrfToken || getCookie('csrftoken');
    if (token) headers['X-CSRFToken'] = token;
  }
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, { method, headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, null);
  }
  if (!resp.ok) {
    const contentType = resp.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await resp.json().catch(() => null) : null;
    throw new ApiError(resp.status, data);
  }
  return resp.blob();
}
