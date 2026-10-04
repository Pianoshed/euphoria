import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';

const MIN_LENGTH = 10; // matches min_length on the backend PasswordChangeSerializer

// Does this account have a password yet? Accounts created with Google start without one.
// true / false when the profile API says so, null when it doesn't (older API).
function passwordStatus(user) {
  if (typeof user?.has_usable_password === 'boolean') return user.has_usable_password;
  if (typeof user?.has_password === 'boolean') return user.has_password;
  return null;
}

/**
 * Set or change the account password, right in the profile's Security section.
 *  - Google-only account (no password yet): "Set a password", no current password asked.
 *  - Account with a password: "Change your password", current password required.
 *  - Can't tell: current password is optional, with a hint for Google sign-ups.
 */
export default function PasswordPanel() {
  const { user, refreshSession } = useAuth();
  const status = passwordStatus(user);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState('');

  if (!user) return null;

  const needsCurrent = status !== false;
  const title = status === false ? 'Set a password' : status === true ? 'Change your password' : 'Password';
  const lede = status === false
    ? `You signed in with Google, so this account has no password yet. Set one to also log in with ${user.email || 'your email'}.`
    : status === null
      ? 'Signed up with Google? Leave the current password empty to set your first one.'
      : 'Pick something you do not use anywhere else.';
  const type = show ? 'text' : 'password';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setDone('');
    if (next.length < MIN_LENGTH) {
      setError(new Error(`Use at least ${MIN_LENGTH} characters for the new password.`));
      return;
    }
    if (next !== confirm) {
      setError(new Error('The two new passwords do not match.'));
      return;
    }
    setBusy(true);
    try {
      await accountsApi.changePassword(current, next);
      await refreshSession(); // the account now has a password, so this panel switches to "Change"
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(status === true
        ? 'Password changed.'
        : `Password saved. You can now log in with ${user.email || 'your email'} and this password, or keep using Google.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form id="password" className="mp-pass" onSubmit={handleSubmit}>
      <h3 className="mp-h3">{title}</h3>
      <p className="mp-pass__lede">{lede}</p>

      <ErrorAlert error={error} />
      {done && <div className="alert alert--success" role="status">{done}</div>}

      {/* helps password managers file the new password under the right login */}
      <input type="text" name="username" autoComplete="username" value={user.email || user.username || ''} readOnly hidden />

      {needsCurrent && (
        <div className="field">
          <label htmlFor="pw-current">
            Current password{status === null ? ' (leave empty if you signed up with Google)' : ''}
          </label>
          <input id="pw-current" type={type} className="input" autoComplete="current-password"
            required={status === true} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" type={type} className="input" autoComplete="new-password" required
          minLength={MIN_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} />
        <small className="muted">At least {MIN_LENGTH} characters.</small>
      </div>
      <div className="field">
        <label htmlFor="pw-confirm">Type the new password again</label>
        <input id="pw-confirm" type={type} className="input" autoComplete="new-password" required
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>

      <label className="mp-pass__show">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
      </label>

      <div className="mp-pass__actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : status === false ? 'Set password' : status === true ? 'Change password' : 'Save password'}
        </button>
        {status !== false && (
          <Link to="/password-reset" className="mp-pass__forgot">Forgot your current password?</Link>
        )}
      </div>
    </form>
  );
}
