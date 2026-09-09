import { chromium } from 'playwright';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(`${base}/login/`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  await page.fill('#user', 'preview-admin');
  await page.fill('#pass', 'preview-only-123!');
  await page.click('#btn');
  await page.waitForTimeout(500);
  await page.goto(`${base}/gestion-pedidos/`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  if (page.url() !== `${base}/gestion-pedidos/`) throw new Error(`listado redirigió a ${page.url()}`);
  await page.getByRole('button', { name: /Recuperar ventas/ }).click();
  if (!(await page.locator('#recovery').isVisible())) throw new Error('Recuperar ventas no se mostró');
  await page.getByRole('button', { name: /En preparación/ }).click();
  if (!(await page.locator('#preparation').isVisible())) throw new Error('En preparación no se mostró');
  await page.getByRole('button', { name: /Despachos/ }).click();
  if (!(await page.locator('#dispatch').isVisible())) throw new Error('Despachos no se mostró');
  await page.getByRole('button', { name: /Todos los pedidos/ }).click();
  if (!(await page.locator('#orders').isVisible())) throw new Error('Todos los pedidos no se mostró');
  await page.goto(`${base}/gestion-pedidos/pedidos/1001`, { waitUntil: 'domcontentloaded', timeout: 5000 });
  await page.waitForTimeout(300);
  if (page.url() !== `${base}/gestion-pedidos/pedidos/1001`) throw new Error(`detalle redirigió a ${page.url()}`);
  if (!(await page.locator('#full-order').isVisible())) throw new Error('detalle completo no se mostró');
  if (!(await page.getByRole('button', { name: /Abrir en WooCommerce/ }).isVisible())) throw new Error('enlace a WooCommerce no se mostró');
  if (errors.length) throw new Error(`errores de página: ${errors.join('; ')}`);
  await page.screenshot({ path: 'output/playwright/gestion-pedidos-detail-final.png', fullPage: true });
  console.log('OK: login, listado, Recuperar ventas, URL de detalle y render sin errores');
} finally {
  await browser.close();
}
