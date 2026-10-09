import '../../styles/index.css';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';
import AuthShowcase from './AuthShowcase';
import GoogleButton from './GoogleButton';
import ResendVerification from '../../components/ResendVerification';
import PasswordInput from '../../components/PasswordInput';
import DeviceConflict from './DeviceConflict';

export default function Login() {
  const { login, loginWithGoogle, confirmDeviceTakeover } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(location.state?.expired ? 'Your session ended. Please log in again.' : null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  // Set when the account is already signed in on another device: { challenge, devices }.
  const [conflict, setConflict] = useState(location.state?.conflict ?? null);
  const [takingOver, setTakingOver] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const redirectTo = location.state?.from?.pathname || '/';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const result = await login(form.email, form.password);
      if (result.mfa_required) {
        navigate('/login/2fa', { state: { challenge: result.challenge, redirectTo } });
      } else if (result.session_conflict) {
        setConflict({ challenge: result.challenge, devices: result.devices });
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
    setNotice(null);
    setGoogleSubmitting(true);
    try {
      const credential = credentialResponse.credential;
      const result = await loginWithGoogle(credential);

      if (result.needs_signup) {
        // Unregistered email: nobody was logged in or created. Tell the person,
        // then send them to the register page with the Google details.
        setNotice(`No account found for ${result.email}. Taking you to create one…`);
        setTimeout(() => {
          navigate('/register', {
            state: {
              google: {
                token: credential,
                email: result.email,
                name: result.name,
                suggestedUsername: result.suggested_username,
              },
            },
          });
        }, 900);
        return;
      }

      if (result.session_conflict) {
        setConflict({ challenge: result.challenge, devices: result.devices });
        return;
      }

      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const handleTakeover = async () => {
    setError(null);
    setTakingOver(true);
    try {
      await confirmDeviceTakeover(conflict.challenge);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
      setTakingOver(false);
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
          {conflict ? (
            <DeviceConflict devices={conflict.devices} busy={takingOver} error={error}
              onConfirm={handleTakeover} onCancel={() => { setConflict(null); setError(null); }} />
          ) : (
          <>
          <h1>Log in</h1>
          <p className="auth-sub">Sign in to keep the plans going.</p>

          <ErrorAlert error={error} />
          {/^please verify your email/i.test(error?.body?.detail || '') && (
            <ResendVerification email={form.email} />
          )}
          {notice && (
            <p role="status" className="auth-sub" style={{ color: '#1d4ed8', fontWeight: 500 }}>
              {notice}
            </p>
          )}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required autoComplete="email" inputMode="email"
                autoCapitalize="none" spellCheck={false}
                value={form.email} onChange={update('email')} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <PasswordInput id="password" required autoComplete="current-password"
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
          </>
          )}
        </div>
      </div>
    </div>
  );
}