import { afterEach, describe, expect, test } from 'vitest';

import { buildApp } from './app.js';

const apps = [] as ReturnType<typeof buildApp>[];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API shell', () => {
  test('reports service health', async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'beadflow-api' });
  });

  test('uses a stable error envelope', async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/missing' });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toEqual(expect.any(String));
  });

  test.each([
    '/api/projects',
    '/api/projects/00000000-0000-0000-0000-000000000000/patterns',
    '/api/projects/00000000-0000-0000-0000-000000000000/build-plan',
    '/api/projects/00000000-0000-0000-0000-000000000000/scans',
  ])('does not expose a removed legacy endpoint: %s', async (url) => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
