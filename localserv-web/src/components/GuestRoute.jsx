import '../styles/index.css';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthCard from '../pages/auth/AuthCard';
import { SessionLoading, Spinner } from './ui';

const REDIRECT_AFTER_MS = 2500;

/**
 * For pages that only make sense when signed out (login, register).
 *
 * Someone who is ALREADY signed in when they arrive sees a short "You're already logged in"
 * screen and is sent on to where they were headed (or /services), instead of the login form.
 *
 * "Already" is decided once, when the session check finishes. Someone who signs in on this
 * page is not "already logged in": their own login flow does the redirect, so they never
 * see this screen flash by.
 */
export function GuestRoute({ children }) {
  const { user, checkingSession, sessionUnreachable } = useAuth();
  const location = useLocation();
  const [already, setAlready] = useState(null); // null = not decided yet

  useEffect(() => {
    if (!checkingSession) setAlready((prev) => prev ?? Boolean(user));
  }, [checkingSession, user]);

  if (checkingSession || already === null) {
    return <SessionLoading unreachable={sessionUnreachable} />;
  }
  if (already && user) {
    const to = location.state?.from?.pathname || '/';
    return <AlreadyLoggedIn to={to} onLoggedOut={() => setAlready(false)} />;
  }
  return children;
}

function AlreadyLoggedIn({ to, onLoggedOut }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), REDIRECT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  if (leaving) return <Navigate to={to} replace />;

  const handleLogout = async () => {
    await logout();
    onLoggedOut(); // they chose to sign out, so show the form they came for
  };

  return (
    <AuthCard>
      <h1 style={{ textWrap: 'balance' }}>You&rsquo;re already logged in</h1>
      <p className="muted" role="status">Taking you back in a moment&hellip;</p>
      <div className="stack">
        {/* a button, not a link: the auth pages restyle anchors, which turned this label indigo on pink */}
        <button type="button" className="btn btn--primary btn--block" onClick={() => navigate(to, { replace: true })}>
          Continue now
        </button>
        <button type="button" className="btn btn--ghost btn--block" onClick={handleLogout}>
          Not you? Log out
        </button>
      </div>
    </AuthCard>
  );
}
