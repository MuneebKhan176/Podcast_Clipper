import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/authApi.js';
import { ApiError, setUnauthorizedHandler } from '../api/httpClient.js';

const AuthContext = createContext(null);

/**
 * status: 'loading'         - asking the server who we are (GET /api/auth/me)
 *         'authenticated'   - server confirmed a valid session; `user` is set
 *         'unauthenticated' - server said 401 (no/expired/invalid cookie)
 *         'error'           - could not reach the server / unexpected failure
 *
 * The user is NEVER read from localStorage or assumed from memory: the server is the source of truth,
 * so every page load starts with a /me check.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');

  const refresh = useCallback(async (signal) => {
    try {
      const me = await authApi.getMe(signal);
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setUser(null);
      setStatus(err instanceof ApiError && err.status === 401 ? 'unauthenticated' : 'error');
    }
  }, []);

  // Restore the session on first load.
  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // If any protected API call later returns 401 (e.g. the session expired), drop to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const retry = useCallback(() => {
    setStatus('loading');
    refresh();
  }, [refresh]);

  const login = useCallback(async (credentials) => {
    const loggedIn = await authApi.login(credentials);
    setUser(loggedIn);
    setStatus('authenticated');
    return loggedIn;
  }, []);

  const verifyEmail = useCallback(async (payload) => {
    const verified = await authApi.verifyEmail(payload);
    setUser(verified);
    setStatus('authenticated');
    return verified;
  }, []);

  // Only clears local state once the server confirmed, so a failed logout never shows a false "signed out".
  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo(
    () => ({ user, status, isAuthenticated: status === 'authenticated', login, verifyEmail, logout, retry }),
    [user, status, login, verifyEmail, logout, retry]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
