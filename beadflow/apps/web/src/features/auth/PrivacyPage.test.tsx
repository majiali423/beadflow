import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import { PrivacyPage } from './PrivacyPage';

describe('privacy disclosure', () => {
  test('describes actual cloud processing and keeps unresolved launch blockers visible', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'BeadFlow 隐私说明' })).toBeInTheDocument();
    expect(screen.getByText(/Supabase 的日本东京区域/)).toBeInTheDocument();
    expect(screen.getByText(/图纸名称、MARD 色号、材料数量、库存数量/)).toBeInTheDocument();
    expect(screen.getByText('个人信息处理者：马嘉笠')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'majiali2003@163.com' })).toHaveAttribute(
      'href',
      'mailto:majiali2003@163.com',
    );
    expect(screen.getByRole('link', { name: '15843702092' })).toHaveAttribute(
      'href',
      'tel:15843702092',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('不得面向公众开放注册');
    expect(screen.getByText(/永久删除私有原图/)).toBeInTheDocument();
    expect(screen.getByText(/下载自己的结构化 JSON 数据副本/)).toBeInTheDocument();
    expect(screen.getByText(/不包含密码、登录令牌或图片二进制文件/)).toBeInTheDocument();
    expect(screen.getByText(/尚未提供完整的自助账号删除页面/)).toBeInTheDocument();
  });
});
