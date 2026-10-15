#!/usr/bin/env node
// Entorno E2E aislado para los chips de Preparación (E-4): base NUEVA en un directorio temporal (nunca la de prod), puerto libre,
// DISABLE_CRONS, ML/Woo sin credenciales (no hay llamadas externas) y un admin de QA con clave aleatoria guardada en un archivo 0600.
// Uso: node scripts/qa/e4-entorno.mjs up | down   (up deja el servidor corriendo y escribe el estado en <dir>/estado.json)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { hashPassword } from '../../lib/auth.js';
import { ensureTables } from '../../routes/preparacion.js';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const base = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const dir = path.join(base, 'e4-e2e');
const estadoPath = path.join(dir, 'estado.json');

const puertoLibre = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const esperar = (url) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const intento = () => {
    const req = http.get(url, (res) => { res.resume(); if (res.statusCode < 500) resolve(); else reintentar(); });
    req.on('error', reintentar); req.setTimeout(1000, () => { req.destroy(); reintentar(); });
    function reintentar() { if (Date.now() - t0 > 20000) reject(new Error(`timeout esperando ${url}`)); else setTimeout(intento, 150); }
  };
  intento();
});

/** ¿El pid es REALMENTE el servidor de este entorno? (cmdline = node server.js, cwd = la raíz del repo y DB_PATH = la base de este entorno). */
function esNuestroServidor(pid, dbPath) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (!cmd.some((x) => path.basename(x) === 'server.js')) return false;
    if (fs.readlinkSync(`/proc/${pid}/cwd`) !== root) return false;
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DB_PATH=${dbPath}`);
  } catch { return false; }
}

async function down() {
  try {
    const e = JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
    if (esNuestroServidor(e.pid, e.db)) process.kill(e.pid, 'SIGTERM');
    else console.log(`pid ${e.pid} no es el servidor de este entorno: no se mata`);
  } catch { /* sin estado */ }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('entorno E2E apagado');
}

async function up() {
  await down();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dir, 'fusion.sqlite');
  const port = await puertoLibre();
  const secreto = () => crypto.randomBytes(24).toString('hex');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root, detached: true, stdio: ['ignore', fs.openSync(path.join(dir, 'server.log'), 'a'), fs.openSync(path.join(dir, 'server.log'), 'a')],
    // Lista blanca: NADA se hereda salvo PATH/HOME/NODE_ENV. Sin ML/Woo/sombra/vigilante/gateway/push/ML_USER_ID: el servidor no puede
    // hablar con el exterior ni con la base real aunque el shell que lo lanza tenga esas variables.
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_ENV: process.env.NODE_ENV || 'test',
      DB_PATH: dbPath, PORT: String(port), LISTEN_HOST: '127.0.0.1', DISABLE_CRONS: 'true', DOTENV_CONFIG_PATH: '/dev/null',
      SESSION_SECRET: secreto(), MOBILE_JWT_SECRET: secreto() },
  });
  server.unref();
  await esperar(`http://127.0.0.1:${port}/login/`);

  const db = new Database(dbPath);
  ensureTables(db);
  const ahora = new Date().toISOString();
  const clave = secreto().slice(0, 20) + 'Aa1!';
  db.prepare('INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (?, ?, 1, 1, ?, ?)')
    .run('qa-e4-admin', await hashPassword(clave), ahora, ahora);
  fs.writeFileSync(path.join(dir, 'credenciales.txt'), `usuario=qa-e4-admin\nclave=${clave}\n`, { mode: 0o600 });

  const items = JSON.stringify([{ line_item_id: 1, product_id: 1, sku: 'QA-BIKE', nombre: 'Bicicleta QA', cantidad: 1 }]);
  const fecha = new Date(Date.now() - 3600 * 1000).toISOString();
  const ins = db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, logistic_type, substatus, items_json, actualizado_en, fecha_despacho)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`);
  const hoy = ahora.slice(0, 10);
  const filas = [
    ['ml:QA-PRINTED', 'ml', null, 'QA-PRINTED', 'QA-PRINTED', 'Comprador Impreso', 'self_service', 'printed'],
    ['ml:QA-DELAYED', 'ml', null, 'QA-DELAYED', 'QA-DELAYED', 'Comprador Demorado', 'self_service', 'delayed'],
    ['ml:QA-STALE', 'ml', null, 'QA-STALE', 'QA-STALE', 'Comprador Stale', 'cross_docking', 'stale'],
    ['ml:QA-SIN', 'ml', null, 'QA-SIN', 'QA-SIN', 'Comprador Sin Substatus', 'self_service', null],
    ['ml:QA-LISTO', 'ml', null, 'QA-LISTO', 'QA-LISTO', 'Comprador Ready', 'self_service', 'ready_to_print'],
    ['web:940100', 'web', 940100, null, '940100', 'Cliente Web', null, null],
  ];
  for (const f of filas) ins.run(f[0], f[1], f[2], f[3], f[4], f[5], fecha, f[6], f[7], items, ahora, hoy);
  db.close();

  const estado = { pid: server.pid, port, url: `http://127.0.0.1:${port}/preparacion/`, login: `http://127.0.0.1:${port}/login/`,
    usuario: 'qa-e4-admin', credenciales: path.join(dir, 'credenciales.txt'), db: dbPath, log: path.join(dir, 'server.log'),
    commit: (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(),
    sembradas: filas.map((f) => f[0]) };
  fs.writeFileSync(estadoPath, JSON.stringify(estado, null, 2));
  console.log(JSON.stringify(estado, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'down') await down();
else { console.error('uso: e4-entorno.mjs up|down'); process.exit(2); }
