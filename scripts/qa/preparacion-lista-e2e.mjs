#!/usr/bin/env node
/*
 * scripts/qa/preparacion-lista-e2e.mjs — E2E de la pantalla Preparación contra el QA real
 * (http://127.0.0.1:3101, levantado con `qa.sh up`). Cubre el fix del bug "toco una tarjeta y
 * abre otro pedido" (ver commits 02485f4d..4c7a897f en public/preparacion/index.html):
 * lock de 10s ante interacción reciente, aviso flotante de altas sin re-renderizar, y
 * ocultamiento del aviso al entrar al detalle.
 *
 * Uso: node scripts/qa/preparacion-lista-e2e.mjs   (QA arriba, Playwright instalado)
 * Efímero: no modifica el QA salvo por la fila de pedidos_cache que inserta para simular un
 * alta — se limpia sola al final (try/finally).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://127.0.0.1:3101';
const QA_DB = '/opt/fusionbikes/qa/data/fusion.sqlite';
const CLAVE_QA = '/root/.config/fusion-qa/clave';
const LOG_PATH = '/tmp/claude-0/prep-e2e.log';
const SHOT = (n) => `/tmp/claude-0/prep-e2e-${n}.png`;

const lineas = [];
const ok = []; const bad = [];
const log = (...a) => { const s = a.map(String).join(' '); lineas.push(s); console.log(s); };
const chk = (n, c, x = '') => { (c ? ok : bad).push(n); log(c ? 'ok   ' : 'FALLA', n, c ? '' : x); };

const PASSWORD = fs.readFileSync(CLAVE_QA, 'utf8').trim();
const USERNAME = 'Matias';

let db; let navegador; let claveInsertada = null;

try {
  db = new Database(QA_DB);

  // Fila base para el alta simulada (estructura real de pedidos_cache); la identidad del
  // pedido que se usa para las pruebas de buscador/tap se toma de la primera tarjeta
  // REALMENTE renderizada en el DOM (ver abajo) — así el test nunca asume qué filtro de
  // elegibilidad aplica pedidosElegiblesOrdenados().
  const plantilla = db.prepare("SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' AND canal='ml' ORDER BY fecha ASC LIMIT 1").get();
  if (!plantilla) throw new Error('no hay pedidos pendientes de canal ml en el snapshot QA para usar de plantilla');

  navegador = await chromium.launch({ chromiumSandbox: false });

  async function correrEnViewport(nombre, viewport, { isMobile, hasTouch }) {
    log(`\n=== ${nombre} (${viewport.width}x${viewport.height}) ===`);
    const context = await navegador.newContext({ viewport, isMobile, hasTouch });
    const page = await context.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    // Login vía API — el context.request comparte cookies con las páginas del mismo context.
    const resLogin = await context.request.post(`${BASE}/api/auth/login`, { data: { username: USERNAME, password: PASSWORD } });
    chk(`${nombre}: login admin (${USERNAME})`, resLogin.ok(), `status ${resLogin.status()} — ${await resLogin.text().catch(() => '')}`);

    await page.goto(`${BASE}/preparacion/`);
    await page.waitForSelector('.ped-grid .ped', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    chk(`${nombre}: lista carga sin errores de consola`, errores.length === 0, errores.join(' | '));

    const primeraCard = page.locator('.ped-grid .ped').first();
    chk(`${nombre}: al menos una tarjeta pendiente renderizada`, await primeraCard.count() > 0);
    if (await primeraCard.count() === 0) { await context.close(); return; }

    const numTxt = (await primeraCard.locator('.ped-num').innerText()).replace(/^#/, '').trim();
    const cliTxt = (await primeraCard.locator('.ped-cli').innerText()).split(' · ')[0].trim();
    log(`${nombre}: pedido base tomado del DOM — número="${numTxt}" comprador="${cliTxt}"`);

    // ── buscador ──
    const buscador = page.locator('input.pend-buscador');
    chk(`${nombre}: buscador presente`, await buscador.count() > 0);
    if (await buscador.count() > 0) {
      const ultimosDigitos = numTxt.slice(-5);
      await buscador.fill(ultimosDigitos);
      await page.waitForTimeout(150);
      let visibles = await page.locator('.ped-grid .ped:not(.oculto)').count();
      chk(`${nombre}: buscador filtra por últimos dígitos del número (${ultimosDigitos})`, visibles >= 1 && visibles < 50, `visibles=${visibles}`);

      await buscador.fill(numTxt);
      await page.waitForTimeout(150);
      visibles = await page.locator('.ped-grid .ped:not(.oculto)').count();
      chk(`${nombre}: buscador filtra por el número/pack completo (${numTxt})`, visibles >= 1, `visibles=${visibles}`);

      const comprador1palabra = cliTxt.split(' ')[0];
      await buscador.fill(comprador1palabra);
      await page.waitForTimeout(150);
      visibles = await page.locator('.ped-grid .ped:not(.oculto)').count();
      chk(`${nombre}: buscador filtra por comprador (${comprador1palabra})`, visibles >= 1, `visibles=${visibles}`);

      await buscador.fill('');
      await page.waitForTimeout(150);
    }

    // ── tocar una tarjeta y verificar que abre ESE pedido ──
    const card = page.locator('.ped-grid .ped').first();
    await card.click();
    await page.waitForFunction(() => document.querySelector('#cuerpo h1'), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    const h1 = await page.locator('#cuerpo h1').first().innerText().catch(() => '');
    // La primera p.sub puede ser "Orden ML ..." (cuando pack_id!=numero_pedido); el comprador
    // es la que NO tiene ese prefijo.
    const comp = await page.locator('#cuerpo p.sub').filter({ hasNotText: /^Orden ML/ }).first().innerText().catch(() => '');
    chk(`${nombre}: el detalle abierto es el mismo pedido tocado (número)`, h1.includes(numTxt), `h1="${h1}"`);
    // No se compara comp===cliTxt como pass/fail: en el snapshot anonimizado el nombre de
    // comprador se reemplaza de forma independiente en pedidos_cache y en preparaciones
    // (confirmado: "Comprador <id de fila>" en cada tabla), así que puede diferir sin que sea
    // un bug de la app — el número/pack de arriba es la comparación que importa.
    log(`${nombre}: comprador en lista="${cliTxt}" vs comprador en detalle="${comp.trim()}" (informativo — puede diferir por anonimización independiente por tabla)`);
    if (nombre.includes('360')) {
      const box = await page.locator('#cuerpo h1').first().boundingBox();
      const boxComp = await page.locator('#cuerpo p.sub').filter({ hasNotText: /^Orden ML/ }).first().boundingBox();
      chk(`${nombre}: número/comprador visibles sin scroll (dentro de ${viewport.height}px)`, !!box && !!boxComp && boxComp.y + boxComp.height <= viewport.height, JSON.stringify({ box, boxComp }));
    }
    await page.locator('#cuerpo button:has-text("Cola")').first().click().catch(() => {});
    await page.waitForTimeout(400);

    // ── lock + alta simulada + aviso flotante ──
    await page.waitForSelector('.ped-grid .ped', { timeout: 10000 }).catch(() => {});
    const posicionesAntes = await page.$$eval('.ped-grid .ped', (els) => els.map((e) => ({ clave: e.getAttribute('data-search'), top: e.getBoundingClientRect().top })));

    if (hasTouch) {
      const box = await page.locator('.ped-grid').boundingBox();
      if (box) await page.touchscreen.tap(box.x + 10, box.y + 10);
    } else {
      await page.mouse.move(50, 50);
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.waitForTimeout(100);

    // Alta simulada: inserto una fila nueva en pedidos_cache (mismo mecanismo que usa el sync
    // real de ML/Woo al escribir la caché) y disparo el poll manualmente para no esperar 25s.
    claveInsertada = `ml:qa-e2e-${Date.now()}`;
    db.prepare(`INSERT INTO pedidos_cache (clave,canal,wc_order_id,ml_order_id,numero_pedido,comprador,fecha,estado_envio,estado_wc,espejo_ml,logistic_type,substatus,items_json,actualizado_en,pack_id,customer_note,fecha_despacho,fecha_despacho_limite,estado_despacho,despacho_motivo,shipment_limite_original)
      VALUES (@clave,@canal,@wc_order_id,@ml_order_id,@numero_pedido,@comprador,@fecha,@estado_envio,@estado_wc,@espejo_ml,@logistic_type,@substatus,@items_json,@actualizado_en,@pack_id,@customer_note,@fecha_despacho,@fecha_despacho_limite,@estado_despacho,@despacho_motivo,@shipment_limite_original)`).run({
      ...plantilla, clave: claveInsertada, ml_order_id: claveInsertada, numero_pedido: `E2E-${Date.now()}`, pack_id: null,
      comprador: 'Comprador E2E prueba', fecha: new Date().toISOString(), actualizado_en: new Date().toISOString(),
    });

    await page.evaluate(() => window.cargarDatosSilenciosos && window.cargarDatosSilenciosos());
    await page.waitForTimeout(400);

    const avisoVisible = await page.locator('#pend-aviso-nuevos').isVisible().catch(() => false);
    chk(`${nombre}: aviso de pedidos nuevos aparece tras el alta durante el lock`, avisoVisible);

    const posicionesDespues = await page.$$eval('.ped-grid .ped', (els) => els.map((e) => ({ clave: e.getAttribute('data-search'), top: e.getBoundingClientRect().top })));
    const mismoOrden = posicionesAntes.length === posicionesDespues.length
      && posicionesAntes.every((p, i) => p.clave === posicionesDespues[i]?.clave && Math.abs(p.top - posicionesDespues[i].top) < 1);
    chk(`${nombre}: las tarjetas mantienen orden y offsetTop bajo el lock (no se re-renderizan)`, mismoOrden, JSON.stringify({ antes: posicionesAntes.length, despues: posicionesDespues.length }));

    await page.screenshot({ path: SHOT(`${nombre}-aviso`) });

    // ── abrir detalle oculta el aviso ──
    if (await card.count() > 0) {
      await card.click();
      await page.waitForTimeout(400);
      const avisoTrasDetalle = await page.locator('#pend-aviso-nuevos').isVisible().catch(() => false);
      chk(`${nombre}: abrir el detalle oculta el aviso`, !avisoTrasDetalle);
    }

    await page.screenshot({ path: SHOT(nombre) });

    // limpieza de la fila insertada antes del siguiente viewport
    db.prepare('DELETE FROM pedidos_cache WHERE clave=?').run(claveInsertada);
    claveInsertada = null;

    await context.close();
  }

  await correrEnViewport('360', { width: 360, height: 740 }, { isMobile: true, hasTouch: true });
  await correrEnViewport('1280', { width: 1280, height: 800 }, { isMobile: false, hasTouch: false });

  log(`\n${ok.length} ok, ${bad.length} fallas`);
} finally {
  if (claveInsertada) { try { db?.prepare('DELETE FROM pedidos_cache WHERE clave=?').run(claveInsertada); } catch {} }
  await navegador?.close().catch(() => {});
  db?.close();
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, lineas.join('\n') + '\n');
}
process.exit(bad.length ? 1 : 0);
