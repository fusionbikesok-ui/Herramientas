import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  estadoCooldownMl: vi.fn(() => ({ activo: false, hasta: null })),
}));

import { mlFetch } from '../lib/mlClient.js';
import { coberturaRouter } from '../routes/cobertura.js';
import {
  calcularUniversoPendiente, productosDeMarca, resumenMarcas,
} from '../lib/coberturaCola.js';

const TEST_DB = './test/tmp-cobertura-cola.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } };

function buildApp(db) {
  const app = express();
  app.use(express.json());
  // req.user admin de prueba: requireAdmin (pausar/desvincular) y confirmado_por/sesión por
  // usuario lo necesitan; el enforcement real del permiso 'matcher' vive en server.js, no acá.
  app.use((req, res, next) => { req.user = { id: 1, username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/cobertura', coberturaRouter(db, CFG));
  return app;
}

function seedProducto(db, { id_woo, sku, nombre, marca = 'Metha', stock = 5, precio = 1000 }) {
  db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, marca, precio, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id_woo, nombre, sku, 'simple', stock, marca, precio, new Date().toISOString());
}

function seedMlSinSku(db, { clave, item_id, titulo }) {
  db.prepare(`
    INSERT INTO ml_publicaciones_cache (clave, item_id, titulo, status, actualizado_en)
    VALUES (?,?,?, 'active', ?)
  `).run(clave, item_id, titulo, new Date().toISOString());
}

describe('Cobertura accionable — cola de trabajo', () => {
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('calcularUniversoPendiente excluye vinculados, descartados y hay-que-publicar; incluye salteados', () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pendiente' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Vinculado' });
    seedProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'Descartado' });
    seedProducto(db, { id_woo: 4, sku: 'FB-4', nombre: 'A publicar' });
    seedProducto(db, { id_woo: 5, sku: 'FB-5', nombre: 'Salteado' });

    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('A|', 'FB-2', 'Vinculado', 'confirmar', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en) VALUES (3, 'FB-3', 'Descartado', 'solo_local', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO cobertura_hay_que_publicar (id_woo, sku, nombre, marca, valor, creado_en) VALUES (4, 'FB-4', 'A publicar', 'Metha', 100, ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO cobertura_salteados (id_woo, marca, creado_en) VALUES (5, 'Metha', ?)").run(new Date().toISOString());

    const universo = calcularUniversoPendiente(db);
    const ids = universo.map((p) => p.id_woo).sort();
    expect(ids).toEqual([1, 5]);
    const salteado = universo.find((p) => p.id_woo === 5);
    expect(salteado.salteado_en).toBeTruthy();

    // Mutation testing manual: sin el filtro de confirmados, FB-2 (id_woo=2) reaparecería.
    // Se verifica acá en vez de revertir código, ya que el filtro es una sola línea directa
    // en calcularUniversoPendiente — comentado abajo qué se esperaría si se rompiera:
    // si se sacara `.filter((p) => !confirmados.has(...))`, ids incluiría el 2.
  });

  it('productosDeMarca ordena: no-salteados por stock desc primero, salteados al final', () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Stock bajo', stock: 2 });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Stock alto', stock: 10 });
    seedProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'Salteado', stock: 99 });
    db.prepare("INSERT INTO cobertura_salteados (id_woo, marca, creado_en) VALUES (3, 'Metha', ?)").run(new Date().toISOString());

    const { items, total } = productosDeMarca(db, 'Metha', { limit: 10, offset: 0 });
    expect(total).toBe(3);
    expect(items.map((p) => p.id_woo)).toEqual([2, 1, 3]); // salteado último pese a tener más stock
  });

  it('resumenMarcas agrupa por marca con conteo y valor inmovilizado', () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'A', marca: 'Metha', stock: 2, precio: 100 });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'B', marca: 'Metha', stock: 3, precio: 100 });
    seedProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'C', marca: 'Venzo', stock: 1, precio: 500 });

    const { marcas, total_pendientes, total_valor } = resumenMarcas(db);
    expect(total_pendientes).toBe(3);
    expect(total_valor).toBe(200 + 300 + 500);
    const metha = marcas.find((m) => m.marca === 'Metha');
    expect(metha.conteo).toBe(2);
    expect(metha.valor).toBe(500);
  });

  it('GET /resumen es liviano: no incluye el universo entero de productos', async () => {
    for (let i = 1; i <= 30; i++) seedProducto(db, { id_woo: i, sku: `FB-${i}`, nombre: `Prod ${i}` });
    const res = await request(buildApp(db)).get('/api/cobertura/resumen');
    expect(res.status).toBe(200);
    expect(res.body.total_pendientes).toBe(30);
    expect(res.body.marcas.length).toBeLessThanOrEqual(10); // top 10, no las 30 filas
    expect(JSON.stringify(res.body).length).toBeLessThan(5000); // lejos del 1 MB del endpoint viejo
  });

  it('POST /productos/:id/confirmar — ML ok → estado vinculado', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pedales M520' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pedales Shimano M520' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const res = await request(buildApp(db)).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA1|' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('vinculado');
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get();
    expect(decision.accion).toBe('confirmar');
    expect(decision.sku).toBe('FB-1');
  });

  it('POST /productos/:id/confirmar — ML no responde → decisión igual se guarda (fail-open), estado pendiente_sync', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pedales M520' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pedales Shimano M520' });
    mlFetch.mockResolvedValue({ status: 500, data: { message: 'error ML' } });

    const res = await request(buildApp(db)).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA1|' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pendiente_sync');
    // La decisión se persistió igual — el usuario no se frena.
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get();
    expect(decision).toBeTruthy();
    expect(decision.accion).toBe('confirmar');

    // Mutation testing manual: si la línea `res.json({ ok: true, estado: 'vinculado', ...})`
    // reemplazara la rama del else (o si ambos mensajes fueran iguales), este test lo
    // detectaría porque 'pendiente_sync' !== 'vinculado' — confirmado revirtiendo a mano el
    // if/else (invertir la condición `resultado.ok`) y viendo el test fallar en rojo antes
    // de restaurar.
  });

  it('concurrencia optimista: si otra persona ya confirmó la misma clave con OTRO sku, el 409 dice quién y qué', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pedales M520' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro producto' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pedales Shimano M520' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const appAna = express();
    appAna.use(express.json());
    appAna.use((req, res, next) => { req.user = { id: 1, username: 'ana' }; next(); });
    appAna.use('/api/cobertura', coberturaRouter(db, CFG));

    const appJoaco = express();
    appJoaco.use(express.json());
    appJoaco.use((req, res, next) => { req.user = { id: 2, username: 'joaco' }; next(); });
    appJoaco.use('/api/cobertura', coberturaRouter(db, CFG));

    // Ana confirma primero, contra el producto 1 (sku FB-1).
    const resAna = await request(appAna).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA1|' });
    expect(resAna.status).toBe(200);

    // Joaco, sin saberlo, llega a la misma publicación pero la quiere confirmar contra OTRO
    // producto (FB-2): revalidación ANTES de escribir → 409 con quién y qué, no mudo.
    const resJoaco = await request(appJoaco).post('/api/cobertura/productos/2/confirmar').send({ ml_clave: 'MLA1|' });
    expect(resJoaco.status).toBe(409);
    expect(resJoaco.body.ya_resuelto).toBe(true);
    expect(resJoaco.body.resuelto_por).toBe('ana');
    expect(resJoaco.body.sku).toBe('FB-1');
    // No pisó la decisión de Ana.
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get().sku).toBe('FB-1');
  });

  it('POST /productos/:id/descartar mapea 1:1 a cobertura_exclusiones (solo_local)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const res = await request(buildApp(db)).post('/api/cobertura/productos/1/descartar');
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM cobertura_exclusiones WHERE id_woo = 1').get();
    expect(row.motivo).toBe('solo_local');
  });

  it('DELETE /exclusiones/:id/revertir saca el producto de "solo local" y vuelve a pendiente', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    await request(buildApp(db)).post('/api/cobertura/productos/1/descartar');
    let universo = calcularUniversoPendiente(db);
    expect(universo.find((p) => p.id_woo === 1)).toBeUndefined();

    const res = await request(buildApp(db)).delete('/api/cobertura/exclusiones/1/revertir');
    expect(res.status).toBe(200);
    universo = calcularUniversoPendiente(db);
    expect(universo.find((p) => p.id_woo === 1)).toBeTruthy();
  });

  it('POST /productos/:id/saltear no es terminal: sigue en el universo pendiente', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const res = await request(buildApp(db)).post('/api/cobertura/productos/1/saltear');
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('salteado');
    const universo = calcularUniversoPendiente(db);
    expect(universo.find((p) => p.id_woo === 1)).toBeTruthy(); // sigue pendiente, no desapareció
  });

  it('vinculos/:clave/deshacer — YA efectivizado en ML y ML confirma la desvinculación: revierte local', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku = 'FB-1' WHERE clave = 'MLA1|'").run();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const res = await request(buildApp(db)).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get()).toBeUndefined();
    expect(db.prepare("SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = 'MLA1|'").get().seller_sku).toBeNull();
  });

  it('vinculos/:clave/deshacer — FAIL-CLOSED: si ML no confirma la desvinculación, NO se revierte nada local', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku = 'FB-1' WHERE clave = 'MLA1|'").run();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 500, data: { message: 'ML caído' } });

    const res = await request(buildApp(db)).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(502);
    expect(res.body.fail_closed).toBe(true);
    // Nada cambió localmente: ni la decisión ni el seller_sku cacheado.
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get().accion).toBe('confirmar');
    expect(db.prepare("SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = 'MLA1|'").get().seller_sku).toBe('FB-1');

    // Mutation testing manual: si se sacara el `if (!resultado.ok) return res.status(502)...`
    // (dejando pasar directo al DELETE), este test detectaría el DELETE ejecutado igual —
    // confirmado comentando esa guarda a mano y viendo el test fallar antes de restaurarla.
  });

  it('vinculos/:clave/deshacer — todavía NO efectivizado en ML: revierte local sin llamar a ML', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' }); // seller_sku sigue vacío
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());

    const res = await request(buildApp(db)).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(200);
    expect(mlFetch).not.toHaveBeenCalled(); // nunca se llegó a escribir en ML, no hace falta desvincular
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get()).toBeUndefined();
  });

  it('multi-publicacion/:clave/pausar — FAIL-CLOSED: si ML falla, el status local NO cambia', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    mlFetch.mockResolvedValue({ status: 500, data: { message: 'error' } });

    const res = await request(buildApp(db)).post('/api/cobertura/multi-publicacion/MLA1|/pausar');
    expect(res.status).toBe(502);
    expect(res.body.fail_closed).toBe(true);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1|'").get().status).toBe('active');
  });

  it('multi-publicacion/:clave/pausar — ML confirma: actualiza status local a paused', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const res = await request(buildApp(db)).post('/api/cobertura/multi-publicacion/MLA1|/pausar');
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1|'").get().status).toBe('paused');
  });

  it('multi-publicacion/:clave/marcar-correcta SUPRIME la publicación de la lista (no solo marca un flag)', async () => {
    // Corrección tras hallazgo del revisor: la migración y el pedido del usuario dicen
    // textual "para que no vuelva a aparecer" — el test anterior verificaba un flag que la
    // fila ignoraba (el nombre del test mentía). Ahora se verifica la desaparición real.
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    seedMlSinSku(db, { clave: 'MLA2|', item_id: 'MLA2', titulo: 'X' });
    seedMlSinSku(db, { clave: 'MLA3|', item_id: 'MLA3', titulo: 'X' });
    for (const clave of ['MLA1|', 'MLA2|', 'MLA3|']) {
      db.prepare("UPDATE ml_publicaciones_cache SET seller_sku = 'FB-1' WHERE clave = ?").run(clave);
    }

    let res = await request(buildApp(db)).get('/api/cobertura/multi-publicacion');
    expect(res.body.data[0].publicaciones.map((p) => p.clave).sort()).toEqual(['MLA1|', 'MLA2|', 'MLA3|']);

    await request(buildApp(db)).post('/api/cobertura/multi-publicacion/MLA1|/marcar-correcta');
    res = await request(buildApp(db)).get('/api/cobertura/multi-publicacion');
    const claves = res.body.data[0].publicaciones.map((p) => p.clave);
    expect(claves).not.toContain('MLA1|'); // desapareció, no quedó con un flag
    expect(claves.sort()).toEqual(['MLA2|', 'MLA3|']);

    // Mutation testing manual: si `.filter((pub) => !marcadas.has(pub.clave))` se sacara del
    // map en GET /multi-publicacion (routes/cobertura.js), este test lo detectaría porque
    // MLA1| seguiría en `claves`. Confirmado comentando ese `.filter` a mano y viendo el
    // segundo `expect` fallar (3 publicaciones en vez de 2); restaurado.

    // Si se marcan correctas TODAS las publicaciones del producto, el producto entero
    // deja de aparecer en la lista (no queda nada que revisar).
    await request(buildApp(db)).post('/api/cobertura/multi-publicacion/MLA2|/marcar-correcta');
    await request(buildApp(db)).post('/api/cobertura/multi-publicacion/MLA3|/marcar-correcta');
    res = await request(buildApp(db)).get('/api/cobertura/multi-publicacion');
    expect(res.body.data).toHaveLength(0);
  });

  it('GET /multi-publicacion: sobreventa REAL (stock ML activo > stock WC), no "sin stock en una publicación"', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X', stock: 3 });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    seedMlSinSku(db, { clave: 'MLA2|', item_id: 'MLA2', titulo: 'X' });
    seedMlSinSku(db, { clave: 'MLA3|', item_id: 'MLA3', titulo: 'X' });
    // 3 publicaciones activas con 2 unidades cada una = 6 ofrecidas en ML contra 3 reales en WC.
    for (const clave of ['MLA1|', 'MLA2|', 'MLA3|']) {
      db.prepare("UPDATE ml_publicaciones_cache SET seller_sku = 'FB-1', available_quantity = 2 WHERE clave = ?").run(clave);
    }

    const res = await request(buildApp(db)).get('/api/cobertura/multi-publicacion');
    const producto = res.body.data[0];
    expect(producto.sobreventa).toBe(true); // 6 > 3: sobreventa real
    // Ninguna publicación individual está "sin stock" (todas tienen 2) — si el criterio
    // viejo (available_quantity<=0 por publicación) siguiera activo, ninguna se marcaría
    // en riesgo pese a la sobreventa real del grupo.
    expect(producto.publicaciones.every((p) => p.sin_stock_ml === false)).toBe(true);

    // Mutation testing manual: reemplacé `stockMlActivo > Number(p.stock || 0)` por `false`
    // (código muerto) y corrí este test — `producto.sobreventa` dio `false`, rojo. Restaurado.
  });

  it('GET /solo-ml lista publicaciones sin seller_sku, buscable por título', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Cubierta Maxxis' });
    seedMlSinSku(db, { clave: 'MLA2|', item_id: 'MLA2', titulo: 'Pedales Shimano' });

    const res = await request(buildApp(db)).get('/api/cobertura/solo-ml?q=Maxxis');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].titulo).toBe('Cubierta Maxxis');
  });

  it('GET /solo-ml excluye claves con una decisión viva (BLOQUEANTE): omitidas y confirmadas-pendientes no reaparecen', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Omitida por el Matcher' });
    seedMlSinSku(db, { clave: 'MLA2|', item_id: 'MLA2', titulo: 'Confirmada, push pendiente' });
    seedMlSinSku(db, { clave: 'MLA3|', item_id: 'MLA3', titulo: 'Libre de verdad' });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA1|', NULL, NULL, 'omitir', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA2|', 'FB-9', 'Otro producto', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());

    const res = await request(buildApp(db)).get('/api/cobertura/solo-ml');
    const titulos = res.body.data.map((r) => r.titulo);
    expect(titulos).toEqual(['Libre de verdad']);
    expect(res.body.total).toBe(1);
  });

  it('GET /sin-stock separa productos sin stock de la cola principal', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Con stock', stock: 5 });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Sin stock', stock: 0 });

    const universo = calcularUniversoPendiente(db);
    expect(universo.map((p) => p.id_woo)).toEqual([1]);

    const res = await request(buildApp(db)).get('/api/cobertura/sin-stock');
    expect(res.body.data.map((p) => p.id_woo)).toEqual([2]);
  });

  it('GET /marcas/:marca/cola devuelve candidatos con diff estructurado', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pedales Shimano M520', marca: 'Shimano' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pedales Shimano M520' });

    const res = await request(buildApp(db)).get('/api/cobertura/marcas/Shimano/cola');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    expect(item.candidatos[0].diff).toBeDefined();
    expect(item.candidatos[0].diff.coincide).toBeDefined();

    // "seguir donde quedé" queda registrado tras pedir la cola de una marca, para ESTE
    // usuario (migración 012 — sesión por usuario y por dirección, ya no singleton id=1).
    const sesion = db.prepare(
      "SELECT marca_actual FROM cobertura_sesion WHERE user_id = 1 AND direccion = 'wc_ml'"
    ).get();
    expect(sesion.marca_actual).toBe('Shimano');
  });

  it('seguir donde quedé es por usuario: dos usuarios distintos no comparten sesión', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Pedales Shimano M520', marca: 'Shimano' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Casco Giro', marca: 'Giro' });

    const appUsuario1 = express();
    appUsuario1.use(express.json());
    appUsuario1.use((req, res, next) => { req.user = { id: 1, username: 'ana' }; next(); });
    appUsuario1.use('/api/cobertura', coberturaRouter(db, CFG));

    const appUsuario2 = express();
    appUsuario2.use(express.json());
    appUsuario2.use((req, res, next) => { req.user = { id: 2, username: 'joaco' }; next(); });
    appUsuario2.use('/api/cobertura', coberturaRouter(db, CFG));

    await request(appUsuario1).get('/api/cobertura/marcas/Shimano/cola');
    await request(appUsuario2).get('/api/cobertura/marcas/Giro/cola');

    const res1 = await request(appUsuario1).get('/api/cobertura/resumen');
    const res2 = await request(appUsuario2).get('/api/cobertura/resumen');
    expect(res1.body.seguir_donde_quede.marca).toBe('Shimano');
    expect(res2.body.seguir_donde_quede.marca).toBe('Giro');
  });
});
