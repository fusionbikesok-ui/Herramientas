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
 *  15a  Conciliación de stock: create recepción con ítem, provocar conflicto, llamar resolver-conflicto
 *  15b  familia_variable + paginación: >100 variaciones mockeadas, validar paginación y rechazo de duplicados
 *  15c  sync_ml con 3 motivos: vínculo verificado / NULL legado / vínculo inconsistente
 *  15d  Sin sesión: contexto fresco sin cookies, assert 401/403
 *  15e  axe-core real: correr a verdad, fallar ante critical/serious
 *  16-17 capturar pageerror/consola/HTTP>=500 y fallar ante cualquiera; repetir en 360/390/768/1440
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

// NOTA sobre patchCount: cada PATCH a Woo es una operación de stock real. En pasos donde
// el stock NO debe tocarse (p.ej. retomar, "solo documento"), patchCount no debe crecer.
// Esto verifica que el sistema no toca stock donde no debe.
const stats = {
  woo: { getProducts: 0, getProduct: {}, getCategories: 0, post: 0, patch: {}, patchCount: 0, getVariations: 0 },
  ml: { calls: 0 }
};

// ids de producto Woo cuya PRIMER lectura de verificación (GET /products/:id inmediatamente
// después del POST de creación) debe fallar, para simular una "operación de stock incierta"
// (POST que sí llegó a Woo, pero cuya confirmación se pierde). Se consume una sola vez por id.
const failVerifyOnce = new Set();

// Variaciones reales creadas durante la corrida (familia_variable / variacion_existente),
// para poder servir GET/PATCH de verificación sobre /products/:id/variations/:variationId.
const variacionesCreadas = new Map();

// stock_quantity real por id de producto: aplicarStockItem hace PATCH y luego un GET de
// verificación esperando ver reflejado el nuevo valor — sin este estado persistente el GET
// devolvía siempre 0 y toda operación de stock quedaba en 'conflicto_stock' falso.
const stockPorId = new Map([[100, 4]]);

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
  // Estado interno del mock: producto variable padre (id 3000) con >100 variaciones mockeadas.
  // Primera llamada a /variations: devuelve 100, segunda devuelve el resto, tercera 404.
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
        { id: 100, name: 'Casco Alpha', sku: 'CASCO-ALPHA-001', stock_quantity: 4, type: 'simple' },
        { id: 3000, name: 'Casco Variable Padre', sku: 'CASCO-VAR-PADRE', type: 'variable' }
      ]));
    }

    const prodMatch = pathname.match(/^\/wp-json\/wc\/v3\/products\/(\d+)$/);
    const variationsMatch = pathname.match(/^\/wp-json\/wc\/v3\/products\/(\d+)\/variations$/);
    const variationDetailMatch = pathname.match(/^\/wp-json\/wc\/v3\/products\/(\d+)\/variations\/(\d+)$/);

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
            stock_quantity: data.stock_quantity || 0, status: 'draft', type: data.type || 'simple'
          }));
        } catch (e) {
          return res.writeHead(400).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /products/:id/variations — crea una variación nueva bajo el padre familia_variable
    if (req.method === 'POST' && variationsMatch) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const parentId = parseInt(variationsMatch[1]);
          const id = 9000 + (variacionesCreadas.size + 1);
          const variacion = {
            id, name: data.name || 'Variation', sku: data.sku || '',
            stock_quantity: data.stock_quantity || 0, status: 'draft',
            manage_stock: true, parent_id: parentId, attributes: data.attributes || []
          };
          variacionesCreadas.set(id, variacion);
          return res.end(JSON.stringify(variacion));
        } catch (e) {
          return res.writeHead(400).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET/PATCH /products/:id/variations/:variationId — verificación/finalización de SKU
    if (variationDetailMatch) {
      const variationId = parseInt(variationDetailMatch[2]);
      const variacion = variacionesCreadas.get(variationId);
      if (!variacion) return res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      if (req.method === 'GET') return res.end(JSON.stringify(variacion));
      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.sku !== undefined) variacion.sku = data.sku;
            if (data.status !== undefined) variacion.status = data.status;
            if (data.stock_quantity !== undefined) variacion.stock_quantity = data.stock_quantity;
            stats.woo.patchCount++;
            return res.end(JSON.stringify(variacion));
          } catch (e) {
            return res.writeHead(400).end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
    }

    // GET /products/:id/variations con paginación (máx 100 por página)
    if (req.method === 'GET' && variationsMatch) {
      const parentId = parseInt(variationsMatch[1]);
      if (parentId === 3000) {
        stats.woo.getVariations++;
        const page = Number(url.searchParams.get('page') || '1');
        const perPage = Number(url.searchParams.get('per_page') || '100');

        // Generar >100 variaciones mockeadas (101 total)
        const allVariations = Array.from({ length: 101 }, (_, i) => ({
          id: 3000 + i + 1,
          name: `Variación ${i + 1}`,
          sku: `VAR-${String(i + 1).padStart(3, '0')}`,
          attributes: [
            { name: 'Talle', option: `${i % 5 === 0 ? 'XS' : i % 5 === 1 ? 'S' : i % 5 === 2 ? 'M' : i % 5 === 3 ? 'L' : 'XL'}` },
            { name: 'Color', option: `${['Rojo', 'Azul', 'Verde', 'Negro', 'Blanco'][i % 5]}` }
          ]
        }));

        // Paginar según request
        const start = (page - 1) * perPage;
        const paginated = allVariations.slice(start, start + perPage);
        return res.end(JSON.stringify(paginated));
      }
      return res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
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
      if (id === 100) return res.end(JSON.stringify({ id, name: 'Casco Alpha', sku: 'CASCO-ALPHA-001', stock_quantity: stockPorId.get(100) ?? 4, manage_stock: true, status: 'publish' }));
      if (id === 3000) return res.end(JSON.stringify({ id, name: 'Casco Variable Padre', sku: 'CASCO-VAR-PADRE', type: 'variable', status: 'draft' }));
      if (id >= 200) return res.end(JSON.stringify({ id, name: 'New Product', sku: `FB-${id}`, stock_quantity: stockPorId.get(id) ?? 0, manage_stock: true, status: 'draft' }));
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
          if (data.stock_quantity !== undefined) stockPorId.set(id, data.stock_quantity);
          const stockActual = stockPorId.get(id) ?? 0;
          return res.end(JSON.stringify({ id, name: 'Updated', sku: data.sku || `FB-${id}`, stock_quantity: stockActual, manage_stock: data.manage_stock || true, status: 'draft' }));
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

// Ninguna llamada de red/browser en este script tiene garantía de resolver sola (page.evaluate
// no tiene timeout propio, y un fetch colgado del lado del servidor cuelga todo el proceso
// indefinidamente — ya pasó una vez con el paso 15d). Cualquier await a una operación de red o
// de página debe pasar por acá.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} excedió ${ms}ms`)), ms))
  ]);
}

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

// Paso 15a: Conciliación de stock (rutas reales)
async function verificarConciliacionStock(page, db, errors) {
  console.log('  Paso 15a: Conciliación de stock (rutas reales)');
  const errorsAntes = errors.length;

  // Crear una recepción con un ítem que tenga match a id_woo=100 (CASCO-ALPHA-001)
  const now = new Date().toISOString();
  let recId, itemId;
  try {
    db.prepare(`
      INSERT INTO recepciones(proveedor, fecha, estado, creado_en)
      VALUES(?, ?, ?, ?)
    `).run('Proveedor Test Conciliacion', '2026-09-22', 'borrador', now);

    // Obtener el último ID insertado
    const recRow = db.prepare('SELECT last_insert_rowid() as id').get();
    recId = recRow.id;
    if (!recId) throw new Error('recId no asignado');

    db.prepare(`
      INSERT INTO recepcion_items(recepcion_id, sku, nombre_doc, codigo_proveedor, cantidad, id_woo, recibido, creado_en, estado_item)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recId, 'CASCO-ALPHA-001', 'Casco Alpha', 'PROV-001', 1, 100, 1, now, null);

    const itemRow = db.prepare('SELECT last_insert_rowid() as id').get();
    itemId = itemRow.id;
    if (!itemId) throw new Error('itemId no asignado');
  } catch (e) {
    throw new Error(`Paso 15a FALLÓ al crear recepción/ítem: ${e.message} (recId=${recId}, itemId=${itemId})`, { cause: e });
  }

  // Forzar estado_item a 'conflicto_stock' para ejercitar resolver-conflicto
  db.prepare(`UPDATE recepcion_items SET estado_item=?, stock_objetivo=? WHERE id=?`)
    .run('conflicto_stock', 5, itemId);

  // Llamar a stock-actual-woo para traer el stock real de Woo
  const stockResp = await page.evaluate(async ({ recId, itemId }) => {
    const r = await fetch(`/api/recepciones/${recId}/items/${itemId}/stock-actual-woo`);
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { recId, itemId });

  assert(stockResp.status === 200, `Paso 15a FALLÓ: stock-actual-woo no respondió 200: ${stockResp.status}`);
  assert(stockResp.data.ok === true, `Paso 15a FALLÓ: stock-actual-woo no tuvo éxito: ${JSON.stringify(stockResp.data)}`);
  assert(stockResp.data.stock_actual === 4, `Paso 15a FALLÓ: stock_actual esperado 4, obtuvo ${stockResp.data.stock_actual}`);
  console.log(`    ✓ stock-actual-woo devolvió stock real: ${stockResp.data.stock_actual}`);

  // Llamar a resolver-conflicto con decision y motivo
  const resolverResp = await page.evaluate(async ({ recId, itemId }) => {
    const r = await fetch(`/api/recepciones/${recId}/items/${itemId}/resolver-conflicto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'aceptar_woo', motivo: 'prueba de conciliación' })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { recId, itemId });

  assert(resolverResp.status === 200, `Paso 15a FALLÓ: resolver-conflicto no respondió 200: ${resolverResp.status}`);
  assert(resolverResp.data.ok === true, `Paso 15a FALLÓ: resolver-conflicto no tuvo éxito: ${JSON.stringify(resolverResp.data)}`);
  console.log(`    ✓ resolver-conflicto respondió ok, estado: ${resolverResp.data.estado}, stock_nuevo: ${resolverResp.data.stock_nuevo}`);

  // Verificar que no hay errores inesperados
  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409/.test(e));
  if (inesperados.length) throw Error(`Paso 15a FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

// Paso 15b: familia_variable con paginación >100 variaciones
async function verificarFamiliaVariablePaginacion(page, db, errors) {
  console.log('  Paso 15b: familia_variable con paginación >100 variaciones');
  const errorsAntes = errors.length;

  // El mock ya tiene un padre 'variable' real (id 3000, sku CASCO-VAR-PADRE) con 101
  // variaciones (Talle x Color combinados) devueltas paginadas por
  // GET /products/3000/variations (100 + 1). Ejercitamos el chequeo real de
  // crearBorradorWoo con modo='variacion_existente' contra ese padre:
  //  1) una combinación NUEVA (no está entre las 101 mockeadas) debe poder crearse (ok:true)
  //     y el chequeo de duplicados debe haber paginado más de una vez (>100 variaciones).
  //  2) la MISMA combinación que ya existe en la variación mockeada #1 (Talle=XS, Color=Rojo,
  //     ver el generador del mock: i=0 → XS/Rojo) debe ser rechazada (ok !== true).
  const variationsAntes = stats.woo.getVariations;

  const opNueva = crypto.randomUUID();
  const fichaNueva = {
    modo: 'variacion_existente',
    titulo: 'Variación Nueva Combinación',
    marca: 'MarcaTest',
    categoria_id: 10,
    categoria_nombre: 'Cascos',
    precio: '200',
    descripcion: '',
    parent_id: 3000,
    atributos: [
      { nombre: 'Talle', valor: 'Talle-Inexistente' },
      { nombre: 'Color', valor: 'Dorado' }
    ]
  };
  const respNueva = await page.evaluate(async ({ operationId, ficha }) => {
    const r = await fetch('/api/nuevos-productos/crear-borrador', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: operationId, ficha })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { operationId: opNueva, ficha: fichaNueva });

  assert(respNueva.data.ok === true, `Paso 15b FALLÓ: combinación nueva contra padre familia_variable debía crearse (ok:true), obtuvo: ${JSON.stringify(respNueva)}`);
  assert(stats.woo.getVariations - variationsAntes > 1, `Paso 15b FALLÓ: el chequeo de duplicados no paginó (>100 variaciones exige >1 llamada a /variations, se hicieron ${stats.woo.getVariations - variationsAntes})`);
  console.log(`    ✓ Combinación nueva creada, chequeo de duplicados paginó ${stats.woo.getVariations - variationsAntes} veces contra 101 variaciones`);

  const opDuplicada = crypto.randomUUID();
  const fichaDuplicada = {
    modo: 'variacion_existente',
    titulo: 'Variación Duplicada',
    marca: 'MarcaTest',
    categoria_id: 10,
    categoria_nombre: 'Cascos',
    precio: '200',
    descripcion: '',
    parent_id: 3000,
    atributos: [
      { nombre: 'Talle', valor: 'XS' },
      { nombre: 'Color', valor: 'Rojo' }
    ]
  };
  const respDuplicada = await page.evaluate(async ({ operationId, ficha }) => {
    const r = await fetch('/api/nuevos-productos/crear-borrador', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: operationId, ficha })
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { operationId: opDuplicada, ficha: fichaDuplicada });

  assert(respDuplicada.data.ok !== true, `Paso 15b FALLÓ: combinación YA existente (Talle=XS,Color=Rojo) entre las 101 variaciones debía rechazarse, obtuvo ok:true: ${JSON.stringify(respDuplicada)}`);
  console.log(`    ✓ Combinación duplicada (Talle=XS,Color=Rojo, ya existe en variación mockeada #1) rechazada correctamente`);

  // 400 esperado: el rechazo de la combinación duplicada (routes/nuevosProductos.js mapea
  // el mensaje "combinación de atributos ya existe" a HTTP 400).
  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409|400/.test(e));
  if (inesperados.length) throw Error(`Paso 15b FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

// Paso 15c: sync_ml con 3 motivos (vínculo verificado, NULL legado, inconsistente)
async function verificarSyncMl(page, db, errors) {
  console.log('  Paso 15c: sync_ml con 3 motivos de exclusión de alta');
  const errorsAntes = errors.length;

  const now = new Date().toISOString();

  // verificarAltaCreado (routes/recepciones.js) exige que el id_woo del ítem 'creado' esté en
  // catalogo_cache antes de confiar en su alta — si no está, el ítem queda ok:false y nunca
  // llega a sync_ml. Sembramos los 3 id_woo ficticios usados por los 3 escenarios.
  for (const [idWoo, sku] of [[500001, 'SKU-SYNC-1'], [500002, 'SKU-SYNC-2'], [500003, 'SKU-SYNC-3']]) {
    db.prepare(`
      INSERT OR IGNORE INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en)
      VALUES(?,?,?,?,?,?)
    `).run(idWoo, `Producto ${sku}`, sku, 'simple', 0, now);
  }

  // Escenario 1: vínculo verificado (recepcion_item_id === it.id)
  let recId1;
  try {
    db.prepare(`
      INSERT INTO recepciones(proveedor, fecha, estado, creado_en)
      VALUES(?, ?, ?, ?)
    `).run('Prov SyncML 1', '2026-09-22', 'borrador', now);
    const idRow1 = db.prepare('SELECT last_insert_rowid() as id').get();
    recId1 = idRow1?.id;
    if (!recId1) throw new Error('recId1 no asignado');
  } catch (e) {
    throw new Error(`Paso 15c FALLÓ al crear recepción 1: ${e.message}`, { cause: e });
  }

  const itemId1 = db.prepare(`
    INSERT INTO recepcion_items(recepcion_id, sku, nombre_doc, codigo_proveedor, cantidad, id_woo, recibido, creado_en, estado_item, alta_operation_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recId1, 'SKU-SYNC-1', 'Producto 1', 'P1', 1, 500001, 1, now, 'creado', crypto.randomUUID()).lastInsertRowid;

  // Insertar una alta con vínculo correcto
  const opId1 = db.prepare(`SELECT alta_operation_id FROM recepcion_items WHERE id=?`).get(itemId1).alta_operation_id;
  db.prepare(`
    INSERT INTO recepcion_altas_woo(operation_id, request_hash, estado, modo, creado_por, creado_en, actualizado_en, recepcion_id, recepcion_item_id, id_woo, sku)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opId1, 'hash1', 'creado', 'simple', 'sistema', now, now, recId1, itemId1, 500001, 'SKU-SYNC-1');

  // Escenario 2: NULL legado (recepcion_item_id === null)
  let recId2;
  db.prepare(`
    INSERT INTO recepciones(proveedor, fecha, estado, creado_en)
    VALUES(?, ?, ?, ?)
  `).run('Prov SyncML 2', '2026-09-22', 'borrador', now);
  const idRow2 = db.prepare('SELECT last_insert_rowid() as id').get();
  recId2 = idRow2?.id;

  const itemId2 = db.prepare(`
    INSERT INTO recepcion_items(recepcion_id, sku, nombre_doc, codigo_proveedor, cantidad, id_woo, recibido, creado_en, estado_item, alta_operation_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recId2, 'SKU-SYNC-2', 'Producto 2', 'P2', 1, 500002, 1, now, 'creado', crypto.randomUUID()).lastInsertRowid;

  const opId2 = db.prepare(`SELECT alta_operation_id FROM recepcion_items WHERE id=?`).get(itemId2).alta_operation_id;
  db.prepare(`
    INSERT INTO recepcion_altas_woo(operation_id, request_hash, estado, modo, creado_por, creado_en, actualizado_en, recepcion_id, recepcion_item_id, id_woo, sku)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opId2, 'hash2', 'creado', 'simple', 'sistema', now, now, recId2, null, 500002, 'SKU-SYNC-2');

  // Escenario 3: vínculo inconsistente (recepcion_item_id !== it.id)
  let recId3;
  db.prepare(`
    INSERT INTO recepciones(proveedor, fecha, estado, creado_en)
    VALUES(?, ?, ?, ?)
  `).run('Prov SyncML 3', '2026-09-22', 'borrador', now);
  const idRow3 = db.prepare('SELECT last_insert_rowid() as id').get();
  recId3 = idRow3?.id;

  const itemId3a = db.prepare(`
    INSERT INTO recepcion_items(recepcion_id, sku, nombre_doc, codigo_proveedor, cantidad, id_woo, recibido, creado_en, estado_item, alta_operation_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recId3, 'SKU-SYNC-3', 'Producto 3', 'P3', 1, 500003, 1, now, 'creado', crypto.randomUUID()).lastInsertRowid;

  const itemId3b = db.prepare(`
    INSERT INTO recepcion_items(recepcion_id, sku, nombre_doc, codigo_proveedor, cantidad, id_woo, recibido, creado_en, estado_item)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recId3, 'SKU-SYNC-3B', 'Producto 3B', 'P3B', 1, null, 1, now, 'sin_match').lastInsertRowid;

  const opId3 = db.prepare(`SELECT alta_operation_id FROM recepcion_items WHERE id=?`).get(itemId3a).alta_operation_id;
  db.prepare(`
    INSERT INTO recepcion_altas_woo(operation_id, request_hash, estado, modo, creado_por, creado_en, actualizado_en, recepcion_id, recepcion_item_id, id_woo, sku)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opId3, 'hash3', 'creado', 'simple', 'sistema', now, now, recId3, itemId3b, 500003, 'SKU-SYNC-3');

  // Confirmar las 3 recepciones y verificar sync_ml
  const confirmResp1 = await page.evaluate(async ({ recId }) => {
    const r = await fetch(`/api/recepciones/${recId}/confirmar`, { method: 'POST' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { recId: recId1 });

  assert(confirmResp1.status === 200, `Paso 15c FALLÓ: confirmar recepción 1 no respondió 200: ${confirmResp1.status}`);
  const syncMl1 = confirmResp1.data.sync_ml || [];
  const motivo1 = syncMl1.find(s => s.sku === 'SKU-SYNC-1')?.estado;
  assert(motivo1 === 'excluido_alta', `Paso 15c FALLÓ: escenario 1 motivo esperado 'excluido_alta', obtuvo '${motivo1}'`);
  console.log(`    ✓ Escenario 1 (vínculo verificado): motivo = ${motivo1}`);

  const confirmResp2 = await page.evaluate(async ({ recId }) => {
    const r = await fetch(`/api/recepciones/${recId}/confirmar`, { method: 'POST' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { recId: recId2 });

  assert(confirmResp2.status === 200, `Paso 15c FALLÓ: confirmar recepción 2 no respondió 200: ${confirmResp2.status}`);
  const syncMl2 = confirmResp2.data.sync_ml || [];
  const motivo2 = syncMl2.find(s => s.sku === 'SKU-SYNC-2')?.estado;
  assert(motivo2 === 'excluido_alta_sin_vinculo', `Paso 15c FALLÓ: escenario 2 motivo esperado 'excluido_alta_sin_vinculo', obtuvo '${motivo2}'`);
  console.log(`    ✓ Escenario 2 (NULL legado): motivo = ${motivo2}`);

  const confirmResp3 = await page.evaluate(async ({ recId }) => {
    const r = await fetch(`/api/recepciones/${recId}/confirmar`, { method: 'POST' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { recId: recId3 });

  assert(confirmResp3.status === 200, `Paso 15c FALLÓ: confirmar recepción 3 no respondió 200: ${confirmResp3.status}`);
  const syncMl3 = confirmResp3.data.sync_ml || [];
  const motivo3 = syncMl3.find(s => s.sku === 'SKU-SYNC-3')?.estado;
  assert(motivo3 === 'excluido_alta_vinculo_inconsistente', `Paso 15c FALLÓ: escenario 3 motivo esperado 'excluido_alta_vinculo_inconsistente', obtuvo '${motivo3}'`);
  console.log(`    ✓ Escenario 3 (vínculo inconsistente): motivo = ${motivo3}`);

  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409/.test(e));
  if (inesperados.length) throw Error(`Paso 15c FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

// Paso 15d: Sin sesión (contexto fresco sin cookies)
async function verificarSinSesion(browser, page, errors) {
  console.log('  Paso 15d: Verificar acceso sin sesión (401/403)');
  const errorsAntes = errors.length;

  // Crear contexto fresco sin cookies
  const freshContext = await withTimeout(browser.newContext(), 10000, 'Paso 15d: browser.newContext()');
  const freshPage = await withTimeout(freshContext.newPage(), 10000, 'Paso 15d: newPage()');

  try {
    // /recepcion/ tiene JS propio que redirige a /herramientas/home/ al detectar 401 (ver
    // public/recepcion/index.html:2107), y esa página a su vez puede rebotar más — una carrera
    // de navegaciones que aborta cualquier fetch nuestro en el medio ("Failed to fetch" /
    // "Execution context was destroyed"). /login/ es la única página que NO redirige sola al
    // cargar (solo redirige tras un submit exitoso, que acá nunca ocurre) — mismo origin, sirve
    // igual para probar el fetch relativo sin pelear contra el propio JS de la app.
    await withTimeout(
      freshPage.goto(`http://127.0.0.1:${serverPort}/login/`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null),
      8000, 'Paso 15d: goto /login/'
    );

    const resp = await withTimeout(freshPage.evaluate(async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch('/api/recepciones', { signal: ctrl.signal });
        return { status: r.status, data: await r.json().catch(() => ({})) };
      } finally {
        clearTimeout(t);
      }
    }), 8000, 'Paso 15d: fetch /api/recepciones sin sesión');

    assert([401, 403].includes(resp.status), `Paso 15d FALLÓ: sin sesión debería responder 401/403, obtuvo ${resp.status}`);
    console.log(`    ✓ Sin sesión respondió ${resp.status} (acceso denegado)`);

    // Segunda mitad del punto 15: la página /recepcion/ tampoco debe MOSTRAR datos sin sesión
    // (aunque redirija por su cuenta, verificamos que en ningún momento llega a pintar un dato
    // real de recepción antes de rebotar).
    await withTimeout(
      freshPage.goto(`http://127.0.0.1:${serverPort}/recepcion/`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null),
      8000, 'Paso 15d: goto /recepcion/ (verificar sin datos)'
    );
    await freshPage.waitForTimeout(500).catch(() => {});
    const textoVisible = await withTimeout(
      freshPage.evaluate(() => document.body.innerText).catch(() => ''),
      5000, 'Paso 15d: leer texto de /recepcion/'
    ).catch(() => '');
    assert(!/Proveedor Test|CASCO-ALPHA-001/.test(textoVisible), `Paso 15d FALLÓ: /recepcion/ mostró datos de recepción sin sesión`);
    console.log(`    ✓ /recepcion/ no expone datos de recepción sin sesión`);
  } finally {
    // No await bloqueante: freshPage.close()/freshContext.close() pueden colgarse (visto en
    // producción: 30s de guardia sin disparar en las operaciones de arriba, así que el cuelgue
    // real estaba acá). El cierre final del browser en main() limpia todo de cualquier forma.
    withTimeout(freshPage.close(), 3000, 'freshPage.close()').catch(() => {});
    withTimeout(freshContext.close(), 3000, 'freshContext.close()').catch(() => {});
  }

  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409/.test(e));
  if (inesperados.length) throw Error(`Paso 15d FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

// Paso 15e: axe-core real
async function verificarAxeCore(page, errors) {
  console.log('  Paso 15e: axe-core (análisis de accesibilidad real)');
  const errorsAntes = errors.length;

  try {
    const { AxeBuilder } = await import('@axe-core/playwright');
    const results = await withTimeout(new AxeBuilder({ page }).analyze(), 30000, 'Paso 15e: AxeBuilder.analyze()');

    const violations = (results.violations || []).filter(v => v.impact === 'critical' || v.impact === 'serious');
    assert(violations.length === 0, `Paso 15e FALLÓ: ${violations.length} violaciones critical/serious encontradas:\n${violations.map(v => `  - ${v.id} (${v.impact}): ${v.help}\n${v.nodes.map(n => `      target=${JSON.stringify(n.target)} html=${n.html}`).join('\n')}`).join('\n')}`);
    console.log(`    ✓ axe-core: sin violaciones critical/serious`);
  } catch (e) {
    // Sólo se tolera la ausencia del paquete (entorno sin @axe-core/playwright instalado).
    // Cualquier otro error -- incluida la propia aserción de arriba, o un fallo real de axe.run --
    // debe propagarse: este paso existe para FALLAR ante critical/serious, no para saltearlos.
    if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(e.message)) {
      console.log(`    ⊘ axe-core no instalado (paquete @axe-core/playwright ausente) — paso saltado`);
    } else {
      throw e;
    }
  }

  const nuevos = errors.splice(errorsAntes);
  const inesperados = nuevos.filter((e) => !/502|409/.test(e));
  if (inesperados.length) throw Error(`Paso 15e FALLÓ: se capturaron errores no explicados: ${inesperados.join('; ')}`);
}

async function runE2E(page, width, primeraVez, db, browser) {
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

  // === PASOS 15a-15e (solo en la primera pasada de anchos, no son tests de layout) ===
  if (primeraVez) {
    await verificarConciliacionStock(page, db, errors);
    await verificarFamiliaVariablePaginacion(page, db, errors);
    await verificarSyncMl(page, db, errors);
    // Red de seguridad adicional: si algo dentro de estos dos pasos escapa a sus timeouts
    // internos (ya hubo un cuelgue real de horas acá una vez), esto fuerza la falla igual.
    await withTimeout(verificarSinSesion(browser, page, errors), 30000, 'Paso 15d completo');
    await withTimeout(verificarAxeCore(page, errors), 30000, 'Paso 15e completo');
  }

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

  // Abrir DB de forma persistente para que runE2E pueda escribir en ella
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run('recepcion-e2e', hashPassword('Recepcion-E2E-123!'), 1, 1, now, now);
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run(100, 'Casco Alpha', 'CASCO-ALPHA-001', 'simple', 4, now);
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run(3000, 'Casco Variable Padre', 'CASCO-VAR-PADRE', 'variable', 0, now);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    // @axe-core/playwright exige que la page venga de un context explícito
    // (browser.newPage() es un atajo que crea un context implícito con el que
    // AxeBuilder no puede trabajar: tira "Please use browser.newContext()").
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await context.newPage();
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
      await runE2E(page, width, primeraVez, db, browser);
      primeraVez = false;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✓ E2E COMPLETO: 17 pasos en todos los anchos');
    console.log(`Woo POST (altas creadas): ${stats.woo.post} | Woo PATCH (stock): ${stats.woo.patchCount} | Woo GET categorías: ${stats.woo.getCategories} | ML calls: ${stats.ml.calls}`);
    await page.close();
  } finally {
    db.close();
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
