import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Request } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { API_URL, LOGIN_URL } from '../src/config.js';
import { installRecorder } from '../src/capture.js';

test('persists sanitized capture metadata and JSON without storing login response or query secrets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-capture-'));
  const handlers = new Map<string, (value: never) => unknown>();
  const context = {
    on: (event: string, handler: (value: never) => unknown) => { handlers.set(event, handler); },
  } as unknown as BrowserContext;
  const request = (url: string, body: string, pageUrl: string) => ({
    url: () => url,
    method: () => 'POST',
    postData: () => body,
    resourceType: () => 'xhr',
    frame: () => ({ page: () => ({ url: () => pageUrl }) }),
  }) as unknown as Request;
  const loginRequest = request(LOGIN_URL, JSON.stringify({ email: 'test@example.com', password: 'super-secret-password' }), 'https://app.siys.net/login');
  const apiRequest = request(
    `${API_URL}/file?token=synthetic-token&name=test`,
    JSON.stringify({ password: 'super-secret-password' }),
    'https://app.siys.net/orders?token=synthetic-token&tab=open',
  );
  try {
    const captureFile = await installRecorder(context, 'synthetic', undefined, {
      captures: path.join(directory, 'captures'), responses: path.join(directory, 'responses'),
    });
    handlers.get('request')?.(loginRequest as never);
    handlers.get('request')?.(apiRequest as never);
    const emitResponse = handlers.get('response');
    if (!emitResponse) throw new Error('No se instaló el listener de response.');

    await emitResponse({
      request: () => loginRequest,
      headers: () => ({ 'content-type': 'application/json' }),
      status: () => 200,
      body: async () => Buffer.from(JSON.stringify({ token: 'header.payload.synthetic-secret', password: 'super-secret-password' })),
    } as never);
    await emitResponse({
      request: () => apiRequest,
      headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
      status: () => 200,
      body: async () => Buffer.from(JSON.stringify({ token: 'header.payload.synthetic-secret', password: 'super-secret-password', name: 'Normal diagnostic value' })),
    } as never);

    const records = (await fs.readFile(captureFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const loginRecord = records.find((record) => record.url === LOGIN_URL);
    const apiRecord = records.find((record) => record.url !== LOGIN_URL);
    expect(loginRecord).toEqual(expect.objectContaining({ status: 200 }));
    expect(loginRecord).not.toHaveProperty('responseBodyFile');
    expect(apiRecord).toEqual(expect.objectContaining({
      url: `${API_URL}/file?token=%5BREDACTED%5D&name=test`,
      pageUrl: 'https://app.siys.net/orders?token=%5BREDACTED%5D&tab=open',
      requestBody: { password: '[REDACTED]' },
    }));

    const responseFiles = await fs.readdir(path.join(directory, 'responses'));
    expect(responseFiles).toHaveLength(1);
    expect(responseFiles[0]).not.toContain('synthetic-token');
    expect(responseFiles[0]).toContain('file');
    const persistedResponse = await fs.readFile(path.join(directory, 'responses', responseFiles[0]!), 'utf8');
    expect(persistedResponse).toContain('Normal diagnostic value');
    expect(persistedResponse).toContain('[REDACTED]');
    expect(`${JSON.stringify(records)}\n${persistedResponse}\n${responseFiles.join('\n')}`)
      .not.toMatch(/synthetic-secret|super-secret-password|synthetic-token/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
