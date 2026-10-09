import '../../styles/index.css';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import AuthCard from './AuthCard';
import { ErrorAlert } from '../../components/ui';
import useCooldown, { formatCountdown } from '../../hooks/useCooldown';

// Short pause after every send, so the button can't be hammered.
const SEND_COOLDOWN_SECONDS = 60;
// If the server throttles us but doesn't say for how long, assume the full hour.
const FALLBACK_THROTTLE_SECONDS = 3600;

export default function PasswordResetRequest() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // calm "please wait" message (not a red error)
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const { remaining, start } = useCooldown('pw-reset-request-until');

  const send = async () => {
    if (submitting || remaining > 0) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await accountsApi.requestPasswordReset(email);
      setSent(true); // backend always returns the same generic response either way
      start(SEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err.status === 429) {
        start(err.body?.retry_after ?? FALLBACK_THROTTLE_SECONDS);
        setNotice(err.body?.detail || 'Please wait a little while before asking for another link.');
      } else {
        setError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    send();
  };

  const buttonLabel = (idle) => {
    if (submitting) return 'Sending…';
    if (remaining > 0) return `Send again in ${formatCountdown(remaining)}`;
    return idle;
  };

  if (sent) {
    return (
      <AuthCard>
        <h1>Check your email</h1>
        <p>If an account exists for <span className="break">{email}</span>, we've sent password reset instructions.</p>
        <p className="muted">Open the link in the newest email. It works for 1 hour.</p>
        {notice && <p className="muted" role="status">{notice}</p>}
        <button className="btn btn--ghost btn--block" type="button" onClick={send}
          disabled={submitting || remaining > 0}>
          {buttonLabel('Send the link again')}
        </button>
        <p className="auth-footer-note"><Link to="/login">Back to log in</Link></p>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Reset your password</h1>
      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />
        {notice && <p className="muted" role="status">{notice}</p>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" className="input" required autoComplete="email" inputMode="email"
            autoCapitalize="none" spellCheck={false}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn btn--primary btn--block" disabled={submitting || remaining > 0} type="submit">
          {buttonLabel('Send reset link')}
        </button>
      </form>
      <p className="auth-footer-note"><Link to="/login">Back to log in</Link></p>
    </AuthCard>
  );
}
