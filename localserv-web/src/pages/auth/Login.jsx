import '../../styles/index.css';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';
import AuthShowcase from './AuthShowcase';
import GoogleButton from './GoogleButton';

export default function Login() {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const redirectTo = location.state?.from?.pathname || '/services';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(form.email, form.password);
      if (result.mfa_required) {
        navigate('/login/2fa', { state: { challenge: result.challenge, redirectTo } });
      } else {
        navigate(redirectTo, { replace: true });
      }
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse) => {
    setError(null);
    setGoogleSubmitting(true);
    try {
      await loginWithGoogle(credentialResponse.credential);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <AuthShowcase
        variant="cafe"
        title="Your next hangout is one message away"
        text="Sign back in to keep chatting, book activities, and see what's happening near you this week."
        event={{ title: 'Board game night', meta: 'Tonight, 7pm · 4 spots left' }}
        quote={{ name: 'Amara N.', text: 'See you at the usual spot!' }}
      />

      <div className="auth-panel">
        <div className="auth-form-wrap">
          <h1>Log in</h1>
          <p className="auth-sub">Sign in to keep the plans going.</p>

          <ErrorAlert error={error} />

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required autoComplete="email" inputMode="email"
                autoCapitalize="none" spellCheck={false}
                value={form.email} onChange={update('email')} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" required autoComplete="current-password"
                value={form.password} onChange={update('password')} />
            </div>
            <button className="btn-primary-full" disabled={submitting} type="submit">
              {submitting ? 'Logging in…' : 'Log in'}
            </button>
          </form>

          <div className="auth-divider">or</div>

          <GoogleButton
            busy={googleSubmitting}
            text="signin_with"
            onSuccess={handleGoogleSuccess}
            onError={() => setError({ message: 'Google login failed. Please try again.' })}
          />

          <p className="auth-footer-note">
            <Link to="/password-reset">Forgot your password?</Link>
          </p>
          <p className="auth-footer-note" style={{ marginTop: '0.4rem' }}>
            New here? <Link to="/register">Create an account</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
