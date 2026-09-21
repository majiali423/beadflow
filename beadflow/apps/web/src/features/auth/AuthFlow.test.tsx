import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import { App } from '../../App';
import { FakeAuthClient } from '../../test/fakeAuthClient';
import { AuthProvider } from './AuthContext';

function renderApp(path: string, client: FakeAuthClient | null) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider client={client}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillCredentials(email = 'maker@example.com', password = 'safe-password') {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/密码/), { target: { value: password } });
}

describe('authenticated application shell', () => {
  test('preserves the requested protected route through a successful login', async () => {
    const client = new FakeAuthClient();
    renderApp('/inventory', client);

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '手头的豆' })).toBeInTheDocument();
    expect(client.signIn).toHaveBeenCalledWith('maker@example.com', 'safe-password');
  });

  test('lands a normal login directly in the active pattern-card library', async () => {
    const client = new FakeAuthClient();
    renderApp('/login', client);

    await screen.findByRole('heading', { name: '登录' });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(
      await screen.findByRole('heading', { name: '把图纸收进来' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).not.toHaveTextContent('缺料采购');
  });

  test('does not navigate or expose provider details after invalid credentials', async () => {
    const client = new FakeAuthClient();
    client.signInError = new Error('Invalid login credentials');
    renderApp('/dashboard', client);

    await screen.findByRole('heading', { name: '登录' });
    fillCredentials('wrong@example.com', 'wrong-password');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码不正确');
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  test('handles email-confirmation registration without pretending the user is signed in', async () => {
    const client = new FakeAuthClient();
    renderApp('/register', client);

    await screen.findByRole('heading', { name: '建一个豆仓' });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(await screen.findByRole('status')).toHaveTextContent('账号已经建好');
    expect(screen.getByRole('heading', { name: '建一个豆仓' })).toBeInTheDocument();
  });

  test('uses a non-enumerating reset message and trims the email', async () => {
    const client = new FakeAuthClient();
    renderApp('/forgot-password', client);

    await screen.findByRole('heading', { name: '找回密码' });
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: '  maker@example.com  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送重置邮件' }));

    expect(await screen.findByRole('status')).toHaveTextContent('如果这个邮箱已经注册');
    expect(client.sendPasswordReset).toHaveBeenCalledWith('maker@example.com');
  });

  test('explains the provider email cooldown without exposing provider details', async () => {
    const client = new FakeAuthClient();
    client.resetError = new Error(
      'For security purposes, you can only request this after 60 seconds.',
    );
    renderApp('/forgot-password', client);

    await screen.findByRole('heading', { name: '找回密码' });
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'maker@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送重置邮件' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('默认邮件服务每小时最多发送 2 封');
    expect(screen.queryByText(/security purposes/i)).not.toBeInTheDocument();
  });

  test('requires a valid recovery session before changing a password', async () => {
    const client = new FakeAuthClient();
    renderApp('/reset-password', client);

    await screen.findByRole('heading', { name: '设置新密码' });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.change(screen.getByLabelText(/再次输入新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('重置链接无效或已经过期');
    expect(client.updatePassword).not.toHaveBeenCalled();
  });

  test('updates the password through a recovery session and then signs out', async () => {
    const client = new FakeAuthClient({ id: 'recovering-user', email: 'maker@example.com' });
    renderApp('/reset-password', client);

    await screen.findByRole('heading', { name: '设置新密码' });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.change(screen.getByLabelText(/再次输入新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));

    await waitFor(() => expect(client.updatePassword).toHaveBeenCalledWith('new-safe-password'));
    expect(client.signOut).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  test('explains when a replacement password is the same as the old password', async () => {
    const client = new FakeAuthClient({ id: 'recovering-user', email: 'maker@example.com' });
    client.updatePasswordError = new Error(
      'New password should be different from the old password.',
    );
    renderApp('/reset-password', client);

    await screen.findByRole('heading', { name: '设置新密码' });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'existing-password' },
    });
    fireEvent.change(screen.getByLabelText(/再次输入新密码/), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('不能与原密码相同');
    expect(client.signOut).not.toHaveBeenCalled();
  });

  test('does not report password-update failure when only automatic sign-out fails', async () => {
    const client = new FakeAuthClient({ id: 'recovering-user', email: 'maker@example.com' });
    client.signOutError = new Error('network unavailable');
    renderApp('/reset-password', client);

    await screen.findByRole('heading', { name: '设置新密码' });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.change(screen.getByLabelText(/再次输入新密码/), {
      target: { value: 'new-safe-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(await screen.findByRole('status')).toHaveTextContent('新密码已经保存');
    expect(screen.queryByText(/密码没有更新成功/)).not.toBeInTheDocument();
  });

  test('fails closed when Supabase is not configured', async () => {
    renderApp('/dashboard', null);

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('也不会假装已经登入');
  });

  test('signs out an authenticated user and removes access to the shell', async () => {
    const client = new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' });
    renderApp('/dashboard', client);

    expect(
      await screen.findByRole('heading', { name: '把图纸收进来' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    await waitFor(() => expect(client.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  test('keeps the authenticated shell visible when sign-out fails', async () => {
    const client = new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' });
    client.signOutError = new Error('network unavailable');
    renderApp('/dashboard', client);

    expect(
      await screen.findByRole('heading', { name: '把图纸收进来' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('退出没有完成');
    expect(
      screen.getByRole('heading', { name: '把图纸收进来' }),
    ).toBeInTheDocument();
  });
});
