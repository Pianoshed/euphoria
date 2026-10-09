import '../../styles/index.css';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';
import AuthCard from './AuthCard';
import AuthShowcase from './AuthShowcase';
import GoogleButton from './GoogleButton';
import GoogleSignupStep from './GoogleSignupStep';
import RoleChoice from './RoleChoice';
import ResendVerification from '../../components/ResendVerification';
import PasswordInput from '../../components/PasswordInput';
import DemographicsFields, { EMPTY_DEMOGRAPHICS } from '../../components/DemographicsFields';
import LegalFootnote from '../../components/LegalFootnote';
import { demographicsPayload } from '../../utils/ageGroups';

export default function Register() {
  const { loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Set when a Google email has no account yet (arrives from Login, or from the button below).
  const [google, setGoogle] = useState(location.state?.google ?? null);
  const [form, setForm] = useState({ email: '', username: '', password: '', confirm: '', role: 'CUSTOMER' });
  const [demo, setDemo] = useState(EMPTY_DEMOGRAPHICS);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError({ message: 'The two passwords do not match.' });
      return;
    }
    setSubmitting(true);
    try {
      await accountsApi.register(form.email, form.username, form.password, form.role, demographicsPayload(demo));
      setDone(true);
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
      const credential = credentialResponse.credential;
      const result = await loginWithGoogle(credential);
      if (result.needs_signup) {
        // New email: show the finish-signup step (nothing has been created yet).
        setGoogle({
          token: credential,
          email: result.email,
          name: result.name,
          suggestedUsername: result.suggested_username,
        });
        return;
      }
      if (result.session_conflict) {
        // Existing account, already signed in on another device: the Login page asks what to do.
        navigate('/login', { replace: true, state: { conflict: { challenge: result.challenge, devices: result.devices } } });
        return;
      }
      // This Google email already had an account, so they're now logged in.
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setGoogleSubmitting(false);
    }
  };

  if (done) {
    return (
      <AuthCard>
        <h1>Check your email</h1>
        <p className="auth-sub">
          We've sent a verification link to <strong className="break">{form.email}</strong>. Follow it to
          activate your account, then <Link to="/login">log in</Link> and start planning your
          next hangout.
        </p>
        <p className="text-sm muted">Didn&rsquo;t get it? It can take a minute.</p>
        <ResendVerification email={form.email} />
      </AuthCard>
    );
  }

  return (
    <div className="auth-shell">
      <AuthShowcase
        variant="couples"
        title="Find your people, find your plans"
        text="Join to discover meetups happening nearby, or start hosting your own — board games, hikes, dinners, whatever your thing is."
        event={{ title: 'Trivia night', meta: 'Fri, 8pm · 6 spots left' }}
        quote={{ name: 'Damola O.', text: 'Count me in for Saturday!' }}
      />

      <div className="auth-panel">
        <div className="auth-form-wrap">
          {google ? (
            <GoogleSignupStep google={google} onCancel={() => setGoogle(null)} />
          ) : (
          <>
          <h1>Create your account</h1>
          <p className="auth-sub">Sign up to start meeting up.</p>

          <GoogleButton
            busy={googleSubmitting}
            text="signup_with"
            onSuccess={handleGoogleSuccess}
            onError={() => setError({ message: 'Google sign-up failed. Please try again.' })}
          />

          <div className="auth-divider">or</div>

          <form onSubmit={handleSubmit} className="stack">
            <ErrorAlert error={error} />

            <RoleChoice value={form.role} onChange={(role) => setForm((f) => ({ ...f, role }))} />

            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" className="input" required autoComplete="email" inputMode="email"
                autoCapitalize="none" spellCheck={false}
                value={form.email} onChange={update('email')} />
            </div>
            <div className="field">
              <label htmlFor="username">Username</label>
              <input id="username" type="text" className="input" required minLength={3} maxLength={30}
                autoComplete="username" autoCapitalize="none" spellCheck={false}
                value={form.username} onChange={update('username')} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <PasswordInput id="password" className="input" required minLength={10}
                autoComplete="new-password"
                value={form.password} onChange={update('password')} />
              <span className="hint">At least 10 characters.</span>
            </div>
            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <PasswordInput id="confirm" className="input" required minLength={10}
                autoComplete="new-password"
                value={form.confirm} onChange={update('confirm')} />
              {form.confirm && form.confirm !== form.password && (
                <span className="hint" role="status" style={{ color: '#b91c1c' }}>The passwords do not match yet.</span>
              )}
            </div>
            <DemographicsFields value={demo} onChange={setDemo} idPrefix="reg" />
            <button className="btn-primary-full" disabled={submitting} type="submit">
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
            <LegalFootnote variant="signup" />
          </form>

          <p className="auth-footer-note">
            Already have an account? <Link to="/login">Log in</Link>
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}