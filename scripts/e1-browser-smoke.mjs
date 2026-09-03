#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import axe from 'axe-core';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';
import { crearPreparacion } from '../routes/preparacion.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-e1-browser-'));
const dbPath = path.join(temp, 'fusion.sqlite');
const port = 3400 + (process.pid % 200);
let server;

function waitFor(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const req = http.get(url, (res) => { res.resume(); if (res.statusCode < 500) resolve(); else retry(); });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); retry(); });
    };
    const retry = () => Date.now() - started > 15000 ? reject(new Error(`server timeout: ${url}`)) : setTimeout(check, 100);
    check();
  });
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'e1-browser-session', MOBILE_JWT_SECRET: 'e1-browser-mobile-secret-0123456789' },
    stdio: 'ignore',
  });
  await waitFor(`http://127.0.0.1:${port}/login/`);
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
    VALUES (?, ?, 1, 1, ?, ?)`).run('e1-browser-admin', hashPassword('E1-browser-only-123!'), now, now);
  db.prepare(`INSERT INTO pedidos_cache
    (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en, estado_despacho)
    VALUES (?, 'web', ?, ?, ?, ?, 'pendiente', ?, ?, 'activo')`).run(
      'e1-browser-order', 900001, '900001', 'Pedido de prueba E1', now,
      JSON.stringify([{ line_item_id: 1, product_id: 1, variation_id: null, sku: 'E1-TEST', nombre: 'Producto de prueba', categoria: 'Bicicletas', cantidad: 1 }]), now,
    );
  const prepId = crearPreparacion(db, {
    canal: 'web', wcOrderId: 900001, numeroPedido: '900001', comprador: 'Pedido de prueba E1',
    items: [{ sku: 'E1-TEST', nombre: 'Producto de prueba', cantidad: 1, perfil: 'sellado' }],
  });
  db.close();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ bypassCSP: true });
  try {
    const api = await (await fetch(`http://127.0.0.1:${port}/api/preparacion/pedidos`)).status;
    if (api !== 401) throw new Error(`API sin sesión devolvió ${api}, se esperaba 401`);
    const login = await context.newPage({ viewport: { width: 390, height: 844 } });
    await login.goto(`http://127.0.0.1:${port}/login/`, { waitUntil: 'domcontentloaded' });
    await login.locator('#user').fill('e1-browser-admin');
    await login.locator('#pass').fill('E1-browser-only-123!');
    await login.locator('#btn').click();
    await login.waitForURL(/herramientas\/home/, { timeout: 10000 });
    for (const [width, height] of [[390, 844], [768, 900], [1440, 900]]) {
      const page = await context.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${port}/preparacion/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('#cuerpo .loading'), { timeout: 10000 }).catch(() => {});
      const title = await page.title();
      if (!title) throw new Error(`sin título en ${width}x${height}`);
      await page.addScriptTag({ content: axe.source });
      const accessibility = await page.evaluate(async () => window.axe.run(document));
      const serious = accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
      if (serious.length) throw new Error(`axe ${width}x${height}: ${serious.map((v) => `${v.id}=${v.nodes.map((n) => n.html).join('|')}`).join('; ')}`);
      console.log(`E1 axe ${width}x${height}: ${accessibility.violations.length} violations: ${accessibility.violations.map((v) => `${v.id}=${v.nodes.map((n) => n.html).join('|')}`).join('; ') || 'ninguna'}`);
      console.log(`E1 browser ${width}x${height}: OK`);
      await page.close();
    }
    await login.goto(`http://127.0.0.1:${port}/preparacion/`, { waitUntil: 'domcontentloaded' });
    const pendientes = await login.evaluate(async () => (await fetch('/api/preparacion/pendientes')).json());
    if (!pendientes.ok || !pendientes.data.some((pedido) => pedido.numero_pedido === '900001')) {
      throw new Error('el pedido sintético no apareció en la bandeja autenticada');
    }
    console.log('E1 login autenticado: OK');
    console.log('E1 bandeja autenticada con pedido sintético: OK');
    const foto = await login.evaluate(async (id) => {
      const tomar = await fetch(`/api/preparacion/${id}/tomar`, { method: 'POST' });
      if (!tomar.ok) return { error: `tomar ${tomar.status}` };
      const form = new FormData();
      form.append('archivo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'e1-test.jpg');
      form.append('tipo', 'articulo');
      form.append('upload_id', 'e1-upload-1');
      const primera = await fetch(`/api/preparacion/${id}/foto`, { method: 'POST', body: form });
      const primeraJson = await primera.json();
      const form2 = new FormData();
      form2.append('archivo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'e1-test.jpg');
      form2.append('tipo', 'articulo');
      form2.append('upload_id', 'e1-upload-1');
      const segundaJson = await (await fetch(`/api/preparacion/${id}/foto`, { method: 'POST', body: form2 })).json();
      const completar = await fetch(`/api/preparacion/${id}/completar`, { method: 'POST' });
      return { primera: primera.status, segunda: segundaJson.idempotente === true, completar: completar.status };
    }, prepId);
    if (foto.error || foto.primera !== 200 || !foto.segunda || foto.completar !== 400) {
      throw new Error(`flujo de evidencia inesperado: ${JSON.stringify(foto)}`);
    }
    console.log('E1 foto multipart + idempotencia + rechazo de evidencia incompleta: OK');
    await login.close();
    console.log('E1 HTTP protegido sin sesión: 401 OK');
  } finally {
    await context.close();
    await browser.close();
  }
}

try { await main(); } finally {
  if (server?.pid) server.kill('SIGTERM');
  fs.rmSync(temp, { recursive: true, force: true });
}
