import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { authClient as defaultAuthClient, type AuthClient, type AuthUser } from './authClient';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unconfigured' | 'error';

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  client: AuthClient | null;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  client = defaultAuthClient,
}: PropsWithChildren<{ client?: AuthClient | null }>) {
  const [status, setStatus] = useState<AuthStatus>(client ? 'loading' : 'unconfigured');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setStatus('unconfigured');
      setUser(null);
      return;
    }

    let active = true;
    const unsubscribe = client.subscribe((nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setStatus(nextUser ? 'authenticated' : 'anonymous');
      setError(null);
    });

    void client
      .getCurrentUser()
      .then((nextUser) => {
        if (!active) return;
        setUser(nextUser);
        setStatus(nextUser ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        if (!active) return;
        setError('无法确认当前登录状态，请检查网络后重试。');
        setStatus('error');
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const signOut = useCallback(async () => {
    if (!client) return;
    await client.signOut();
    setUser(null);
    setStatus('anonymous');
  }, [client]);

  const value = useMemo(
    () => ({ status, user, error, client, signOut }),
    [client, error, signOut, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用。');
  return value;
}
