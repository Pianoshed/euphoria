import '../../styles/index.css';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import AuthCard from './AuthCard';
import { ErrorAlert } from '../../components/ui';
import PasswordInput from '../../components/PasswordInput';

export default function PasswordResetConfirm() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError({ message: 'The two passwords do not match.' });
      return;
    }
    setSubmitting(true);
    try {
      await accountsApi.confirmPasswordReset(token, password);
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthCard>
        <h1>Reset your password</h1>
        <p className="muted">This link is missing its token. <Link to="/password-reset">Request a new one</Link>.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Choose a new password</h1>
      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />
        <div className="field">
          <label htmlFor="password">New password</label>
          <PasswordInput id="password" className="input" required minLength={10}
            autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="hint">At least 10 characters.</span>
        </div>
        <div className="field">
          <label htmlFor="confirm">Confirm new password</label>
          <PasswordInput id="confirm" className="input" required minLength={10}
            autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <button className="btn btn--primary btn--block" disabled={submitting} type="submit">
          {submitting ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthCard>
  );
}
