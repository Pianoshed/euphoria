import '../../styles/index.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert } from '../../components/ui';
import RoleChoice from './RoleChoice';
import PasswordInput from '../../components/PasswordInput';

/**
 * Step 2 of Google signup, shown when a Google email has no account yet.
 * Nothing exists on the server until this form is submitted.
 *
 * google = { token, email, name, suggestedUsername }
 * onCancel() clears the Google state so the person can pick another way to sign up.
 */
export default function GoogleSignupStep({ google, onCancel }) {
  const { registerWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState(google.suggestedUsername || '');
  const [role, setRole] = useState('CUSTOMER');
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
      await registerWithGoogle(google.token, username.trim(), password, role);
      navigate('/services', { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1>Finish creating your account</h1>
      <p className="auth-sub">
        <strong className="break">{google.email}</strong> isn't registered yet. Choose a username,
        create a password and say what you're here for, and you're in.
      </p>

      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />

        <RoleChoice value={role} onChange={setRole} />

        <div className="field">
          <label htmlFor="g-email">Email</label>
          <input id="g-email" type="email" className="input" value={google.email} readOnly />
        </div>
        <div className="field">
          <label htmlFor="g-username">Username</label>
          <input id="g-username" type="text" className="input" required minLength={3} maxLength={30}
            autoComplete="username" autoCapitalize="none" spellCheck={false}
            value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="g-password">Create a password</label>
          <PasswordInput id="g-password" className="input" required minLength={10}
            autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="g-confirm">Confirm password</label>
          <PasswordInput id="g-confirm" className="input" required minLength={10}
            autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        <button className="btn-primary-full" disabled={submitting} type="submit">
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="auth-footer-note">
        <button type="button" className="link-button" onClick={onCancel}
          style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
          Use a different account
        </button>
      </p>
    </>
  );
}
