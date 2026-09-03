#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { hashPassword } from '../lib/auth.js';
import { crearPreparacion } from '../routes/preparacion.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-e2-browser-'));
const dbPath = path.join(temp, 'fusion.sqlite');
const port = 3600 + (process.pid % 200);
let server;

function waitFor(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => Date.now() - started > 15000
      ? reject(new Error(`server timeout: ${url}`)) : setTimeout(check, 100);
    const check = () => {
      const req = http.get(url, (res) => { res.resume(); res.statusCode < 500 ? resolve() : retry(); });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); retry(); });
    };
    check();
  });
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'e2-session', MOBILE_JWT_SECRET: 'e2-browser-mobile-secret-0123456789' },
    stdio: 'ignore',
  });
  await waitFor(`http://127.0.0.1:${port}/login/`);
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (?, ?, 1, 1, ?, ?)`)
    .run('e2-browser-admin', hashPassword('E2-browser-only-123!'), now, now);
  const prepId = crearPreparacion(db, {
    canal: 'web', wcOrderId: 910001, numeroPedido: '910001', comprador: 'E2 browser',
    items: [{ sku: 'E2-TEST', nombre: 'Producto E2', cantidad: 1, perfil: 'sellado' }],
  });
  const itemId = db.prepare("SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku='E2-TEST'").get(prepId).id;
  db.close();
  const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/login/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#user').fill('e2-browser-admin');
    await page.locator('#pass').fill('E2-browser-only-123!');
    await page.locator('#btn').click();
    await page.waitForURL(/herramientas\/home/);
    await page.goto(`http://127.0.0.1:${port}/preparacion/`, { waitUntil: 'domcontentloaded' });
    const claim = await page.evaluate(async (id) => (await fetch(`/api/preparacion/${id}/tomar`, { method: 'POST' })).status, prepId);
    if (claim !== 200) throw new Error(`no se pudo tomar la preparación: HTTP ${claim}`);
    await page.evaluate(async (id) => window.abrirDetalle(id), prepId);
    const result = await page.evaluate(async ({ prepId, itemId, bytes }) => {
      const image = new Uint8Array(bytes);
      const file = new File([image], 'e2.jpg', { type: 'image/jpeg' });
      const form = new FormData();
      form.append('archivo', file); form.append('item_id', String(itemId)); form.append('tipo', 'articulo'); form.append('upload_id', 'e2-browser-upload-1');
      const first = await fetch(`/api/preparacion/${prepId}/foto`, { method: 'POST', body: form });
      const firstBody = await first.json();
      const duplicate = new FormData();
      duplicate.append('archivo', file); duplicate.append('item_id', String(itemId)); duplicate.append('tipo', 'articulo'); duplicate.append('upload_id', 'e2-browser-upload-1');
      const secondBody = await (await fetch(`/api/preparacion/${prepId}/foto`, { method: 'POST', body: duplicate })).json();
      return { first: first.status, idempotent: secondBody.idempotente === true, id: firstBody.foto?.id };
    }, { prepId, itemId, bytes: [...jpeg] });
    if (result.first !== 200 || !result.idempotent || !result.id) throw new Error(`upload/idempotencia: ${JSON.stringify(result)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const persisted = await page.evaluate(async (id) => {
      const response = await fetch(`/api/preparacion/${id}`); const body = await response.json();
      return body.data?.items?.some((item) => item.fotos?.length > 0) === true;
    }, prepId);
    if (!persisted) throw new Error('la evidencia no persistió después de recargar');
    await page.evaluate(async (id) => window.abrirDetalle(id), prepId);
    await page.evaluate(async ({ itemId, bytes }) => {
      const file = new File([new Uint8Array(bytes)], 'e2-timeout.jpg', { type: 'image/jpeg' });
      window.FOTO_UPLOAD_TIMEOUT_MS = 50;
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.endsWith('/foto') && init?.method === 'POST') {
          return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('simulated timeout', 'AbortError'));
            if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return originalFetch(input, init);
      };
      try { await window.intentarSubida(itemId, 'extra', file); } finally { window.fetch = originalFetch; }
    }, { itemId, bytes: [...jpeg] });
    const retryState = await page.evaluate(() => ({
      failed: !!document.querySelector('.thumb.err'),
      retry: !!document.querySelector('.thumb.err button.retry'),
      pending: Object.keys(window.SUBIDAS_PENDIENTES || {}).length > 0,
    }));
    if (!retryState.failed || !retryState.retry || !retryState.pending) throw new Error(`timeout sin reintento visual: ${JSON.stringify(retryState)}`);
    const late = await page.evaluate(async ({ itemId, bytes }) => {
      const file = new File([new Uint8Array(bytes)], 'e2-late.jpg', { type: 'image/jpeg' });
      window.FOTO_UPLOAD_TIMEOUT_MS = 50;
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!(url.endsWith('/foto') && init?.method === 'POST')) return originalFetch(input, init);
        return new Promise((resolve, reject) => {
          let aborted = false;
          const abort = () => { aborted = true; reject(new DOMException('late response lost', 'AbortError')); };
          if (init.signal?.aborted) return abort();
          init.signal?.addEventListener('abort', abort, { once: true });
          originalFetch(input, { ...init, signal: undefined }).then(async (response) => {
            await new Promise((done) => setTimeout(done, 100));
            if (!aborted) resolve(response);
          }).catch(reject);
        });
      };
      try {
        await window.intentarSubida(itemId, 'extra', file);
        return {
          reconciliada: document.getElementById('foto-live')?.textContent.includes('aunque la respuesta tardó'),
          fallida: !!document.querySelector('.thumb.err'),
        };
      } finally { window.fetch = originalFetch; }
    }, { itemId, bytes: [...jpeg] });
    if (!late.reconciliada || late.fallida) throw new Error(`respuesta tardía no reconciliada: ${JSON.stringify(late)}`);
    console.log('E2 browser: upload multipart + idempotencia + recarga + timeout/reintento + respuesta tardía reconciliada OK');
  } finally {
    await context.close(); await browser.close();
  }
}

try { await main(); } finally { if (server?.pid) server.kill('SIGTERM'); fs.rmSync(temp, { recursive: true, force: true }); }
