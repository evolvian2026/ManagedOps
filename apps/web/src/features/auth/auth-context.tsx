import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser, Capability } from '@managedops/shared';
import { api, errorMessage, onSessionExpired, resumeSession, setAccessToken } from '../../lib/api';

export interface SessionUser extends AuthUser {
  capabilities: Capability[];
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

interface AuthState {
  user: SessionUser | null;
  /** True only while the initial "am I already signed in?" check is running. */
  initialising: boolean;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  can: (capability: Capability) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [initialising, setInitialising] = useState(true);

  // On load there is no access token in memory, but the httpOnly refresh cookie
  // may still be valid — so try once to resume the session before showing the
  // sign-in page. Without this, every reload would look like a sign-out.
  //
  // resumeSession is single-flight and does not retry on 401, so this is exactly
  // one rotation even when React double-invokes the effect in development.
  useEffect(() => {
    let cancelled = false;

    void resumeSession().then((session) => {
      if (cancelled) return;
      if (session) {
        setUser(session.user as SessionUser);
      } else {
        // No usable cookie. This is the ordinary "not signed in" case.
        setAccessToken(null);
      }
      setInitialising(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onSessionExpired(() => setUser(null));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await api.post<LoginResponse>('/auth/login', { email, password });
    setAccessToken(session.accessToken);
    setUser(session.user);
    return session.user;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // Signing out locally must succeed even if the server call does not.
      console.warn('Sign-out request failed:', errorMessage(error));
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const session = await api.post<LoginResponse>('/auth/change-password', {
      currentPassword,
      newPassword,
    });
    setAccessToken(session.accessToken);
    setUser(session.user);
  }, []);

  const can = useCallback(
    (capability: Capability) => user?.capabilities.includes(capability) ?? false,
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({ user, initialising, signIn, signOut, changePassword, can }),
    [user, initialising, signIn, signOut, changePassword, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
