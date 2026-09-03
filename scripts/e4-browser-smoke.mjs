#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';
import { crearPreparacion } from '../routes/preparacion.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-e4-browser-'));
const dbPath = path.join(temp, 'fusion.sqlite');
const port = 3800 + (process.pid % 100); let server;
const waitFor = (url) => new Promise((resolve, reject) => { const start = Date.now(); const check = () => {
  const req = http.get(url, (res) => { res.resume(); if (res.statusCode < 500) resolve(); else retry(); });
  req.on('error', retry); req.setTimeout(1000, () => { req.destroy(); retry(); });
  function retry() { if (Date.now() - start > 15000) reject(new Error(`server timeout: ${url}`)); else setTimeout(check, 100); }
}; check(); });

async function main() {
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, DB_PATH: dbPath, PORT: String(port), DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'e4-session', MOBILE_JWT_SECRET: 'e4-browser-mobile-secret-0123456789abcdef' }, stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/login/`);
  const db = new Database(dbPath); const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (?, ?, 1, 1, ?, ?)`).run('e4-browser-admin', hashPassword('E4-browser-only-123!'), now, now);
  const seed = (canal, numero, clave) => {
    const id = crearPreparacion(db, { canal, wcOrderId: canal === 'web' ? numero : null, mlOrderId: canal === 'ml' ? numero : null, packId: canal === 'ml' ? clave : null, numeroPedido: String(numero), comprador: 'E4', items: [] });
    db.prepare("UPDATE preparaciones SET estado='completada' WHERE id=?").run(id);
    db.prepare("INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, pack_id, numero_pedido, estado_envio, items_json, actualizado_en, fecha_despacho) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`${canal}:${numero}`, canal, canal === 'web' ? numero : null, canal === 'ml' ? numero : null, canal === 'ml' ? clave : null, String(numero), 'pendiente', '[]', now, '2026-09-03');
    const control = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?) RETURNING id").get(clave, now, now);
    return { id, control: control.id, clave };
  };
  const ml = seed('ml', 'ML-E4-1', 'PACK-E4-ML'); const web = seed('web', 940001, 'web:940001'); db.close();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/login/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#user').fill('e4-browser-admin'); await page.locator('#pass').fill('E4-browser-only-123!'); await page.locator('#btn').click(); await page.waitForURL(/herramientas\/home/);
    await page.goto(`http://127.0.0.1:${port}/preparacion/`, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async ({ ml, web }) => {
      const call = async (url, options = {}) => { const r = await fetch(url, options); return { status: r.status, body: await r.json() }; };
      const headers = (key) => ({ 'Content-Type': 'application/json', 'Idempotency-Key': key });
      const mlLot = await call('/api/preparacion/despacho/lotes', { method: 'POST', headers: headers('e4-ml-create'), body: JSON.stringify({ canal: 'ml', fecha_jornada: '2026-09-03', control_ids: [ml.control] }) });
      const webLot = await call('/api/preparacion/despacho/lotes', { method: 'POST', headers: headers('e4-web-create'), body: JSON.stringify({ canal: 'web', fecha_jornada: '2026-09-03', control_ids: [web.control] }) });
      if (mlLot.status !== 201 || webLot.status !== 201) throw new Error(`creación: ${mlLot.status}/${webLot.status}`);
      const id = mlLot.body.lote.id; for (const op of ['iniciar']) { const r = await call(`/api/preparacion/despacho/lotes/${id}/${op}`, { method: 'POST' }); if (r.status !== 200) throw new Error(`iniciar: ${r.status}`); }
      const scan = await call(`/api/preparacion/despacho/lotes/${id}/escanear`, { method: 'POST', headers: headers('e4-scan'), body: JSON.stringify({ codigo: ml.clave }) });
      const replay = await call(`/api/preparacion/despacho/lotes/${id}/escanear`, { method: 'POST', headers: headers('e4-scan'), body: JSON.stringify({ codigo: ml.clave }) });
      const tracking = await call(`/api/preparacion/despacho/lotes/${id}/tracking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control_id: ml.control, tracking: 'ML-TRACK-E4' }) });
      const closed = await call(`/api/preparacion/despacho/lotes/${id}/cerrar`, { method: 'POST' }); const output = await call(`/api/preparacion/despacho/lotes/${id}/salida`, { method: 'POST', headers: { 'Idempotency-Key': 'e4-output' } });
      const events = await call(`/api/preparacion/despacho/lotes/${id}/eventos`);
      return { ml: mlLot.body.lote.canal, web: webLot.body.lote.canal, scan: scan.status, replay: replay.body.repetido === true, tracking: tracking.status, closed: closed.status, output: output.status, events: events.body.eventos.length };
    }, { ml, web });
    if (JSON.stringify(result) !== JSON.stringify({ ml: 'ml', web: 'web', scan: 201, replay: true, tracking: 200, closed: 200, output: 200, events: 6 })) throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
    console.log('E4 browser: lotes ML/Web separados + escaneo idempotente + tracking + cierre + salida + auditoría OK');
  } finally { await context.close(); await browser.close(); }
}
try { await main(); } finally { if (server?.pid) server.kill('SIGTERM'); fs.rmSync(temp, { recursive: true, force: true }); }
