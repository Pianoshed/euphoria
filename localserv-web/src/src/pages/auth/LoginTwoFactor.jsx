import '../../styles/index.css';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import AuthCard from './AuthCard';
import { ErrorAlert } from '../../components/ui';

export default function LoginTwoFactor() {
  const { completeMfaLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const challenge = location.state?.challenge;
  const redirectTo = location.state?.redirectTo || '/';
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (!challenge) {
    // Landed here directly without going through Login first.
    return <Navigate to="/login" replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await completeMfaLogin(challenge, code);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard>
      <h1>Enter your authentication code</h1>
      <p className="muted">Open your authenticator app and enter the current 6-digit code.</p>
      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />
        <div className="field">
          <label htmlFor="code">Authentication code</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code"
            autoCapitalize="none" spellCheck={false} autoFocus className="input"
            required maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <button className="btn btn--primary btn--block" disabled={submitting} type="submit">
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </AuthCard>
  );
}
