import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium, type BrowserContext, type Page, type Request } from '@playwright/test';
import { API_URL, BASE_URL, LOGIN_URL, moduleLabels } from './config.js';
import { capturesDir, responsesDir, storageStatePath } from './paths.js';
import { isAllowedRequest, parseBody } from './security.js';
import type { CaptureRecord, ModuleName } from './types.js';
import { ensureDir, timestamp } from './utils.js';

function classifyModule(pageUrl: string, requestUrl: string): ModuleName | 'unknown' {
  const text = `${pageUrl} ${requestUrl}`;
  for (const [module, pattern] of Object.entries(moduleLabels)) {
    if (pattern.test(text)) return module as ModuleName;
  }
  return 'unknown';
}

function safeFileName(url: string): string {
  const parsed = new URL(url);
  const base = `${parsed.pathname}${parsed.search}`
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return base || 'root';
}

async function appendRecord(file: string, record: CaptureRecord): Promise<void> {
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function installReadOnlyGuard(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (isAllowedRequest(request.method(), request.url())) {
      await route.continue();
      return;
    }
    console.warn(`[BLOCKED] ${request.method()} ${request.url()}`);
    await route.abort('blockedbyclient');
  });
}

export async function installRecorder(
  context: BrowserContext,
  sessionName: string,
  moduleHint?: () => ModuleName | 'unknown',
): Promise<string> {
  await ensureDir(capturesDir);
  await ensureDir(responsesDir);
  const captureFile = path.join(capturesDir, `${sessionName}.ndjson`);
  const pending = new Map<Request, CaptureRecord>();

  context.on('request', (request) => {
    if (!request.url().startsWith(API_URL) && request.url() !== LOGIN_URL) return;
    const pageUrl = request.frame()?.page()?.url() ?? '';
    pending.set(request, {
      capturedAt: new Date().toISOString(),
      pageUrl,
      module: moduleHint?.() ?? classifyModule(pageUrl, request.url()),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      requestBody: parseBody(request.postData()),
    });
  });

  context.on('requestfailed', (request) => {
    const record = pending.get(request);
    if (!record) return;
    pending.delete(request);
    void appendRecord(captureFile, { ...record, failure: request.failure()?.errorText ?? 'unknown' });
  });

  context.on('response', (response) => {
    const request = response.request();
    const record = pending.get(request);
    if (!record) return;
    pending.delete(request);
    void (async () => {
      const contentType = response.headers()['content-type'] ?? '';
      let responseBodyFile: string | undefined;
      if (/json|xml|text\/plain/i.test(contentType) && response.status() < 400) {
        try {
          const body = await response.body();
          const fileName = `${sessionName}-${timestamp()}-${safeFileName(request.url())}`;
          const extension = /json/i.test(contentType) ? 'json' : /xml/i.test(contentType) ? 'xml' : 'txt';
          responseBodyFile = path.join(responsesDir, `${fileName}.${extension}`);
          await fs.writeFile(responseBodyFile, body);
        } catch {
          // Redirects and streamed responses may not expose a body.
        }
      }
      await appendRecord(captureFile, {
        ...record,
        status: response.status(),
        contentType,
        responseBodyFile,
      });
    })();
  });

  return captureFile;
}

async function waitForUser(page: Page): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  await input.question(
    '\nInicia sesion y navega por Ordenes, Cotizaciones, Clientes y Equipos. Presiona Enter aqui al terminar.\n',
  );
  input.close();
  await page.context().storageState({ path: storageStatePath });
}

async function loginFromEnvironment(page: Page): Promise<boolean> {
  const email = process.env.SIYS_EMAIL;
  const password = process.env.SIYS_PASSWORD;
  if (!email && !password) return false;
  if (!email || !password) throw new Error('Define SIYS_EMAIL y SIYS_PASSWORD juntos en .env.');

  await page.getByPlaceholder('E-mail').fill(email);
  await page.getByPlaceholder('Contraseña').fill(password);
  const loginResponse = page.waitForResponse((response) => response.url() === LOGIN_URL && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Acceder' }).click();
  const response = await loginResponse;
  if (!response.ok()) throw new Error(`Login rechazado por SIYS: HTTP ${response.status()}.`);
  await page.waitForFunction(() => Boolean(localStorage.getItem('token')));
  await page.context().storageState({ path: storageStatePath });
  console.log('Login completado y sesion guardada localmente.');
  return true;
}

export async function captureAssisted(): Promise<void> {
  const sessionName = `assisted-${timestamp()}`;
  await ensureDir(capturesDir);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await installReadOnlyGuard(context);
  const captureFile = await installRecorder(context, sessionName);
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await loginFromEnvironment(page);
  await waitForUser(page);
  await context.close();
  await browser.close();
  console.log(`Captura privada: ${captureFile}`);
  console.log(`Sesion privada: ${storageStatePath}`);
}
