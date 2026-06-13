import fs from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';
import { BASE_URL } from './config.js';
import { storageStatePath } from './paths.js';
import { installReadOnlyGuard, installRecorder } from './capture.js';
import type { ModuleName } from './types.js';
import { timestamp } from './utils.js';

async function clickVisibleText(page: Page, label: string): Promise<void> {
  const matches = page.getByText(label, { exact: true });
  for (let index = 0; index < await matches.count(); index += 1) {
    const locator = matches.nth(index);
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(1_500);
      return;
    }
  }
  throw new Error(`No se encontro el acceso visible: ${label}`);
}

async function clickLastVisibleText(page: Page, label: string): Promise<void> {
  const matches = page.getByText(label, { exact: true });
  for (let index = (await matches.count()) - 1; index >= 0; index -= 1) {
    const locator = matches.nth(index);
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(1_500);
      return;
    }
  }
  throw new Error(`No se encontro el acceso visible: ${label}`);
}

async function inspectReadOnlyControls(page: Page): Promise<void> {
  const safeControls = page.getByRole('button', { name: /buscar|consultar|filtrar|siguiente|next|ver|detalle/i });
  const count = Math.min(await safeControls.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const control = safeControls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

async function openHome(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByText('Mantenimiento', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
}

export async function exploreAutonomously(): Promise<void> {
  await fs.access(storageStatePath).catch(() => {
    throw new Error('No existe una sesion. Ejecuta primero: npm run capture');
  });
  const sessionName = `autonomous-${timestamp()}`;
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: storageStatePath });
  await installReadOnlyGuard(context);
  let currentModule: ModuleName | 'unknown' = 'unknown';
  const captureFile = await installRecorder(context, sessionName, () => currentModule);
  const page = await context.newPage();
  await openHome(page);

  currentModule = 'orders';
  console.log('Explorando orders...');
  await clickVisibleText(page, 'Mantenimiento');
  await clickVisibleText(page, 'Ordenes');
  await inspectReadOnlyControls(page);

  currentModule = 'quotes';
  console.log('Explorando quotes...');
  await openHome(page);
  await clickVisibleText(page, 'Cotizaciones');
  await clickLastVisibleText(page, 'Cotizaciones');
  await inspectReadOnlyControls(page);

  currentModule = 'clients';
  console.log('Explorando clients...');
  await openHome(page);
  await clickVisibleText(page, 'Clientes y equipos');
  await clickLastVisibleText(page, 'Clientes');
  await inspectReadOnlyControls(page);

  currentModule = 'equipment';
  console.log('Explorando equipment...');
  await openHome(page);
  await clickVisibleText(page, 'Clientes y equipos');
  await clickLastVisibleText(page, 'Clientes');
  const equipmentLink = page.locator('tbody a').first();
  await equipmentLink.waitFor({ state: 'visible', timeout: 20_000 });
  await equipmentLink.click();
  await page.waitForTimeout(1_500);
  await inspectReadOnlyControls(page);

  await context.storageState({ path: storageStatePath });
  await context.close();
  await browser.close();
  console.log(`Captura privada: ${captureFile}`);
}
