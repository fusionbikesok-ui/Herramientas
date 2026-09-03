#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';
import { retenerPedidoMl, escanearGuardiaMl } from '../lib/guardiaMl.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-um1-browser-'));
const dbPath = path.join(dir, 'demo.sqlite');
const port = 3700 + (process.pid % 200);
let server;

const wait = () => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    http.get(`http://127.0.0.1:${port}/login/`, (response) => {
      response.resume();
      if (response.statusCode < 500) resolve(); else setTimeout(tick, 100);
    }).on('error', () => Date.now() - start > 15000
      ? reject(Error('server timeout')) : setTimeout(tick, 100));
  };
  tick();
});

try {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'um1-e2-session', MOBILE_JWT_SECRET: 'um1-browser-mobile-secret-0123456789' },
    stdio: 'ignore',
  });
  await wait();

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run('um1-e2-admin', hashPassword('UM1-browser-only-123!'), 1, 1, now, now);
  db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,img,actualizado_en)
    VALUES(?,?,?,?,?,?,?)`).run(9001, 'Producto sin cobertura', 'FB-UM1-DEMO', 'simple', 4, 'https://img.woo/demo.jpg', now);
  db.prepare(`INSERT INTO ml_publicaciones_cache(clave,item_id,variation_id,titulo,status,seller_sku,thumbnail,available_quantity,actualizado_en)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('MLA-E2|VAR-1', 'MLA-E2', 'VAR-1', 'Producto sin cobertura', 'active', '', 'https://img.ml/demo.jpg', 2, now);
  escanearGuardiaMl(db, 'e2', { lecturaMlConfirmada: true });
  retenerPedidoMl(db, { orderId: 'ORDER-E2', items: [{ item_id: 'MLA-E2' }], claves: ['MLA-E2|VAR-1'] });
  const caso = db.prepare('SELECT id FROM guardia_ml_casos WHERE clave=?').get('MLA-E2|VAR-1');
  db.close();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const width = Number(process.env.UM1_VIEWPORT_WIDTH || 390);
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
  page.on('pageerror', (error) => console.error(`[browser-pageerror] ${error.message}`));
  page.on('response', async (response) => {
    if (response.url().includes('/api/guardia-ml') && response.status() >= 400) {
      console.error(`[browser-api] ${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`http://127.0.0.1:${port}/login/`);
  await page.locator('#user').fill('um1-e2-admin');
  await page.locator('#pass').fill('UM1-browser-only-123!');
  await page.locator('#btn').click();
  // El servidor aislado escucha en raíz; el prefijo /herramientas/ lo agrega nginx
  // únicamente en producción.
  await page.waitForURL(/\/home\//);
  await page.goto(`http://127.0.0.1:${port}/guardia-ml/`);
  await page.waitForSelector('text=Guardia ML');
  await page.locator('button[data-view="resolver"]').waitFor();
  await page.getByText('MercadoLibre · fuente', { exact: true }).waitFor();
  await page.getByLabel('Buscar en Woo').waitFor();
  await page.getByText('Producto sin cobertura', { exact: true }).last().waitFor();
  for (const [tab, title] of [
    ['Investigar', 'Investigar antes de cambiar'],
    ['Corregir catálogo', 'Corregir catálogo'],
    ['Auditar cobertura', 'Auditar cobertura'],
    ['Decisiones previas', 'Ventas retenidas'],
  ]) {
    await page.locator(`button[data-view="${tab === 'Corregir catálogo' ? 'catalogo' : tab === 'Auditar cobertura' ? 'cobertura' : tab === 'Decisiones previas' ? 'historial' : 'investigar'}"]`).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
  }
  const state = await page.evaluate(async (id) => ({
    casos: (await (await fetch('/api/guardia-ml/casos')).json()).data.length,
    retenidos: (await (await fetch('/api/guardia-ml/pedidos-retenidos')).json()).data.length,
    eventos: (await (await fetch(`/api/guardia-ml/casos/${id}/eventos`)).json()).data.length,
    opciones: (await (await fetch(`/api/guardia-ml/casos/${id}/opciones`)).json()).data.opciones.length,
  }), caso.id);
  if (state.casos !== 1 || state.retenidos !== 1 || state.eventos < 1 || state.opciones !== 1) {
    throw Error(`UM1 E2E estado incompleto ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ ok: true, e2e: 'UM1', viewport: width, casos: state.casos, retenidos: state.retenidos, eventos: state.eventos, opciones: state.opciones, comparador: true }));
  await page.close();
  await browser.close();
} finally {
  if (server?.pid) server.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
}
