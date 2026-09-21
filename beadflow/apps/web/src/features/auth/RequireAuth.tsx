import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from './AuthContext';

export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'loading') {
    return (
      <main className="auth-status" aria-live="polite">
        <div className="status-dot" aria-hidden="true" />
        正在确认登录状态……
      </main>
    );
  }

  if (auth.status === 'authenticated') return <Outlet />;

  return <Navigate to="/login" replace state={{ from: location }} />;
}
