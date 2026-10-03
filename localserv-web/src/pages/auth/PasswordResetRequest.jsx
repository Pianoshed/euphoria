import '../../styles/index.css';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import AuthCard from './AuthCard';
import { ErrorAlert } from '../../components/ui';

export default function PasswordResetRequest() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await accountsApi.requestPasswordReset(email);
      setSent(true); // backend always returns the same generic response either way
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthCard>
        <h1>Check your email</h1>
        <p>If an account exists for <span className="break">{email}</span>, we've sent password reset instructions.</p>
        <p className="auth-footer-note"><Link to="/login">Back to log in</Link></p>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Reset your password</h1>
      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" className="input" required autoComplete="email" inputMode="email"
            autoCapitalize="none" spellCheck={false}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn btn--primary btn--block" disabled={submitting} type="submit">
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p className="auth-footer-note"><Link to="/login">Back to log in</Link></p>
    </AuthCard>
  );
}
