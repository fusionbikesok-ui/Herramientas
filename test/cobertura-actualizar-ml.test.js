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

const TEST_DB = './test/tmp-cobertura-actualizar-ml.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } };

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/cobertura', coberturaRouter(db, CFG));
  return app;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 400 tries × 20ms = 8s de presupuesto de polling: con CALL_DELAY_MS=1500ms (incidente
// 2026-08-27, antes 350ms) un refresco de 2 statuses + 1 chunk de multiget ya suma ~4,5s
// reales de sleeps propios, antes de contar reintentos ante error.
async function esperarQueTermine(app, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const r = await request(app).get('/api/cobertura/actualizar-ml/estado');
    if (!r.body.running) return r.body;
    await sleep(20);
  }
  throw new Error('el refresco no terminó a tiempo');
}

describe('Cobertura accionable — POST /actualizar-ml (botón "Actualizar desde ML")', () => {
  let db, app;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    app = buildApp(db);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('refresca de verdad ml_publicaciones_cache (no solo devuelve estado)', async () => {
    // 1er llamado: /users/:id/items/search?status=active (scan) — sin resultados, corta el scroll.
    // 2do llamado: status=paused — idem. 3er llamado: multiget — nunca se llega si no hay ids.
    mlFetch.mockImplementation(async (db2, cfg, method, path) => {
      if (String(path).includes('/items/search')) {
        return { status: 200, data: { results: ['MLA1'], scroll_id: null } };
      }
      if (String(path).includes('/items?ids=')) {
        return {
          status: 200,
          data: [{ code: 200, body: {
            id: 'MLA1', title: 'Pedales Shimano M520', status: 'active', sub_status: [],
            attributes: [], variations: [], thumbnail: 't', permalink: 'p', catalog_listing: false,
            price: 1000, available_quantity: 5,
          } }],
        };
      }
      return { status: 404, data: {} };
    });

    const res = await request(app).post('/api/cobertura/actualizar-ml');
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.running).toBe(true);

    const final = await esperarQueTermine(app);
    expect(final.error).toBeNull();
    expect(final.resultado.total).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM ml_publicaciones_cache WHERE item_id = 'MLA1'").get();
    expect(row).toBeTruthy();
    expect(row.titulo).toBe('Pedales Shimano M520');
  }, 10000);

  it('CANDADO: un segundo POST mientras el primero sigue en curso se omite (no dispara otro refresco)', async () => {
    let resolverPrimerLlamado;
    const primeraLlamadaPendiente = new Promise((r) => { resolverPrimerLlamado = r; });
    mlFetch.mockImplementation(async () => {
      await primeraLlamadaPendiente; // se queda "colgado" hasta que el test lo libere
      return { status: 200, data: { results: [], scroll_id: null } };
    });

    const res1 = await request(app).post('/api/cobertura/actualizar-ml');
    expect(res1.status).toBe(202);
    expect(res1.body.running).toBe(true);

    // Con el primero todavía colgado en mlFetch, el segundo POST tiene que verse rechazado:
    const res2 = await request(app).post('/api/cobertura/actualizar-ml');
    expect(res2.status).toBe(409);
    expect(res2.body.ok).toBe(false);
    expect(res2.body.running).toBe(true);
    expect(res2.body.error).toMatch(/ya hay un refresco en curso/i);

    // Solo UNA llamada a mlFetch se disparó durante la ventana de "en curso" (la del primer
    // POST) — si el candado no frenara al segundo, veríamos una segunda invocación acá.
    expect(mlFetch).toHaveBeenCalledTimes(1);

    resolverPrimerLlamado();
    await esperarQueTermine(app);

    // Mutation testing manual: comenté `if (_refresco.running) { return {...} }` en
    // dispararRefrescoMl (routes/matcher.js) y corrí este test — con la guarda comentada,
    // res2.status daba 202 (arrancaba un segundo refresco) y `mlFetch` se llamaba 2 veces
    // antes de liberar la promesa pendiente. Restauré la guarda y el test vuelve a verde.
  }, 10000);

  it('FAIL-CLOSED: si ML no responde, la caché NO se pisa con datos parciales y el error queda expuesto', async () => {
    // 10s: el multiget en 500 reintenta 3 veces con backoff real (mlFetchConReintento).
    // Sembramos una publicación previa "buena" que un refresco fallido NO debe borrar.
    db.prepare(`
      INSERT INTO ml_publicaciones_cache (clave, item_id, titulo, status, seller_sku, actualizado_en)
      VALUES ('MLA_VIEJA|', 'MLA_VIEJA', 'Publicación previa', 'active', 'FB-1', ?)
    `).run(new Date('2026-01-01').toISOString());

    mlFetch.mockImplementation(async (db2, cfg, method, path) => {
      if (String(path).includes('/items/search')) {
        return { status: 200, data: { results: ['MLA1'], scroll_id: null } };
      }
      // El multiget falla (500): refrescarPublicacionesMl debe abortar ANTES de tocar la caché.
      return { status: 500, data: [] };
    });

    const res = await request(app).post('/api/cobertura/actualizar-ml');
    expect(res.status).toBe(202);

    // El multiget en 500 ahora reintenta (mlFetchConReintento, incidente 2026-08-27:
    // resiliencia ante 5xx transitorios) antes de fallar-cerrado — 3 reintentos con
    // backoff real [500,1500,4000]ms ≈ 6s de tiempo real hasta el último intento.
    const final = await esperarQueTermine(app, 400);
    expect(final.error).toBeTruthy();
    expect(final.resultado).toBeNull(); // nunca se completó un resultado exitoso

    // La publicación previa sigue exactamente igual: la caché no quedó a mitad de camino.
    const row = db.prepare("SELECT * FROM ml_publicaciones_cache WHERE clave = 'MLA_VIEJA|'").get();
    expect(row).toBeTruthy();
    expect(row.titulo).toBe('Publicación previa');
    expect(row.seller_sku).toBe('FB-1');

    // "última actualización" (fuente real: MAX(actualizado_en) de la tabla) no avanzó.
    const resumen = await request(app).get('/api/cobertura/resumen');
    expect(resumen.body.ultima_actualizacion_ml).toBe(new Date('2026-01-01').toISOString());

    // Mutation testing manual: deshabilité el chequeo `if (resp.status !== 200 || ...) throw`
    // en routes/matcher.js#refrescarPublicacionesMl (`if (false && ...)`) y corrí este test:
    // con la guarda apagada, el refresco "terminaba bien" (final.error volvía null en vez de
    // truthy) porque el multiget con 0 filas llegaba igual a la transacción de reemplazo
    // (DELETE + upsert), borrando MLA_VIEJA. Restauré la guarda y el test vuelve a verde.
  }, 10000);

  it('GET /resumen expone ultima_actualizacion_ml y refresco_ml_en_curso sin forzar ningún refresco', async () => {
    db.prepare(`
      INSERT INTO ml_publicaciones_cache (clave, item_id, titulo, status, actualizado_en)
      VALUES ('MLA1|', 'MLA1', 'X', 'active', ?)
    `).run('2026-08-01T10:00:00.000Z');

    const res = await request(app).get('/api/cobertura/resumen');
    expect(res.status).toBe(200);
    expect(res.body.ultima_actualizacion_ml).toBe('2026-08-01T10:00:00.000Z');
    expect(res.body.refresco_ml_en_curso).toBe(false);
    expect(mlFetch).not.toHaveBeenCalled(); // puramente local, sin pegarle a ML
  });

  it('respeta el presupuesto de ML: usa manual:true (saltea solo el cooldown, nunca reservarCupo)', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: { results: [], scroll_id: null } });
    await request(app).post('/api/cobertura/actualizar-ml');
    await esperarQueTermine(app);

    // Todas las llamadas del refresco deben pasar manual:true explícito — mlFetch (real) es
    // quien decide con eso si saltea el cooldown, pero SIEMPRE llama a reservarCupo primero
    // (ver lib/mlClient.js): acá solo verificamos que el contrato de la llamada sea el mismo
    // "manual" que ya usan el resto de los refrescos del repo, no uno nuevo sin ese flag.
    for (const call of mlFetch.mock.calls) {
      const opts = call[5];
      expect(opts?.manual).toBe(true);
    }
  }, 10000);
});
