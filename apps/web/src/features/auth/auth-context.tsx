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

/**
 * What a privileged sign-in gets instead of a session: the right to present a
 * second factor, and nothing else.
 */
export interface MfaChallenge {
  mfa: 'verification' | 'enrolment';
  challengeToken: string;
  expiresIn: number;
}

export type SignInResult = { user: SessionUser } | MfaChallenge;

export function isMfaChallenge(result: SignInResult): result is MfaChallenge {
  return 'mfa' in result;
}

interface AuthState {
  user: SessionUser | null;
  /** True only while the initial "am I already signed in?" check is running. */
  initialising: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  completeMfa: (challengeToken: string, code: string) => Promise<SessionUser>;
  completeMfaEnrolment: (challengeToken: string, code: string) => Promise<string[]>;
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

  const adopt = useCallback((session: LoginResponse) => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    return session.user;
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      const result = await api.post<LoginResponse | MfaChallenge>('/auth/login', {
        email,
        password,
      });
      // A challenge is not a session, so no token is adopted here — the page
      // asks for a code and comes back through `completeMfa`.
      if ('mfa' in result) return result;
      return { user: adopt(result) };
    },
    [adopt],
  );

  /** Finishes a sign-in with a code from an authenticator, or a recovery code. */
  const completeMfa = useCallback(
    async (challengeToken: string, code: string) => {
      const session = await api.post<LoginResponse>('/auth/mfa/verify', { challengeToken, code });
      return adopt(session);
    },
    [adopt],
  );

  /** Finishes the first-time setup, which both turns it on and signs them in. */
  const completeMfaEnrolment = useCallback(
    async (challengeToken: string, code: string) => {
      const session = await api.post<LoginResponse & { recoveryCodes: string[] }>(
        '/auth/login/mfa/activate',
        { challengeToken, code },
      );
      adopt(session);
      return session.recoveryCodes;
    },
    [adopt],
  );

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
    () => ({
      user,
      initialising,
      signIn,
      completeMfa,
      completeMfaEnrolment,
      signOut,
      changePassword,
      can,
    }),
    [user, initialising, signIn, completeMfa, completeMfaEnrolment, signOut, changePassword, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
