import './chill.css';
import { useEffect, useState } from 'react';
import { CALM_NETWORK_MESSAGE, isTransientError } from '../api/client';
export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

/** Renders a caught ApiError (or any Error) as an alert. Pulls DRF's
 * {"detail": "..."} or per-field validation errors into one readable
 * string rather than dumping the raw object. */
export function ErrorAlert({ error, onRetry }) {
  if (!error) return null;
  // Bad network or a server hiccup: a faint, calm note instead of a red error, so nobody panics.
  if (isTransientError(error)) {
    return (
      <div className="soft-notice" role="status" aria-live="polite">
        <span>{CALM_NETWORK_MESSAGE}</span>
        <span className="chill__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        {onRetry && <button type="button" className="soft-notice__retry" onClick={onRetry}>Try again</button>}
      </div>
    );
  }
  return <div className="alert alert--error" role="alert">{formatError(error)}</div>;
}

// "service_id" -> "Service id"
const humanizeField = (field) => {
  const text = field.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function formatError(error) {
  if (isTransientError(error)) return CALM_NETWORK_MESSAGE;
  const body = error?.body;
  if (!body) return error?.message || 'Something went wrong.';
  if (typeof body.detail === 'string') return body.detail;
  const messages = [];
  for (const [field, value] of Object.entries(body)) {
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    messages.push(field === 'non_field_errors' ? text : `${humanizeField(field)}: ${text}`);
  }
  return messages.join(' ') || 'Something went wrong.';
}

/** IN_PROGRESS -> "in progress". Shared so pills and timelines read the same. */
export function humanizeStatus(status) {
  return String(status ?? '').replaceAll('_', ' ').toLowerCase();
}

const STATUS_TONE = {
  // neutral: nothing for anyone to do yet, or finished without a verdict
  DRAFT: 'neutral', PENDING: 'neutral', PROCESSING: 'neutral', OPEN: 'neutral',
  ARCHIVED: 'neutral', DISMISSED: 'neutral',
  // accent: in progress / needs attention
  ACCEPTED: 'accent', FUNDED: 'accent', IN_PROGRESS: 'accent', PUBLISHED: 'accent', DISPUTED: 'accent',
  // success
  COMPLETED: 'success', RELEASED: 'success', ACTIVE: 'success', RESOLVED: 'success', SUCCEEDED: 'success',
  // danger: something went wrong or was refused
  DECLINED: 'danger', CANCELLED: 'danger', REFUNDED: 'danger', SUSPENDED: 'danger',
  BANNED: 'danger', FAILED: 'danger',
};

export function StatusPill({ status }) {
  const tone = STATUS_TONE[status] || 'neutral';
  return <span className={`pill pill--${tone}`}>{humanizeStatus(status)}</span>;
}

/* ---------- Chill loader: a soft, rotating "loading" line instead of a bare spinner ---------- */

const CHILL_LINES = {
  chat: ['pulling up the gist…', 'hold up, vibes loading', 'one sec bestie', 'catching up on the tea ☕', 'no rush, we chillin'],
  people: ['finding your people…', 'scrolling the vibes', 'lemme cook 🍳', 'good ones take a sec'],
  plans: ['scouting the plans…', 'hold up, vibes loading', 'lemme cook 🍳', 'finding the fun stuff ✨'],
  default: ['one sec…', 'lemme cook 🍳', 'no rush, we chillin', 'loading the vibes ✨'],
};

/** Shows one line that changes every couple of seconds, with three gently bouncing dots. `kind`: chat | people | plans. */
export function ChillLoader({ kind = 'default', rows = 0 }) {
  const lines = CHILL_LINES[kind] || CHILL_LINES.default;
  const [i, setI] = useState(() => Math.floor(Math.random() * lines.length));
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % lines.length), 2200);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div className="chill" role="status" aria-live="polite" aria-label="Loading">
      <p className="chill__line" key={i}>
        {lines[i]}
        <span className="chill__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
      </p>
      {rows > 0 && (
        <div className="chill__rows" aria-hidden="true">
          {Array.from({ length: rows }, (_, n) => <span key={n} className={`chill__bar chill__bar--${n % 2 ? 'r' : 'l'}`} style={{ '--w': `${44 + ((n * 17) % 34)}%` }} />)}
        </div>
      )}
    </div>
  );
}

/** Full-page wait while we check who is signed in. If the server is slow or erroring we say so calmly
 * (and keep retrying in the background) instead of sending people to the login page. */
export function SessionLoading({ unreachable }) {
  return (
    <div className="page page-loading">
      <Spinner />
      {unreachable && (
        <div className="soft-notice" role="status" aria-live="polite" style={{ marginTop: 16, textAlign: 'center' }}>
          <span>We're having a little trouble connecting. Hang tight, we'll keep trying</span>
          <span className="chill__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
          <button type="button" className="soft-notice__retry" onClick={() => window.location.reload()}>Try again</button>
        </div>
      )}
    </div>
  );
}
