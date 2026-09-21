import { useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';

import { AuthPage } from './features/auth/AuthPage';
import { useAuth } from './features/auth/AuthContext';
import { PrivacyPage } from './features/auth/PrivacyPage';
import { RequireAuth } from './features/auth/RequireAuth';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { PatternLibraryPage } from './features/pattern-library/PatternLibraryPage';
import { RecommendationsPage } from './features/pattern-library/RecommendationsPage';
import { PatternScanPage } from './features/pattern-scan/PatternScanPage';

const navigation = [
  { to: '/scan', label: '扫描图纸' },
  { to: '/patterns', label: '图纸库' },
  { to: '/inventory', label: '豆仓' },
  { to: '/plans', label: '下一张' },
] as const;

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section className="page-card">
      <p className="eyebrow">BeadFlow</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

function AuthenticatedShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  const signOut = async () => {
    setSignOutPending(true);
    setSignOutError('');
    try {
      await auth.signOut();
      navigate('/login', { replace: true });
    } catch {
      setSignOutError('退出没有完成，请检查网络后重试。');
    } finally {
      setSignOutPending(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink className="brand" to="/patterns" aria-label="BeadFlow 图纸库">
          <span className="brand-mark" aria-hidden="true">
            豆
          </span>
          <span>
            <strong>BeadFlow</strong>
            <small>图纸对豆仓</small>
          </span>
        </NavLink>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
          <button
            className="sign-out-button"
            type="button"
            disabled={signOutPending}
            onClick={() => void signOut()}
          >
            {signOutPending ? '正在退出…' : '退出'}
          </button>
        </nav>
      </header>

      <main>
        {signOutError ? (
          <p className="form-alert shell-alert" role="alert">
            {signOutError}
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<AuthPage mode="forgot-password" />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AuthenticatedShell />}>
          <Route path="/" element={<Navigate to="/scan" replace />} />
          <Route path="/dashboard" element={<Navigate to="/scan" replace />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/patterns" element={<PatternLibraryPage />} />
          <Route path="/scan" element={<PatternScanPage />} />
          <Route path="/plans" element={<RecommendationsPage />} />
          <Route
            path="*"
            element={
              <PlaceholderPage
                title="找不到这一页"
                description="从上面的导航回到扫描、图纸库、豆仓或下一张。"
              />
            }
          />
        </Route>
      </Route>
    </Routes>
  );
}
