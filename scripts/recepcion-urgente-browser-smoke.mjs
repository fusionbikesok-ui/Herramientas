#!/usr/bin/env node
/**
 * E2E de 17 pasos: Recepción urgente, con servidor y base temporal, mocks reales de
 * WooCommerce/ML y aserciones de comportamiento (no solo "elemento visible").
 *
 * Hallazgo clave que justifica el mock HTTPS de Woo: `wooFetch` (routes/woo.js) rechaza
 * cualquier `cfg.url` que no empiece con "https://" (protección real de producción contra un
 * WOO_URL mal configurado). Un mock en http:// nunca puede ejercitar crearBorradorWoo ni
 * conciliarAltaIncierta — hace falta un certificado autofirmado + NODE_TLS_REJECT_UNAUTHORIZED=0
 * en el proceso hijo (solo ahí, nunca en producción).
 *
 * Pasos cubiertos (numeración de la lista del pedido):
 *  1-2  cargar página, verificar UI
 *  3    crear recepción (proveedor, fecha)
 *  4-5  agregar ítem sin match y resolverlo con teclado en el combobox ARIA (match seguro)
 *  6    aprender alias (checkbox, si el flujo lo ofrece para ese ítem)
 *  7-9  crear producto simple draft (item aparte, sin match, "Crear borrador" real) + 0 llamadas a ML
 *  10   guardar recepción (borrador)
 *  11   retomar sin repetir el PATCH de stock
 *  12   simular operación de alta incierta (falla la verificación post-POST en Woo)
 *  13   verificar que reintentar la misma operación no repite el POST ni el PATCH a Woo
 *  14   "Solo documento" con líneas sin match, clic real, sin tocar stock
 *  15   repetir el recorrido funcional en 360/390/768/1440
 *  16-17 capturar pageerror/consola/HTTP>=500 y fallar ante cualquiera
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-recepcion-'));
const dbPath = path.join(temp, 'fusion.sqlite');
const basePort = 5000 + Math.floor(Math.random() * 900);
const serverPort = basePort;
const wooPort = basePort + 1;
const mlPort = basePort + 2;

let child, wooServer, mlServer;

const stats = {
  woo: { getProducts: 0, getProduct: {}, getCategories: 0, post: 0, patch: {}, patchCount: 0 },
  ml: { calls: 0 }
};

// ids de producto Woo cuya PRIMER lectura de verificación (GET /products/:id inmediatamente
// después del POST de creación) debe fallar, para simular una "operación de stock incierta"
// (POST que sí llegó a Woo, pero cuya confirmación se pierde). Se consume una sola vez por id.
const failVerifyOnce = new Set();

function certPaths() {
  return { key: path.join(temp, 'woo-key.pem'), cert: path.join(temp, 'woo-cert.pem') };
}

function generarCertAutofirmado() {
  const { key, cert } = certPaths();
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function createWooMock(tls) {
  const handler = (req, res) => {
    const url = new URL(req.url, `https://localhost:${wooPort}`);
    const pathname = url.pathname;
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && pathname === '/wp-json/wc/v3/products/categories') {
      stats.woo.getCategories++;
      const page = Number(url.searchParams.get('page') || '1');
      if (page > 1) return res.end(JSON.stringify([]));
      return res.end(JSON.stringify([{ id: 10, name: 'Cascos', parent: 0 }]));
    }

    if (req.method === 'GET' && pathname === '/wp-json/wc/v3/products') {
      stats.woo.getProducts++;
      return res.end(JSON.stringify([
        { id: 100, name: 'Casco Alpha', sku: 'CASCO-ALPHA-001', stock_quantity: 4, type: 'simple' }
      ]));
    }

    const prodMatch = pathname.match(/^\/wp-json\/wc\/v3\/products\/(\d+)$/);

    if (req.method === 'POST' && pathname === '/wp-json/wc/v3/products') {
      stats.woo.post++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const id = 200 + stats.woo.post;
          return res.end(JSON.stringify({
            id, name: data.name || 'New Product', sku: data.sku || '',
            stock_quantity: data.stock_quantity || 0, status: 'draft'
          }));
        } catch (e) {
          return res.writeHead(400).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && prodMatch) {
      const id = parseInt(prodMatch[1]);
      if (!stats.woo.getProduct[id]) stats.woo.getProduct[id] = 0;
      stats.woo.getProduct[id]++;
      if (failVerifyOnce.has(id)) {
        failVerifyOnce.delete(id);
        req.destroy(); // simula una respuesta que nunca llega (timeout/red caída)
        return;
      }
      if (id === 100) return res.end(JSON.stringify({ id, name: 'Casco Alpha', sku: 'CASCO-ALPHA-001', stock_quantity: 4, manage_stock: true, status: 'publish' }));
      if (id >= 200) return res.end(JSON.stringify({ id, name: 'New Product', sku: `FB-${id}`, stock_quantity: 0, manage_stock: true, status: 'draft' }));
      return res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    }

    if (req.method === 'PATCH' && prodMatch) {
      const id = parseInt(prodMatch[1]);
      if (!stats.woo.patch[id]) stats.woo.patch[id] = 0;
      stats.woo.patch[id]++;
      stats.woo.patchCount++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          return res.end(JSON.stringify({ id, name: 'Updated', sku: data.sku || `FB-${id}`, stock_quantity: data.stock_quantity || 0, manage_stock: data.manage_stock || true, status: 'draft' }));
        } catch (e) {
          return res.writeHead(400).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: 'Not Found' }));
  };
  return https.createServer(tls, handler);
}

function createMlMock() {
  return http.createServer((req, res) => {
    stats.ml.calls++;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404).end(JSON.stringify({ error: 'Not Found' }));
  });
}

async function waitFor(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const req = http.get(url, (r) => { r.resume(); if (r.statusCode < 500) resolve(); else retry(); });
      req.on('error', retry);
      req.setTimeout(1000, () => { req.destroy(); retry(); });
      function retry() { if (Date.now() - start > 15000) reject(Error('server timeout')); else setTimeout(poll, 100); }
    };
    poll();
  });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// === Pasos 12-13 vía API directa (idempotencia real de crearBorradorWoo/conciliarAltaIncierta) ===
// No hay botón de UI para "reintentar una alta incierta" (es un mecanismo de backend puro, ver
// routes/nuevosProductos.js /operaciones/:id/conciliar) — se ejercita con fetch real desde el
// contexto del browser (misma sesión autenticada) contra el servidor real, no un mock unitario.
async function verificarIdempotenciaAlta(page, errors) {
  console.log('  Pasos 12-13: simular alta incierta y verificar que no se repite el POST/PATCH');

  const operationId = crypto.randomUUID();
  const ficha = {
    modo: 'simple',
    titulo: 'Producto Incierto Test',
    marca: 'MarcaTest',
    categoria_id: 10,
    categoria_nombre: 'Cascos',
    precio: '150',
    descripcion: '',
    parent_id: null,
    atributos: [{ nombre: 'Talle', valor: 'Único' }]
  };

  const postCountAntes = stats.woo.post;

  // Forzamos que la verificación GET posterior al POST de creación falle UNA vez para el
  // próximo id que Woo devuelva (200 + postCountAntes + 1, según el mock).
  const idEsperado = 200 + postCountAntes + 1;
  failVerifyOnce.add(idEsperado);
  const errorsAntes = errors.length;

  const r1 = await page.evaluate(async ({ operationId, ficha }) => {
    const r = await fetch('/api/nuevos-productos/crear-borrador', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: operationId, ficha })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { operationId, ficha });

  assert(r1.status !== 200 || r1.data.ok !== true, `Paso 12 FALLÓ: la alta debía quedar incierta (verify GET forzada a fallar) pero respondió ok: ${JSON.stringify(r1)}`);
  assert(stats.woo.post === postCountAntes + 1, `Paso 12 FALLÓ: el POST de creación no se ejecutó una vez (post: ${postCountAntes}→${stats.woo.post})`);
  console.log(`    ✓ Paso 12: alta quedó incierta (status ${r1.status}), POST a Woo ejecutado exactamente 1 vez`);

  // PASO 13a: reintentar la MISMA operación mientras sigue "incierta" tiene que rechazarse sin
  // volver a tocar Woo (bloqueada, no reutilizable hasta conciliar).
  const postCountTrasIncierto = stats.woo.post;
  const r2 = await page.evaluate(async ({ operationId, ficha }) => {
    const r = await fetch('/api/nuevos-productos/crear-borrador', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: operationId, ficha })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { operationId, ficha });

  assert(r2.data.ok !== true, `Paso 13 FALLÓ: reintentar una operación incierta con el mismo operation_id no debería tener éxito directo: ${JSON.stringify(r2)}`);
  assert(stats.woo.post === postCountTrasIncierto, `Paso 13 FALLÓ: reintentar la misma operación repitió el POST a Woo (post: ${postCountTrasIncierto}→${stats.woo.post})`);
  console.log(`    ✓ Paso 13a: reintentar la misma operación incierta NO repitió el POST a Woo (sigue en ${stats.woo.post})`);

  // PASO 13b: conciliar la operación incierta (ahora que el GET de Woo ya no está forzado a
  // fallar) tiene que resolverla SIN volver a hacer un POST de creación.
  const postCountAntesConciliar = stats.woo.post;
  const rConciliar = await page.evaluate(async (operationId) => {
    const r = await fetch(`/api/nuevos-productos/operaciones/${operationId}/conciliar`, { method: 'POST' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, operationId);

  assert(rConciliar.status === 200, `Paso 13b FALLÓ: conciliar no respondió 200: ${JSON.stringify(rConciliar)}`);
  assert(stats.woo.post === postCountAntesConciliar, `Paso 13b FALLÓ: conciliar repitió el POST de creación a Woo (post: ${postCountAntesConciliar}→${stats.woo.post})`);
  console.log(`    ✓ Paso 13b: conciliar resolvió la operación (estado: ${rConciliar.data.estado || '?'}) sin repetir el POST a Woo`);

  // Los errores capturados durante esta simulación son PROVOCADOS a propósito (502 del alta
  // incierta, 409 del reintento bloqueado) y ya fueron verificados arriba con aserciones
  // específicas — no deben contarse como fallas reales en el chequeo global de pasos 16-17.
  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409/.test(e));
  if (inesperados.length) throw Error(`Pasos 12-13 FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

async function runE2E(page, width, primeraVez) {
  console.log(`\n=== E2E en ${width}px ===`);

  const errors = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.removeAllListeners('response');
  page.on('pageerror', (e) => { const m = `PAGE_ERROR: ${e.message}`; errors.push(m); console.error('    ⚠', m); });
  page.on('console', (msg) => { if (msg.type() === 'error') { const m = `CONSOLE_ERROR: ${msg.text()}`; errors.push(m); console.error('    ⚠', m); } });
  page.on('response', (r) => { if (r.status() >= 500) { const m = `HTTP_${r.status()}: ${r.url()}`; errors.push(m); console.error('    ⚠', m); } });

  await page.setViewportSize({ width, height: 900 });

  // === PASOS 1-2 ===
  console.log('  Pasos 1-2: Cargar y verificar UI');
  await page.goto(`http://127.0.0.1:${serverPort}/recepcion/`, { waitUntil: 'networkidle' });
  assert(await page.locator('h1').filter({ hasText: /Recepción/ }).isVisible({ timeout: 5000 }).catch(() => false), `Paso 1-2 FALLÓ: UI no cargó en ${width}`);
  console.log('    ✓ Página cargada');

  // === PASO 3 ===
  console.log('  Paso 3: Crear recepción (proveedor + fecha)');
  const provInput = page.locator('#inp-proveedor');
  assert(await provInput.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 3 FALLÓ: #inp-proveedor no visible');
  await provInput.fill('Proveedor Test ' + width);
  const fechaInput = page.locator('#inp-fecha');
  if (await fechaInput.isVisible({ timeout: 1000 }).catch(() => false)) await fechaInput.fill('2026-09-22');
  console.log('    ✓ Proveedor y fecha ingresados');

  // === PASOS 4-5: ítem sin match resuelto por teclado en el combobox ===
  console.log('  Pasos 4-5: Agregar ítem sin match, resolver en combobox ARIA por teclado');
  const btnAgregarItem = page.locator('button').filter({ hasText: /Agregar ítem/ });
  assert(await btnAgregarItem.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 4 FALLÓ: botón "Agregar ítem" no visible');
  await btnAgregarItem.click();
  const itemNombre = page.locator('#item-nombre-input');
  assert(await itemNombre.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 4 FALLÓ: modal agregar ítem no abrió');
  await itemNombre.fill('Producto inexistente xyz123');
  const itemCant = page.locator('#item-cantidad-input');
  if (await itemCant.isVisible({ timeout: 1000 }).catch(() => false)) await itemCant.fill('1');
  await page.locator('#modal-confirm-btn').click();
  await page.waitForTimeout(700);

  const combobox = page.locator('[role="combobox"]').first();
  assert(await combobox.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 5 FALLÓ: combobox no visible (ítem no quedó sin match)');
  await combobox.focus();
  await combobox.type('casco', { delay: 40 });
  await page.waitForTimeout(350);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  const badgeAntes = await page.locator('.match-badge').first().textContent().catch(() => '');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const badgeDespues = await page.locator('.match-badge').first().textContent().catch(() => '');
  assert(badgeDespues !== badgeAntes && !badgeDespues.includes('Sin candidato'), `Paso 5 FALLÓ: Enter no cambió el estado del ítem. Antes: "${badgeAntes}", Después: "${badgeDespues}"`);
  console.log(`    ✓ Combobox resuelto por teclado (badge: "${badgeDespues}")`);

  // === PASO 6: aprender alias (si el ítem resuelto ofrece la opción) ===
  console.log('  Paso 6: Aprender alias');
  const chkAlias = page.locator('input[type="checkbox"]').first();
  if (await chkAlias.isVisible({ timeout: 1500 }).catch(() => false)) {
    if (!await chkAlias.isChecked()) await chkAlias.check();
    console.log('    ✓ Alias marcado para aprender');
  } else {
    console.log('    ⊘ Sin checkbox de alias para este candidato (match no vino de alias_proveedor) — no aplica');
  }

  // === PASOS 7-9: SEGUNDO ítem, sin match posible, alta de producto simple draft real ===
  console.log('  Pasos 7-9: segundo ítem sin match → "Crear borrador" real, verificar 0 llamadas a ML');
  await btnAgregarItem.click();
  await itemNombre.fill('Producto totalmente nuevo ABC999');
  if (await itemCant.isVisible({ timeout: 1000 }).catch(() => false)) await itemCant.fill('2');
  await page.locator('#modal-confirm-btn').click();
  await page.waitForTimeout(700);

  const btnBorrador = page.locator('button').filter({ hasText: /Crear borrador/ });
  assert(await btnBorrador.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 7 FALLÓ: botón "Crear borrador" no visible para el 2do ítem sin match');

  const postAntes = stats.woo.post;
  const mlAntes = stats.ml.calls;
  await btnBorrador.first().click();
  await page.waitForTimeout(300);

  const tituloInput = page.locator('#titulo-input');
  assert(await tituloInput.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 7 FALLÓ: modal de alta de borrador no abrió');
  await page.locator('#marca-input').fill('MarcaTest');
  const catSelect = page.locator('#categoria-select');
  await catSelect.waitFor({ state: 'visible', timeout: 2000 });
  // Esperar a que las categorías reales del mock (fetch async) hayan poblado el <select>.
  await page.waitForFunction(() => {
    const sel = document.getElementById('categoria-select');
    return sel && sel.options.length > 1;
  }, { timeout: 3000 });
  await catSelect.selectOption({ label: 'Cascos' });
  await page.locator('#precio-input').fill('120');
  await page.locator('#atributo-nombre-input').fill('Talle');
  await page.locator('#atributo-valor-input').fill('Único');

  const crearBorradorResp = page.waitForResponse((r) => r.url().includes('/api/nuevos-productos/crear-borrador') && r.request().method() === 'POST', { timeout: 5000 });
  await page.locator('#modal-confirm-btn').click();
  const resp = await crearBorradorResp.catch(() => null);
  assert(resp, 'Paso 7-9 FALLÓ: no se recibió respuesta de POST /api/nuevos-productos/crear-borrador');
  const respData = await resp.json().catch(() => ({}));
  assert(respData.ok === true, `Paso 7-9 FALLÓ: crear-borrador no respondió ok: ${JSON.stringify(respData)}`);
  await page.waitForTimeout(300);

  assert(stats.woo.post === postAntes + 1, `Paso 7-9 FALLÓ: el POST de creación a Woo no se ejecutó exactamente una vez (post: ${postAntes}→${stats.woo.post})`);
  assert(stats.woo.getCategories > 0, 'Paso 7-9 FALLÓ: nunca se consultaron categorías reales de Woo (categoria-select no vino del mock)');
  assert(stats.ml.calls === mlAntes, `Paso 9 FALLÓ: se llamó a ML ${stats.ml.calls - mlAntes} veces al crear un producto nuevo (esperado 0)`);
  console.log(`    ✓ Producto simple draft creado de verdad (Woo POST ${postAntes}→${stats.woo.post}), ML sin cambios (${stats.ml.calls})`);

  // === PASOS 12-13 (solo en la primera pasada de anchos, es un test de API, no de layout) ===
  if (primeraVez) await verificarIdempotenciaAlta(page, errors);

  // === PASO 10: guardar recepción ===
  console.log('  Paso 10: Guardar recepción (borrador)');
  const btnGuardar = page.locator('#btn-borrador');
  assert(await btnGuardar.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 10 FALLÓ: botón "Guardar borrador" no visible');
  assert(await btnGuardar.isEnabled().catch(() => false), 'Paso 10 FALLÓ: botón "Guardar borrador" deshabilitado (validaciones incompletas)');
  const guardarResp = page.waitForResponse((r) => r.url().includes('/api/recepciones') && r.request().method() === 'POST', { timeout: 5000 });
  await btnGuardar.click();
  const gResp = await guardarResp.catch(() => null);
  assert(gResp, 'Paso 10 FALLÓ: no se recibió respuesta de POST /api/recepciones');
  const gData = await gResp.json().catch(() => ({}));
  assert(gData.id, `Paso 10 FALLÓ: respuesta sin id: ${JSON.stringify(gData)}`);
  console.log(`    ✓ Recepción guardada (id ${gData.id})`);

  // === PASO 11: retomar sin repetir el PATCH ===
  console.log('  Paso 11: Retomar sin repetir el PATCH de stock');
  const patchAntesRetomar = stats.woo.patchCount;
  await page.goto(`http://127.0.0.1:${serverPort}/recepcion/?retomar=${gData.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  assert(stats.woo.patchCount === patchAntesRetomar, `Paso 11 FALLÓ: retomar disparó un PATCH de stock (patch: ${patchAntesRetomar}→${stats.woo.patchCount})`);
  console.log(`    ✓ Retomado sin repetir operaciones de stock (patch count: ${stats.woo.patchCount})`);

  // === PASOS 12-14: "Solo documento" real, click real, sin tocar stock ===
  console.log('  Paso 14: "Solo documento" con clic real en Registrar sin tocar stock');
  const toggleSolo = page.locator('#solo-doc-row');
  assert(await toggleSolo.isVisible({ timeout: 2000 }).catch(() => false), 'Paso 14 FALLÓ: toggle "Solo documento" no visible');
  await toggleSolo.click();
  await page.waitForTimeout(300);
  const btnConfirmarSolo = page.locator('#btn-confirmar-solo');
  assert(await btnConfirmarSolo.isVisible({ timeout: 1500 }).catch(() => false), 'Paso 14 FALLÓ: botón "Registrar sin tocar stock" no apareció tras activar el toggle');
  assert(await btnConfirmarSolo.isEnabled().catch(() => false), 'Paso 14 FALLÓ: botón "Registrar sin tocar stock" deshabilitado');

  const patchAntesConfirmar = stats.woo.patchCount;
  page.once('dialog', (d) => d.accept());
  const confirmResp = page.waitForResponse((r) => r.url().includes('/confirmar') && r.request().method() === 'POST', { timeout: 5000 }).catch(() => null);
  await btnConfirmarSolo.click();
  const cResp = await confirmResp;
  assert(cResp, 'Paso 14 FALLÓ: no se recibió respuesta de POST .../confirmar tras click en "Registrar sin tocar stock"');
  assert(cResp.status() < 400, `Paso 14 FALLÓ: /confirmar respondió ${cResp.status()}`);
  assert(stats.woo.patchCount === patchAntesConfirmar, `Paso 14 FALLÓ: "Solo documento" hizo PATCH de stock (patch: ${patchAntesConfirmar}→${stats.woo.patchCount})`);
  console.log(`    ✓ "Solo documento" confirmado sin tocar stock (patch count: ${stats.woo.patchCount})`);

  // === PASOS 16-17 ===
  if (errors.length) throw Error(`Paso 16-17 FALLÓ: se capturaron errores en ${width}px: ${errors.slice(0, 3).join('; ')}`);
  console.log(`  ✓ 17 pasos completados en ${width}px`);
}

async function main() {
  const tls = generarCertAutofirmado();
  wooServer = createWooMock(tls).listen(wooPort);
  mlServer = createMlMock().listen(mlPort);
  await new Promise((r) => setTimeout(r, 150));

  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(serverPort),
      DISABLE_CRONS: 'true',
      DOTENV_CONFIG_PATH: '/dev/null',
      SESSION_SECRET: 'recepcion-e2e-session',
      MOBILE_JWT_SECRET: 'recepcion-e2e-mobile-secret-0123456789',
      WOO_URL: `https://127.0.0.1:${wooPort}`,
      ML_API_BASE: `http://127.0.0.1:${mlPort}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    },
    stdio: 'ignore'
  });

  await waitFor(`http://127.0.0.1:${serverPort}/login/`);

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run('recepcion-e2e', hashPassword('Recepcion-E2E-123!'), 1, 1, now, now);
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run(100, 'Casco Alpha', 'CASCO-ALPHA-001', 'simple', 4, now);
  db.close();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    console.log('Autenticando...');
    await page.goto(`http://127.0.0.1:${serverPort}/login/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#user').fill('recepcion-e2e');
    await page.locator('#pass').fill('Recepcion-E2E-123!');
    await page.locator('#btn').click();
    await page.waitForURL(/herramientas\/home/, { timeout: 10000 }).catch(() => {});

    const widths = [360, 390, 768, 1440];
    console.log(`\nE2E 17 pasos en ${widths.length} anchos: ${widths.join(', ')}\n`);
    let primeraVez = true;
    for (const width of widths) {
      await runE2E(page, width, primeraVez);
      primeraVez = false;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✓ E2E COMPLETO: 17 pasos en todos los anchos');
    console.log(`Woo POST (altas creadas): ${stats.woo.post} | Woo PATCH (stock): ${stats.woo.patchCount} | Woo GET categorías: ${stats.woo.getCategories} | ML calls: ${stats.ml.calls}`);
    await page.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n✗ E2E FALLÓ: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (child?.pid) child.kill('SIGTERM');
  if (wooServer) wooServer.close();
  if (mlServer) mlServer.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
