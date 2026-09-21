import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { authConfigurationError, type AuthClient } from './authClient';
import { useAuth } from './AuthContext';

export type AuthMode = 'login' | 'register' | 'forgot-password';

type LocationState = {
  from?: {
    pathname?: string;
  };
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('invalid login credentials')) return '邮箱或密码不正确。';
  if (message.includes('email not confirmed')) return '请先完成邮箱确认。';
  if (message.includes('already registered')) return '这个邮箱已经注册，请直接登录。';
  if (
    message.includes('rate limit') ||
    message.includes('security purposes') ||
    message.includes('after 60 seconds')
  ) {
    return '请求过于频繁。默认邮件服务每小时最多发送 2 封，请检查是否已收到邮件；如未收到，需等待额度恢复后再试。';
  }
  if (message.includes('fetch') || message.includes('network')) {
    return '网络连接失败，请稍后重试。';
  }
  return '操作没有完成，请检查输入后重试。';
}

const modeCopy = {
  login: {
    title: '登录',
    lead: '图纸和豆仓跟着账号走，换电脑也能接着盘。',
    submit: '登录',
  },
  register: {
    title: '建一个豆仓',
    lead: '先有个账号，再把截图图纸和手头豆子记进来。',
    submit: '注册',
  },
  'forgot-password': {
    title: '找回密码',
    lead: '我们会发一封重置邮件。如果这个邮箱没注册过，你也不会收到。',
    submit: '发送重置邮件',
  },
} as const;

export function AuthPage({ mode, client }: { mode: AuthMode; client?: AuthClient | null }) {
  const auth = useAuth();
  const activeClient = client === undefined ? auth.client : client;
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const copy = modeCopy[mode];

  if (auth.status === 'authenticated') return <Navigate to="/patterns" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeClient) {
      setError(authConfigurationError ?? 'Supabase 认证尚未配置。');
      return;
    }

    setPending(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'login') {
        await activeClient.signIn(email.trim(), password);
        const state = location.state as LocationState | null;
        const destination = state?.from?.pathname?.startsWith('/') ? state.from.pathname : '/scan';
        navigate(destination, { replace: true });
      } else if (mode === 'register') {
        const result = await activeClient.signUp(email.trim(), password);
        if (result === 'authenticated') {
          navigate('/scan', { replace: true });
        } else {
          setMessage(
            '账号已经建好。确认信由免费发信通道送出，每小时最多 2 封，163 / QQ 也经常进不了收件箱。请先看垃圾箱；如果没有，打开 Supabase 后台 Authentication → Users，把这个邮箱标成已确认后再登录。',
          );
        }
      } else {
        await activeClient.sendPasswordReset(email.trim());
        setMessage('如果这个邮箱已经注册，重置邮件会发到你的收件箱。');
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-labelledby="auth-product-title">
        <Link className="auth-brand" to="/login">
          <span className="brand-mark" aria-hidden="true">
            豆
          </span>
          <span>
            <strong id="auth-product-title">BeadFlow</strong>
            <small>图纸对豆仓，再动手</small>
          </span>
        </Link>
        <div>
          <h1>动手前，先看这包豆够不够。</h1>
          <p>
            手机里存了一堆图纸、盒子里囤了一堆色：先把图画进来，对着真实 MARD
            色号点一遍缺哪些，再决定今晚拼哪张。
          </p>
          <ol className="auth-steps">
            <li>
              <strong>收图</strong>
              上传完整图纸，找出格子和颜色团
            </li>
            <li>
              <strong>对色</strong>
              色号由你对照图例确认，不靠屏幕颜色瞎猜
            </li>
            <li>
              <strong>盘豆</strong>
              对照手头库存，缺的列进补豆清单
            </li>
          </ol>
        </div>
      </section>

      <section className="auth-card" aria-labelledby="auth-heading">
        <h2 id="auth-heading">{copy.title}</h2>
        <p className="auth-card-lead">{copy.lead}</p>

        {auth.status === 'unconfigured' ? (
          <p className="form-alert" role="alert">
            本地还没接上账号服务，现在登录进不去，也不会假装已经登入。
          </p>
        ) : null}
        {auth.status === 'error' ? (
          <p className="form-alert" role="alert">
            {auth.error}
          </p>
        ) : null}
        {error ? (
          <p className="form-alert" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="form-success" role="status">
            {message}
          </p>
        ) : null}

        <form onSubmit={(event) => void submit(event)}>
          <label>
            邮箱
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {mode !== 'forgot-password' ? (
            <label>
              密码
              <input
                type="password"
                name="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                minLength={6}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === 'register' ? <small>至少 6 位，别跟别的网站共用同一个密码。</small> : null}
            </label>
          ) : null}

          <button className="primary-action" type="submit" disabled={pending}>
            {pending ? '处理中……' : copy.submit}
          </button>
        </form>

        <div className="auth-links">
          {mode === 'login' ? (
            <>
              <Link to="/register">还没有账号？去注册</Link>
              <Link to="/forgot-password">忘记密码</Link>
            </>
          ) : (
            <Link to="/login">返回登录</Link>
          )}
          <Link to="/privacy">隐私说明</Link>
        </div>
      </section>
    </main>
  );
}
