#!/usr/bin/env node
// Entorno de diseño aislado: base temporal, datos ficticios y puerto independiente.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';
import { crearPreparacion } from '../routes/preparacion.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-design-preview-'));
const dbPath = path.join(temp, 'preview.sqlite');
const port = Number(process.env.PREVIEW_PORT || 4173);
let server;

function waitFor(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (Date.now() - started > 15000) return reject(new Error(`server timeout: ${url}`));
      const req = http.get(url, (res) => { res.resume(); res.statusCode < 500 ? resolve() : setTimeout(check, 100); });
      req.on('error', () => setTimeout(check, 100));
      req.setTimeout(1000, () => { req.destroy(); setTimeout(check, 100); });
    };
    check();
  });
}

function seed() {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
    VALUES (?, ?, 1, 1, ?, ?)`).run('preview-admin', hashPassword('preview-only-123!'), now, now);
  const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="96" height="96"%3E%3Crect width="96" height="96" rx="12" fill="%2327b3e6"/%3E%3Ccircle cx="48" cy="42" r="22" fill="white"/%3E%3Cpath d="M25 73h46" stroke="white" stroke-width="8" stroke-linecap="round"/%3E%3C/svg%3E';
  const productos = [
    [920001, 'Casco urbano demo', 'FB-CASCO-DEMO', image],
    [920002, 'Luces LED delanteras', 'FB-LUZ-DEMO', image],
    [920003, 'Kit transmisión 9v', 'FB-KIT-DEMO', image],
  ];
  const insertProducto = db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,img,actualizado_en)
    VALUES (?, ?, ?, 'simple', 20, ?, ?)`);
  for (const producto of productos) insertProducto.run(...producto, now);
  const pedidos = [
    ['web:PREVIEW-1001', 'web', 920101, 'PREVIEW-1001', 'Ana García', 'pendiente', 'lpaandreani', [{ product_id: 920001, sku: 'FB-CASCO-DEMO', nombre: 'Casco urbano demo', cantidad: 1 }]],
    ['web:PREVIEW-1002', 'web', 920102, 'PREVIEW-1002', 'Bruno López', 'pendiente', 'lpaandreani', [{ product_id: 920002, sku: 'FB-LUZ-DEMO', nombre: 'Luces LED delanteras', cantidad: 2 }]],
    ['web:LOCAL-1003', 'web', 920103, 'LOCAL-1003', 'Venta local demo', 'enviado', 'completed', [{ product_id: 920003, sku: 'FB-KIT-DEMO', nombre: 'Kit transmisión 9v', cantidad: 1 }]],
    ['web:PREVIEW-1005', 'web', 920105, 'PREVIEW-1005', 'Diego Ruiz', 'enviado', 'cancelled', [{ product_id: 920001, sku: 'FB-CASCO-DEMO', nombre: 'Casco urbano demo', cantidad: 1 }]],
    ['web:PREVIEW-1006', 'web', 920106, 'PREVIEW-1006', 'Elena Soto', 'pendiente', 'pending', [{ product_id: 920002, sku: 'FB-LUZ-DEMO', nombre: 'Luces LED delanteras', cantidad: 1 }]],
    ['web:LOCAL-1008', 'web', 920108, 'LOCAL-1008', 'Gabriela León', 'enviado', 'completed', [{ product_id: 920003, sku: 'FB-KIT-DEMO', nombre: 'Kit transmisión 9v', cantidad: 1 }]],
  ];
  const insertPedido = db.prepare(`INSERT INTO pedidos_cache
    (clave,canal,wc_order_id,numero_pedido,comprador,fecha,estado_envio,estado_wc,espejo_ml,items_json,actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
  for (const [clave, canal, id, numero, comprador, estado, estadoWc, items] of pedidos) {
    insertPedido.run(clave, canal, id, numero, comprador, now, estado, estadoWc, JSON.stringify(items), now);
  }
  const prepId = crearPreparacion(db, {
    canal: 'web', wcOrderId: 920101, numeroPedido: 'PREVIEW-1001', comprador: 'Ana García',
    items: [{ sku: 'FB-CASCO-DEMO', nombre: 'Casco urbano demo', cantidad: 1, perfil: 'sellado' }],
  });
  db.prepare("UPDATE preparaciones SET tracking='AND-PREVIEW-1001' WHERE id=?").run(prepId);
  db.close();
}

async function main() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), PEDIDOS_PREVIEW_USER: 'preview-admin', DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'design-preview-session', MOBILE_JWT_SECRET: 'design-preview-mobile-secret-0123456789' },
    stdio: 'inherit',
  });
  await waitFor(`http://127.0.0.1:${port}/login/`);
  seed();
  console.log(`Design preview: http://127.0.0.1:${port}/login/`);
  console.log('Usuario: preview-admin / preview-only-123!');
  console.log(`Base temporal: ${dbPath}`);
  const stop = () => { if (server && !server.killed) server.kill('SIGTERM'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise((resolve) => server.on('exit', resolve));
}

main().catch((error) => { console.error(error); if (server) server.kill('SIGTERM'); process.exitCode = 1; });
