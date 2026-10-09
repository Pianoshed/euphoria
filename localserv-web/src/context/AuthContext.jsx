/**
 * AuthContext for Django session auth (cookie + CSRF, handled by apiFetch).
 * No tokens to store: after login the server sets the session cookie, and we just
 * ask "who am I?" (getMyProfile) and keep the answer in React state.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  login as apiLogin,
  verifyLoginMfa,
  googleLogin,
  googleRegister,
  logout as apiLogout,
  getMyProfile,
} from '../api/accounts';
import { AUTH_EXPIRED_EVENT, isTransientError } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionUnreachable, setSessionUnreachable] = useState(false); // server/network hiccup during the session check
  const userRef = useRef(null);
  useEffect(() => { userRef.current = user; }, [user]);

  // The server stopped recognising our session (idle timeout, closed browser, blocked cookie).
  // Drop the user so ProtectedRoute sends them to /login instead of leaving a half-working app.
  useEffect(() => {
    const onExpired = () => {
      if (!userRef.current) return; // already signed out: nothing to expire
      setSessionExpired(true);
      setUser(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  // 401/403 simply means "not signed in", so it resolves to null instead of throwing.
  // A network failure or a 5xx is NOT "signed out": keep whoever is signed in and say we couldn't tell.
  const refreshSession = useCallback(async () => {
    try {
      const me = await getMyProfile();
      const next = me?.user ?? me ?? null;
      setUser(next);
      setSessionUnreachable(false);
      return next;
    } catch (err) {
      if (isTransientError(err)) {
        setSessionUnreachable(true);
        return userRef.current;
      }
      setUser(null);
      return null;
    }
  }, []);

  // First check on page load. If the server or network is struggling we do NOT bounce the person to the
  // login page: we keep the calm loading screen up and quietly try again until we get a real answer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const me = await getMyProfile();
          if (cancelled) return;
          setUser(me?.user ?? me ?? null);
        } catch (err) {
          if (cancelled) return;
          if (isTransientError(err)) {
            setSessionUnreachable(true);
            await new Promise((resolve) => setTimeout(resolve, Math.min(4000 + attempt * 2000, 12000)));
            continue;
          }
          setUser(null); // 401/403: genuinely signed out
        }
        setSessionUnreachable(false);
        setCheckingSession(false);
        return;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const finishLogin = useCallback(async (data) => {
    setSessionExpired(false);
    if (data?.user) setUser(data.user);
    else await refreshSession();
    return data;
  }, [refreshSession]);

  // Returns the raw response so Login.jsx can read { mfa_required, challenge }.
  const login = useCallback(async (email, password) => {
    const data = await apiLogin(email, password);
    if (data?.mfa_required) return data;
    return finishLogin(data);
  }, [finishLogin]);

  // Returns the raw response. For an unregistered email the server answers
  // { needs_signup: true, email, name, suggested_username } and logs NOBODY in,
  // so we must not touch the user state in that case.
  const loginWithGoogle = useCallback(async (credential) => {
    const data = await googleLogin(credential);
    if (data?.needs_signup) return data;
    return finishLogin(data);
  }, [finishLogin]);

  // Step 2 of Google signup: creates the account and logs the person in.
  const registerWithGoogle = useCallback(
    async (credential, username, password, role, demographics) =>
      finishLogin(await googleRegister(credential, username, password, role, demographics)),
    [finishLogin],
  );

  const completeMfaLogin = useCallback(
    async (challenge, code) => finishLogin(await verifyLoginMfa(challenge, code)),
    [finishLogin],
  );

  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* already signed out on the server */ }
    setUser(null);
    setSessionExpired(false);
  }, []);

  const value = useMemo(() => ({
    user, checkingSession, sessionExpired, sessionUnreachable, login, loginWithGoogle, registerWithGoogle,
    completeMfaLogin, logout, refreshSession,
  }), [user, checkingSession, sessionExpired, sessionUnreachable, login, loginWithGoogle, registerWithGoogle,
    completeMfaLogin, logout, refreshSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}