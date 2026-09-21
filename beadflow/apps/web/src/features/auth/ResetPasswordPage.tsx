import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { authConfigurationError } from './authClient';
import { useAuth } from './AuthContext';

function passwordUpdateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('different from the old password') || message.includes('same password')) {
    return '新密码不能与原密码相同，请换一个全新的密码。';
  }
  if (message.includes('weak') || message.includes('password should be')) {
    return '新密码强度不足，请使用更长且不容易猜到的密码。';
  }
  if (message.includes('session') || message.includes('token') || message.includes('expired')) {
    return '重置链接已经失效，请重新申请密码重置邮件。';
  }
  if (message.includes('fetch') || message.includes('network')) {
    return '网络连接失败，密码尚未更新，请稍后再试。';
  }
  return '密码没有更新成功。请换一个全新的密码，或重新申请重置邮件。';
}

export function ResetPasswordPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!auth.client) {
      setError(authConfigurationError ?? 'Supabase 认证尚未配置。');
      return;
    }
    if (auth.status !== 'authenticated') {
      setError('重置链接无效或已经过期，请重新申请密码重置邮件。');
      return;
    }
    if (password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }

    setPending(true);
    try {
      await auth.client.updatePassword(password);
    } catch (updateError) {
      setError(passwordUpdateErrorMessage(updateError));
      setPending(false);
      return;
    }

    try {
      await auth.signOut();
      navigate('/login', { replace: true });
    } catch {
      setMessage('新密码已经保存，但自动退出失败。请手动退出登录后再使用新密码。');
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-labelledby="reset-product-title">
        <Link className="auth-brand" to="/login">
          <span className="brand-mark" aria-hidden="true">
            豆
          </span>
          <span>
            <strong id="reset-product-title">BeadFlow</strong>
            <small>改完密码再继续盘豆</small>
          </span>
        </Link>
        <div>
          <h1>换一个新密码</h1>
          <p>从重置邮件点进来之后，才能改这个账号的密码。</p>
        </div>
      </section>

      <section className="auth-card" aria-labelledby="reset-heading">
        <h2 id="reset-heading">设置新密码</h2>

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
            新密码
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small>至少 6 位，不要使用其他网站的密码。</small>
          </label>
          <label>
            再次输入新密码
            <input
              type="password"
              name="password-confirmation"
              autoComplete="new-password"
              minLength={6}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button className="primary-action" type="submit" disabled={pending}>
            {pending ? '处理中……' : '保存新密码'}
          </button>
        </form>

        <div className="auth-links">
          <Link to="/forgot-password">重新申请重置邮件</Link>
          <Link to="/privacy">隐私说明</Link>
        </div>
      </section>
    </main>
  );
}
