import { useState } from 'react';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';
import useCooldown, { formatCountdown } from '../../hooks/useCooldown';

// Short pause after every send, so the button can't be hammered.
const RESEND_COOLDOWN_SECONDS = 60;
// If the server throttles us but doesn't say for how long, assume the full hour.
const FALLBACK_THROTTLE_SECONDS = 3600;

// Does this account have a password yet? Accounts created with Google start without one.
function hasPassword(user) {
  if (typeof user?.has_usable_password === 'boolean') return user.has_usable_password;
  if (typeof user?.has_password === 'boolean') return user.has_password;
  return true;
}

// j***@gmail.com
function maskEmail(email) {
  const [name, domain] = (email || '').split('@');
  if (!name || !domain) return 'your email address';
  return `${name[0]}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

/**
 * Change or set the password by email. No "old password / new password" form: the link proves
 * the person controls the mailbox, then the reset page lets them choose the new password.
 * That also works when the old password is forgotten, and for Google-only accounts.
 */
export default function PasswordPanel() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // calm "please wait" message (not a red error)
  const [sent, setSent] = useState(false);
  const { remaining, start } = useCooldown('pw-reset-self-until');

  if (!user) return null;

  const has = hasPassword(user);
  const target = maskEmail(user.email);

  const handleSend = async () => {
    if (busy || remaining > 0) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await accountsApi.requestOwnPasswordReset();
      setSent(true);
      start(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err.status === 429) {
        start(err.body?.retry_after ?? FALLBACK_THROTTLE_SECONDS);
        setNotice(err.body?.detail || 'Please wait a little while before asking for another link.');
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const label = busy
    ? 'Sending…'
    : remaining > 0
      ? `Send again in ${formatCountdown(remaining)}`
      : sent
        ? 'Send the link again'
        : 'Email me a reset link';

  return (
    <div id="password" className="mp-pass">
      <h3 className="mp-h3">{has ? 'Change your password' : 'Set a password'}</h3>
      <p className="mp-pass__lede">
        {has
          ? `We will email a secure link to ${target}. Open it to choose a new password.`
          : `You signed in with Google, so this account has no password yet. We will email a link to ${target} so you can also log in with your email.`}
      </p>

      <ErrorAlert error={error} />
      {notice && <p className="muted" role="status">{notice}</p>}
      {sent && (
        <div className="alert alert--success" role="status">
          Link sent to {target}. It expires in 1 hour. Once you set the new password you will be signed
          out on every device and asked to log in again.
        </div>
      )}

      <div className="mp-pass__actions">
        <button className="btn btn--primary" type="button" onClick={handleSend} disabled={busy || remaining > 0}>
          {label}
        </button>
      </div>
    </div>
  );
}
