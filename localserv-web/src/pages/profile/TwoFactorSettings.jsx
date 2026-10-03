import '../../styles/index.css';
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';

export default function TwoFactorSettings() {
  const { user, refreshSession } = useAuth();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [setupData, setSetupData] = useState(null); // { secret, provisioning_uri } once setup has started
  const [confirmCode, setConfirmCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [message, setMessage] = useState('');

  const handleStartSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await accountsApi.setup2fa();
      setSetupData(data);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accountsApi.confirm2fa(confirmCode);
      setSetupData(null);
      setConfirmCode('');
      setMessage('Two-factor authentication is now enabled.');
      await refreshSession();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accountsApi.disable2fa(disablePassword);
      setDisablePassword('');
      setMessage('Two-factor authentication has been disabled.');
      await refreshSession();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div className="page page--narrow">
      <h1>Two-factor authentication</h1>
      <ErrorAlert error={error} />
      {message && <div className="alert alert--success">{message}</div>}

      {user.two_factor_enabled ? (
        <div className="stack">
          <p className="alert alert--success">Two-factor authentication is enabled on your account.</p>
          <form onSubmit={handleDisable} className="card stack">
            <h3>Disable it</h3>
            <p className="text-sm muted">Confirm your password to turn this off.</p>
            <div className="field">
              <label htmlFor="disable-password">Password</label>
              <input id="disable-password" type="password" className="input" required
                value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
            </div>
            <button className="btn btn--danger" disabled={busy} type="submit" style={{ alignSelf: 'start' }}>
              {busy ? 'Disabling…' : 'Disable two-factor authentication'}
            </button>
          </form>
        </div>
      ) : setupData ? (
        <div className="card stack">
          <h3>Scan this code</h3>
          <p className="text-sm">
            Scan this with your authenticator app (Google Authenticator, Authy, etc.), or enter
            the secret below manually if you can't scan.
          </p>
          <div className="qr-box">
            <QRCodeSVG value={setupData.provisioning_uri} size={200} />
          </div>
          <p className="text-sm m-0"><strong>Secret</strong></p>
          <code className="secret">{setupData.secret}</code>
          <form onSubmit={handleConfirm} className="stack-sm">
            <div className="field">
              <label htmlFor="confirm-code">Enter the 6-digit code to confirm</label>
              <input id="confirm-code" type="text" inputMode="numeric" autoComplete="one-time-code" className="input" required maxLength={10}
                value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} />
            </div>
            <div className="row row--wrap">
              <button className="btn btn--primary" disabled={busy} type="submit">
                {busy ? 'Confirming…' : 'Confirm and enable'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setSetupData(null)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            Two-factor authentication is not enabled. Adding it means logging in will require a
            code from an authenticator app in addition to your password.
          </p>
          <button className="btn btn--primary" disabled={busy} onClick={handleStartSetup} style={{ alignSelf: 'start' }}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        </div>
      )}
    </div>
  );
}