import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { bootstrapCsrf, ApiError } from '../api/client';
import * as accountsApi from '../api/accounts';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const profile = await accountsApi.getMyProfile();
      setUser(profile);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setUser(null);
      } else {
        throw err;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await bootstrapCsrf();
      try {
        await refreshSession();
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshSession]);

  const login = useCallback(async (email, password) => {
    const result = await accountsApi.login(email, password);
    if (!result.mfa_required) await refreshSession(); // normalize to the richer profile shape, not login's UserPublicSerializer shape
    return result; // caller checks mfa_required to decide whether to show the 2FA step
  }, [refreshSession]);

  const loginWithGoogle = useCallback(async (idToken) => {
    const result = await accountsApi.googleLogin(idToken);
    await refreshSession();
    return result;
  }, [refreshSession]);
  const completeMfaLogin = useCallback(async (challenge, code) => {
    await accountsApi.verifyLoginMfa(challenge, code);
    await refreshSession();
  }, [refreshSession]);

  const logout = useCallback(async () => {
    await accountsApi.logout();
    setUser(null);
  }, []);

  const value = { user, setUser, checkingSession, refreshSession, login, loginWithGoogle, completeMfaLogin, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}