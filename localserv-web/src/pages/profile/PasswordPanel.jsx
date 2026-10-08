import { useEffect, useState } from 'react';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';

const RESEND_COOLDOWN_SECONDS = 60;

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
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!user) return null;

  const has = hasPassword(user);
  const target = maskEmail(user.email);

  const handleSend = async () => {
    setError(null);
    setBusy(true);
    try {
      await accountsApi.requestOwnPasswordReset();
      setSent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="password" className="mp-pass">
      <h3 className="mp-h3">{has ? 'Change your password' : 'Set a password'}</h3>
      <p className="mp-pass__lede">
        {has
          ? `We will email a secure link to ${target}. Open it to choose a new password.`
          : `You signed in with Google, so this account has no password yet. We will email a link to ${target} so you can also log in with your email.`}
      </p>

      <ErrorAlert error={error} />
      {sent && (
        <div className="alert alert--success" role="status">
          Link sent to {target}. It expires in 1 hour. Once you set the new password you will be signed
          out on every device and asked to log in again.
        </div>
      )}

      <div className="mp-pass__actions">
        <button className="btn btn--primary" type="button" onClick={handleSend} disabled={busy || cooldown > 0}>
          {busy ? 'Sending…' : cooldown > 0 ? `Send again in ${cooldown}s` : sent ? 'Send the link again' : 'Email me a reset link'}
        </button>
      </div>
    </div>
  );
}
