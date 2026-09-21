import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { App } from './App';
import { AuthProvider } from './features/auth/AuthContext';
import { FakeAuthClient } from './test/fakeAuthClient';

test('keeps the main navigation focused on the active pattern-card workflow', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/scan']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: '把图纸收进来' }),
  ).toBeInTheDocument();
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  expect(navigation).toHaveTextContent('扫描图纸');
  expect(navigation).toHaveTextContent('图纸库');
  expect(navigation).toHaveTextContent('豆仓');
  expect(navigation).toHaveTextContent('下一张');
  expect(navigation).not.toHaveTextContent('缺料采购');
});

test('removes old workflow deep links instead of exposing compatibility pages', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/projects']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByRole('heading', { name: '找不到这一页' })).toBeInTheDocument();
  expect(screen.queryByLabelText('历史兼容功能提示')).not.toBeInTheDocument();
});
