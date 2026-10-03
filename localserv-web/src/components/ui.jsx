export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

/** Renders a caught ApiError (or any Error) as an alert. Pulls DRF's
 * {"detail": "..."} or per-field validation errors into one readable
 * string rather than dumping the raw object. */
export function ErrorAlert({ error }) {
  if (!error) return null;
  return <div className="alert alert--error" role="alert">{formatError(error)}</div>;
}

// "service_id" -> "Service id"
const humanizeField = (field) => {
  const text = field.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function formatError(error) {
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
