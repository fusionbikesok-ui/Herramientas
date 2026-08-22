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
import { pushSkusPendientes, _resetEstadoPushParaTests } from '../lib/matcherPush.js';

const TEST_DB = './test/tmp-cobertura-hallazgos.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } };

function buildApp(db) {
  const app = express();
  app.use(express.json());
  // req.user admin de prueba: requireAdmin (pausar/desvincular) lo necesita.
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

function seedMl(db, { clave, item_id, variation_id = null, titulo = 'X', seller_sku = null, available_quantity = null, status = 'active' }) {
  db.prepare(`
    INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, seller_sku, available_quantity, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(clave, item_id, variation_id, titulo, status, seller_sku, available_quantity, new Date().toISOString());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Simula la carrera real del hallazgo ALTO: "el push escribe el seller_sku DESPUÉS del
 * SELECT del handler pero ANTES/DURANTE su DELETE". Como todo esto es síncrono en el test
 * (no hay concurrencia real), la única forma determinística de inyectar el cambio EXACTAMENTE
 * entre el SELECT inicial y el DELETE es interceptar la sentencia DELETE que usa el handler:
 * justo antes de ejecutarla, escribimos el seller_sku "como si" el push hubiera ganado la
 * carrera, y recién ahí dejamos correr el DELETE real. Se autorrestaura después de una sola
 * intercepción (no debe afectar otras queries de la misma request).
 */
function simularCarreraDePushEnDelete(db, clave, sku) {
  const original = db.prepare.bind(db);
  const DELETE_SQL = "DELETE FROM sku_matcher_decisiones WHERE clave = ? AND accion = 'confirmar'";
  db.prepare = (sql) => {
    const stmt = original(sql);
    if (sql === DELETE_SQL) {
      const originalRun = stmt.run.bind(stmt);
      stmt.run = (...args) => {
        db.prepare = original; // una sola vez: se desactiva antes de tocar nada más
        original('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?').run(sku, clave);
        return originalRun(...args);
      };
    }
    return stmt;
  };
}

describe('Cobertura — hallazgos del revisor (2ª ronda)', () => {
  let db, app;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    app = buildApp(db);
    mlFetch.mockReset();
    _resetEstadoPushParaTests();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // ── BLOQUEANTE: confirmar no valida ml_clave existente ──────────────────────────────

  it('POST /confirmar rechaza con 400 si la clave ML no existe en caché', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const res = await request(app).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA_INEXISTENTE|' });
    expect(res.status).toBe(400);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA_INEXISTENTE|'").get()).toBeUndefined();

    // Mutation testing manual: comenté el `if (!existePublicacion) return {...}` en
    // confirmarDecisionCobertura (routes/cobertura.js) y corrí este test — con la guarda
    // apagada, res.status daba 200 (o 500 al intentar el push) y quedaba una decisión
    // colgada hacia una clave muerta. Restaurada la guarda, test verde.
  });

  // ── BLOQUEANTE: universo no excluye decididas / pisado silencioso ───────────────────

  it('POST /confirmar rechaza con 409 si la clave ya está confirmada para OTRO sku (no pisa en silencio)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Producto A' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Producto B' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Compartida' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    // A confirma primero.
    const resA = await request(app).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA1|' });
    expect(resA.status).toBe(200);
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get().sku).toBe('FB-1');

    // B intenta confirmar la MISMA publicación (ventana real: push todavía no efectivizó A).
    const resB = await request(app).post('/api/cobertura/productos/2/confirmar').send({ ml_clave: 'MLA1|' });
    expect(resB.status).toBe(409);

    // La decisión de A sigue intacta — no fue pisada en silencio.
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get().sku).toBe('FB-1');

    // Mutation testing manual: comenté el chequeo `existente.sku && existente.sku !== sku` en
    // confirmarDecisionCobertura y corrí este test — resB.status daba 200 y el SKU de la
    // decisión pasaba a 'FB-2' (A perdía su vínculo sin aviso). Restaurada la guarda, verde.
  });

  it('POST /confirmar rechaza con 409 una clave con decisión "omitir" (excluida del universo, no se confirma igual desde acá)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA1|', NULL, NULL, 'omitir', ?)").run(new Date().toISOString());

    const res = await request(app).post('/api/cobertura/productos/1/confirmar').send({ ml_clave: 'MLA1|' });
    expect(res.status).toBe(409);
  });

  // ── ALTO: pausar variación pausa la publicación entera ──────────────────────────────

  it('pausar una VARIACIÓN con hermanas exige confirmación explícita antes de ejecutar (409 con el conteo)', async () => {
    seedMl(db, { clave: 'MLA1|100', item_id: 'MLA1', variation_id: '100', titulo: 'Variación roja' });
    seedMl(db, { clave: 'MLA1|200', item_id: 'MLA1', variation_id: '200', titulo: 'Variación azul' });
    seedMl(db, { clave: 'MLA1|300', item_id: 'MLA1', variation_id: '300', titulo: 'Variación verde' });

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA1|100/pausar').send({});
    expect(res.status).toBe(409);
    expect(res.body.requiere_confirmacion).toBe(true);
    expect(res.body.variaciones_afectadas).toBe(2); // las otras dos, no ella misma
    expect(mlFetch).not.toHaveBeenCalled(); // no se ejecutó nada todavía

    // Mutation testing manual: cambié `body?.confirmado !== true` por `false` (nunca exige
    // confirmación) en pausarConAdvertencia (routes/cobertura.js) y corrí este test —
    // res.status daba 200 (pausaba directo). Restaurado, vuelve a 409.
  });

  it('pausar una variación con { confirmado:true } procede y pausa toda la publicación (documentado, no oculto)', async () => {
    seedMl(db, { clave: 'MLA1|100', item_id: 'MLA1', variation_id: '100', titulo: 'Variación roja' });
    seedMl(db, { clave: 'MLA1|200', item_id: 'MLA1', variation_id: '200', titulo: 'Variación azul' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA1|100/pausar').send({ confirmado: true });
    expect(res.status).toBe(200);
    expect(res.body.variaciones_afectadas).toBe(1);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1|200'").get().status).toBe('paused');
  });

  it('pausar una publicación SIN variaciones (simple) no exige confirmación — no hay a quién arrastrar', async () => {
    seedMl(db, { clave: 'MLA9|', item_id: 'MLA9', titulo: 'Simple' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA9|/pausar').send({});
    expect(res.status).toBe(200);
    expect(res.body.variaciones_afectadas).toBe(0);
  });

  // ── ALTO: deshacer sin push efectivizado corre contra el push en curso ──────────────

  it('vinculos/:clave/deshacer rechaza con 409 si hay un push a ML en curso (evita la carrera con el mismo criterio que el mutex)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' }); // seller_sku vacío todavía
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());

    // Dejamos un push "colgado" (running:true) simulando al cron en medio de una corrida.
    // pushSkusPendientes marca _estado.running=true de forma SÍNCRONA (antes de cualquier
    // await real) — con la promesa sin awaitear todavía, el flag ya está en true acá.
    let liberar;
    const colgado = new Promise((r) => { liberar = r; });
    mlFetch.mockImplementation(async () => { await colgado; return { status: 200, data: { results: [], scroll_id: null } }; });
    const corridaPromise = pushSkusPendientes(db, CFG.ml, { cuotaPausadas: null });

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(409);
    expect(res.body.push_en_curso).toBe(true);
    // Nada cambió: la decisión sigue viva.
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get()).toBeTruthy();

    liberar();
    await corridaPromise;

    // Mutation testing manual: comenté el `if (getEstadoPush().running) return res.status(409)`
    // en el handler de deshacer (routes/cobertura.js) y corrí este test — res.status daba 200
    // (el deshacer avanzaba igual mientras el push seguía corriendo). Restaurado, vuelve a 409.
  });

  it('vinculos/:clave/deshacer: si el push escribió el SKU ENTRE nuestro chequeo y el borrado, se detecta post-delete y desvincula fail-closed', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' }); // snapshot inicial: sin seller_sku → yaEfectivizado=false
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    // La carrera real: el seller_sku se escribe EXACTAMENTE entre el SELECT inicial (que ve
    // yaEfectivizado=false, sin esto el test entraría por la rama equivocada) y el DELETE.
    simularCarreraDePushEnDelete(db, 'MLA1|', 'FB-1');

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(200);
    // Se detectó la carrera post-delete y se desvinculó de verdad en ML antes de dar por
    // bueno el "pendiente" — si el re-chequeo no existiera, mlFetch nunca se habría llamado.
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = 'MLA1|'").get().seller_sku).toBeNull();
    expect(db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get()).toBeUndefined();

    // Mutation testing manual: comenté el bloque completo `if (cacheRowPost && ...) {...}`
    // (el re-chequeo post-delete) en routes/cobertura.js y corrí este test — mlFetch quedaba
    // en 0 llamadas y el seller_sku seguía en 'FB-1' (nadie detectaba la carrera). Restaurado.
  });

  it('vinculos/:clave/deshacer: si la desvinculación post-delete FALLA (4xx de ML), se restaura la decisión local (no miente que está libre)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' }); // snapshot inicial: sin seller_sku
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', 'tester', ?)").run(new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 500, data: { message: 'ML caído' } });
    simularCarreraDePushEnDelete(db, 'MLA1|', 'FB-1');

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(502);
    expect(res.body.fail_closed).toBe(true);
    // La decisión se restauró: local vuelve a coincidir con la realidad de ML.
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get();
    expect(decision).toBeTruthy();
    expect(decision.accion).toBe('confirmar');
    expect(decision.sku).toBe('FB-1');
    expect(decision.confirmado_por).toBe('tester');

    // Mutation testing manual: quité el bloque de restauración (el INSERT dentro del `if
    // (!resultado.ok)`) y corrí este test — la decisión quedaba `undefined` (local "libre"
    // mintiendo que ML también lo estaba). Restaurado el bloque, test verde.
  });

  it('vinculos/:clave/deshacer: si mlFetch LANZA (fallo de transporte, no un status) en la desvinculación post-delete, también se restaura la decisión y responde 502 (no 500)', async () => {
    // Hallazgo del revisor: mlFetch lanza ante fallo de transporte (lib/mlClient.js — throw e
    // después de _registrarErrorMl), no siempre devuelve { ok:false, status }. Sin el
    // try/catch alrededor de desvincularSkuEnMl en la rama post-delete, esta excepción salía
    // directo como 500 SIN restaurar la decisión — la misma divergencia que el fix del hallazgo
    // anterior prometía cerrar, solo que alcanzable con un cable de red en vez de un 4xx de ML.
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' }); // snapshot inicial: sin seller_sku
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());
    mlFetch.mockRejectedValue(new Error('ECONNRESET'));
    simularCarreraDePushEnDelete(db, 'MLA1|', 'FB-1');

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(502); // no 500
    expect(res.body.fail_closed).toBe(true);
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get();
    expect(decision).toBeTruthy(); // restaurada, no undefined
    expect(decision.accion).toBe('confirmar');
    expect(decision.sku).toBe('FB-1');

    // Mutation testing manual: saqué el try/catch alrededor de `desvincularSkuEnMl` en la
    // rama post-delete (routes/cobertura.js) —dejando `const resultado = await
    // desvincularSkuEnMl(...)` a secas— y corrí este test: la request nunca llegó a
    // responder 502 con el body esperado (la excepción se propaga sin pasar por la
    // restauración). Confirmado en rojo, restaurado el try/catch, vuelve a verde.
  });

  it('vinculos/:clave/deshacer (rama YA efectivizado): si mlFetch LANZA, responde 502 fail-closed y no borra la decisión', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X', seller_sku: 'FB-1' }); // ya efectivizado desde el snapshot inicial
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en) VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)").run(new Date().toISOString());
    mlFetch.mockRejectedValue(new Error('ECONNRESET'));

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(502);
    expect(res.body.fail_closed).toBe(true);
    // No se llegó a borrar nada: la decisión sigue exactamente como estaba.
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").get();
    expect(decision).toBeTruthy();
    expect(decision.accion).toBe('confirmar');
  });

  it('multi-publicacion/:clave/pausar: si mlFetch LANZA, responde 502 fail-closed (no 500) — no hay nada que restaurar', async () => {
    seedMl(db, { clave: 'MLA9|', item_id: 'MLA9', titulo: 'Simple' });
    mlFetch.mockRejectedValue(new Error('ECONNRESET'));

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA9|/pausar').send({});
    expect(res.status).toBe(502);
    expect(res.body.fail_closed).toBe(true);
  });

  // ── Permisos: Matcher unificado (entrega 1, 2026-08-14) — un solo permiso 'matcher' ──
  // niveles:true reemplazó al extinto 'cobertura' (niveles:false). Un no-admin necesita
  // nivel:'write' para las acciones (POST/PATCH/DELETE) de esta herramienta, no alcanza con
  // 'read' — a diferencia del comportamiento viejo (ver test/permisos.test.js).

  it('un usuario no-admin con matcher:write puede ejecutar un POST real', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use((req, res, next) => {
      req.user = { id: 2, username: 'joaco', is_admin: 0, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
      next();
    });
    // Replica EXACTA de scopeCheck (server.js).
    const { resolvePermiso, permiteAcceso } = await import('../lib/permisos.js');
    serverApp.use('/api', (req, res, next) => {
      if (req.user?.is_admin) return next();
      const permiso = resolvePermiso(req.method, req.path);
      if (permiteAcceso(req.user.permisos, permiso)) return next();
      return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
    });
    serverApp.use('/api/cobertura', coberturaRouter(db, CFG));

    const res = await request(serverApp).post('/api/cobertura/productos/1/descartar');
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('descartado');
  });

  it('un usuario no-admin con matcher:read (sin write) queda bloqueado en una acción', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use((req, res, next) => {
      req.user = { id: 2, username: 'joaco', is_admin: 0, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };
      next();
    });
    const { resolvePermiso, permiteAcceso } = await import('../lib/permisos.js');
    serverApp.use('/api', (req, res, next) => {
      if (req.user?.is_admin) return next();
      const permiso = resolvePermiso(req.method, req.path);
      if (permiteAcceso(req.user.permisos, permiso)) return next();
      return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
    });
    serverApp.use('/api/cobertura', coberturaRouter(db, CFG));

    const res = await request(serverApp).post('/api/cobertura/productos/1/descartar');
    expect(res.status).toBe(403);
  });

  it('un usuario no-admin SIN el permiso matcher sigue bloqueado (default-deny se mantiene)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use((req, res, next) => { req.user = { id: 2, username: 'joaco', is_admin: 0, permisos: [] }; next(); });
    const { resolvePermiso, permiteAcceso } = await import('../lib/permisos.js');
    serverApp.use('/api', (req, res, next) => {
      if (req.user?.is_admin) return next();
      const permiso = resolvePermiso(req.method, req.path);
      if (permiteAcceso(req.user.permisos, permiso)) return next();
      return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
    });
    serverApp.use('/api/cobertura', coberturaRouter(db, CFG));

    const res = await request(serverApp).post('/api/cobertura/productos/1/descartar');
    expect(res.status).toBe(403);
  });

  it('pausar (admin-only) rechaza a un no-admin con matcher:write, aunque el permiso de herramienta alcance', async () => {
    seedMl(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.use((req, res, next) => {
      req.user = { id: 2, username: 'joaco', is_admin: 0, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
      next();
    });
    serverApp.use('/api/cobertura', coberturaRouter(db, CFG));
    const res = await request(serverApp).post('/api/cobertura/multi-publicacion/MLA1|/pausar');
    expect(res.status).toBe(403);
  });
});
