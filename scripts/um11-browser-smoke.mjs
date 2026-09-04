#!/usr/bin/env node
// E2E aislado de la pantalla "Identidad de productos" (UM1.1). No toca la base real ni ML:
// levanta un server propio contra un sqlite temporal, con DISABLE_CRONS.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';
import { auditarIdentidadProductos, bootstrapProductosFusion } from '../lib/identidadProductos.js';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-um11-browser-'));
const dbPath = path.join(dir, 'demo.sqlite');
const port = 3900 + (process.pid % 90);
let server;

const wait = () => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    http.get(`http://127.0.0.1:${port}/login/`, (r) => {
      r.resume();
      if (r.statusCode < 500) resolve(); else setTimeout(tick, 100);
    }).on('error', () => (Date.now() - start > 15000 ? reject(Error('server timeout')) : setTimeout(tick, 100)));
  };
  tick();
});

try {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), DISABLE_CRONS: 'true',
      DOTENV_CONFIG_PATH: '/dev/null', SESSION_SECRET: 'um11-e2e-session',
      MOBILE_JWT_SECRET: 'um11-browser-mobile-secret-0123456789' },
    stdio: 'ignore',
  });
  await wait();

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)')
    .run('um11-admin', hashPassword('UM11-browser-only-123!'), 1, 1, now, now);
  // Un producto Woo con stock y una clave ML activa con stock y SIN SELLER_SKU: el caso
  // exacto que UM1.1 debe dejar visible como urgencia abierta.
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,img,actualizado_en) VALUES(?,?,?,?,?,?,?)')
    .run(9101, 'Cubierta 29 rodado test', 'FB-9101', 'simple', 6, 'https://img.woo/x.jpg', now);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,seller_custom_field,
     available_quantity,thumbnail,actualizado_en)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('MLA-UM11|VAR-9', 'MLA-UM11', 'VAR-9', 'Cubierta 29 rodado test', 'active', '', 0, 'LEGACY-CUSTOM', 5, 'https://img.ml/x.jpg', now);
  bootstrapProductosFusion(db, 'e2e');
  auditarIdentidadProductos(db, 'e2e', { lecturaConfiable: true });
  const caso = db.prepare("SELECT id,estado FROM identidad_casos WHERE ml_key='MLA-UM11|VAR-9'").get();
  if (!caso) throw Error('la auditoría no creó el caso de prueba');
  db.close();

  const width = Number(process.env.UM11_VIEWPORT_WIDTH || 390);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/identidad-productos') && r.status() >= 400) errores.push(`api ${r.status()} ${r.url()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/login/`);
  await page.locator('#user').fill('um11-admin');
  await page.locator('#pass').fill('UM11-browser-only-123!');
  await page.locator('#btn').click();
  await page.waitForURL(/\/home\//);

  await page.goto(`http://127.0.0.1:${port}/identidad-productos/`);
  await page.getByRole('heading', { name: 'Identidad de productos' }).waitFor();
  // Salud y conciliación visibles antes de tocar nada.
  await page.getByText('Modo shadow', { exact: true }).waitFor();
  await page.getByText('Claves ML activas con stock', { exact: true }).waitFor();
  await page.getByText('Urgentes abiertas', { exact: true }).waitFor();

  // El caso está en la cola y se abre.
  await page.locator('[data-caso]').first().waitFor();
  await page.locator('[data-caso]').first().click();
  await page.getByRole('heading', { name: 'MLA-UM11|VAR-9' }).waitFor();
  await page.getByText('sin atributo', { exact: true }).waitFor();
  // seller_custom_field se muestra pero declarado como no-cobertura.
  const auxiliar = await page.getByText('nunca da cobertura', { exact: false }).isVisible();
  // El aviso de shadow tiene que estar presente en el detalle.
  const avisoShadow = await page.getByText('no se escribe en MercadoLibre', { exact: false }).isVisible();

  // Lista+detalle solo en PC (>850px). En 390 y 768 el caso ocupa la pantalla completa y
  // aparece el botón de volver: a 768 la comparación ML/Woo en dos columnas queda ilegible.
  const unaColumna = width <= 850;
  const colaVisible = await page.locator('.side').isVisible();
  const volverVisible = await page.locator('#volver').isVisible();
  if (unaColumna && colaVisible) throw Error(`en ${width} la cola debería ocultarse detrás del detalle`);
  if (!unaColumna && !colaVisible) throw Error(`en ${width} la cola debería seguir visible`);
  if (unaColumna && !volverVisible) throw Error(`en ${width} falta el botón de volver a la cola`);
  if (!unaColumna && volverVisible) throw Error('en PC no corresponde el botón de volver: la cola está a la vista');

  // Mutación real contra la API, con el sobre obligatorio del contrato.
  const nota = await page.evaluate(async (id) => {
    const d = (await (await fetch(`/api/identidad-productos/casos/${id}`)).json()).data;
    const r = await fetch(`/api/identidad-productos/casos/${id}/notas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: 'e2e-nota-' + id, nota: 'Revisado en E2E',
        expected_version: d.expected_version, evidence_fingerprint: d.evidencia_fingerprint }),
    });
    return { status: r.status, body: await r.json() };
  }, caso.id);
  if (nota.status !== 201 || nota.body.ok !== true) throw Error(`la nota no se guardó: ${JSON.stringify(nota)}`);

  // Vínculo manual por el buscador real de la pantalla, no por la API.
  await page.locator('#vincular').click();
  await page.locator('#q-producto').waitFor();
  await page.locator('#q-producto').fill('Cubierta');
  await page.locator('#buscar').click();
  await page.locator('[data-elegir]').first().waitFor();
  await page.locator('[data-elegir]').first().click();
  // Vista previa obligatoria antes de confirmar: SKU objetivo y stock a publicar.
  await page.getByText('Vista previa del vínculo', { exact: true }).waitFor();
  await page.getByText('FB-9101', { exact: false }).first().waitFor();
  await page.locator('#confirmar-vinculo').click();
  await page.waitForFunction(() => !document.querySelector('#confirmar-vinculo'));
  const trasVinculo = await page.evaluate(async () => ({
    ops: (await (await fetch('/api/identidad-productos/operaciones')).json()).data,
    casos: (await (await fetch('/api/identidad-productos/casos')).json()).data,
  }));
  if (trasVinculo.ops.length !== 1) throw Error(`esperaba 1 operación encolada, hay ${trasVinculo.ops.length}`);
  // En shadow la operación se persiste pero no se ejecuta contra ML.
  if (trasVinculo.ops[0].estado !== 'shadow') throw Error(`en shadow la operación no debe salir a ML: ${trasVinculo.ops[0].estado}`);
  if (trasVinculo.ops[0].sku_objetivo !== 'FB-9101') throw Error(`SKU objetivo inesperado: ${trasVinculo.ops[0].sku_objetivo}`);

  // Las otras tres secciones renderizan.
  for (const [vista, titulo] of [['productos', 'Productos Fusion'], ['operaciones', 'Operaciones'], ['historial', 'Historial']]) {
    await page.locator(`button[data-view="${vista}"]`).click();
    await page.getByRole('heading', { name: titulo, exact: true }).waitFor();
  }
  await page.locator('button[data-view="historial"]').click();
  await page.getByText('nota_agregada', { exact: true }).first().waitFor();

  // Accesibilidad sobre la pantalla real, en este ancho. WCAG 2.2 AA es estándar del proyecto.
  // El caso sigue abierto desde el vínculo; en 390 la cola está oculta detrás del detalle,
  // así que se vuelve a la pestaña y se audita el detalle tal como queda.
  await page.locator('button[data-view="pendientes"]').click();
  await page.getByRole('heading', { name: 'MLA-UM11|VAR-9' }).waitFor();
  await page.addScriptTag({ path: axePath });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length,
      target: v.nodes[0]?.target?.join(' ') }));
  });
  const graves = axe.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (graves.length) throw Error(`axe: violaciones graves ${JSON.stringify(graves)}`);

  const resumen = await page.evaluate(async () => (await (await fetch('/api/identidad-productos/resumen')).json()).data);
  if (!resumen.conciliacion.exacta) throw Error(`conciliación inexacta: ${JSON.stringify(resumen.conciliacion)}`);
  if (errores.length) throw Error(`errores de navegador/API: ${errores.join(' | ')}`);

  console.log(JSON.stringify({ ok: true, e2e: 'UM1.1', viewport: width, caso: caso.id,
    conciliacion: resumen.conciliacion, aviso_shadow: avisoShadow, auxiliar_declarado: auxiliar,
    cola_visible: colaVisible, nota: nota.status, vinculo_por_buscador: true, axe_violaciones: axe,
    operacion: trasVinculo.ops[0].estado }));
  await page.close();
  await browser.close();
} finally {
  if (server?.pid) server.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
}
