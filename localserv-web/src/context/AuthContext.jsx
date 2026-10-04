/**
 * AuthContext for Django session auth (cookie + CSRF, handled by apiFetch).
 * No tokens to store: after login the server sets the session cookie, and we just
 * ask "who am I?" (getMyProfile) and keep the answer in React state.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  login as apiLogin,
  verifyLoginMfa,
  googleLogin,
  googleRegister,
  logout as apiLogout,
  getMyProfile,
} from '../api/accounts';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // 401/403 simply means "not signed in", so it resolves to null instead of throwing.
  const refreshSession = useCallback(async () => {
    try {
      const me = await getMyProfile();
      const next = me?.user ?? me ?? null;
      setUser(next);
      return next;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshSession().finally(() => { if (!cancelled) setCheckingSession(false); });
    return () => { cancelled = true; };
  }, [refreshSession]);

  const finishLogin = useCallback(async (data) => {
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
    async (credential, username, role) => finishLogin(await googleRegister(credential, username, role)),
    [finishLogin],
  );

  const completeMfaLogin = useCallback(
    async (challenge, code) => finishLogin(await verifyLoginMfa(challenge, code)),
    [finishLogin],
  );

  const logout = useCallback(async () => {
    try { await apiLogout(); } catch { /* already signed out on the server */ }
    setUser(null);
  }, []);

  const value = useMemo(() => ({
    user, checkingSession, login, loginWithGoogle, registerWithGoogle,
    completeMfaLogin, logout, refreshSession,
  }), [user, checkingSession, login, loginWithGoogle, registerWithGoogle,
    completeMfaLogin, logout, refreshSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}