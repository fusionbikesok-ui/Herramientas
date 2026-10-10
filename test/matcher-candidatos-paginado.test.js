import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { matcherRouter } from '../routes/matcher.js';
import { paginarCandidatos, parsearPaginado } from '../lib/matcherCandidatosPaginado.js';

// GET /api/matcher/candidatos con q/filtro/limit/offset: filtrado y paginación server-side.
// La referencia del filtro de modo es una copia fiel de filtroMatcher de
// public/catalogo-vinculos/catalogo-vinculos.js. El texto `q` usa la semántica NUEVA: AND por
// palabras, sin acentos ni mayúsculas (antes era subcadena exacta; ver docs/api-contrato.md).

const TEST_DB = './test/tmp-matcher-candidatos-paginado.sqlite';
const ISO = '2026-10-10T12:00:00.000Z';

// ── Referencia: copia del código client-side original ─────────────────────────────────────────────
function refClaveDeMl(it) { return it.clave || (it.ml_item_id + (it.ml_variation_id ? '|' + it.ml_variation_id : '')); }
function refFiltroMatcher(it, f) {
  if (f === 'all') return true;
  if (f === 'asignar') return it.modo === 'asignar';
  if (f === 'verificar') return it.modo === 'verificar';
  if (f === 'conf-baja') return it.modo === 'verificar' && it.score_confianza < 0.7;
  return !!(it.candidatos && it.candidatos[0] && it.candidatos[0].color_ok && it.candidatos[0].talle_ok);
}
// Referencia independiente de la texto nuevo: sin acentos (NFD), minúsculas, palabras por espacio, AND.
function refNorm(v) { return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function refTextoOk(it, q) {
  const palabras = refNorm(q).split(' ').filter(Boolean);
  const hay = refNorm(String(it.ml_title || '') + ' ' + refClaveDeMl(it));
  return palabras.every((p) => hay.includes(p));
}
function refListaCliente(items, q, f) {
  return items.filter((it) => refFiltroMatcher(it, f) && refTextoOk(it, q));
}
const claves = (lista) => lista.map((x) => refClaveDeMl(x));

// Generador determinista para datos sintéticos.
function prng(seed = 11) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

// Ítems sintéticos con la forma que deja derivarEstadoApi (todas las ramas de los filtros).
function itemsSinteticos(n) {
  const rnd = prng(5);
  const palabras = ['Bicicleta', 'Rodado', '29', 'Talle', 'Ruta', 'Niños', 'Mountain', 'Ñandú', 'Negro', 'Rojo'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const modo = rnd() < 0.5 ? 'asignar' : 'verificar';
    const titulo = Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => palabras[Math.floor(rnd() * palabras.length)]).join(' ');
    const variacion = rnd() < 0.4 ? String(1000 + i) : '';
    const cand = rnd() < 0.5 ? [{ score: 0.9, color_ok: true, talle_ok: rnd() < 0.5 ? true : null, wc_sku: 'FB-1' }] : [{ score: 0.5, color_ok: false, talle_ok: true, wc_sku: 'FB-2' }];
    out.push({
      idx: i, modo, ml_item_id: 'MLA' + (5000 + i), ml_variation_id: variacion, ml_title: titulo,
      score_confianza: modo === 'verificar' ? +(rnd()).toFixed(3) : 0, candidatos: rnd() < 0.1 ? [] : cand,
      ml_status: 'active', wc_actual: null,
    });
  }
  return out;
}

describe('parsearPaginado (validación de parámetros)', () => {
  it('defaults: filtro all, limit 50, offset 0, q vacío', () => {
    expect(parsearPaginado({})).toEqual({ params: { q: '', filtro: 'all', limit: 50, offset: 0 } });
  });
  it('limit > 200 se recorta a 200', () => {
    expect(parsearPaginado({ limit: '500' }).params.limit).toBe(200);
  });
  it('rechaza limit no entero o < 1, offset negativo y filtro desconocido', () => {
    expect(parsearPaginado({ limit: '0' }).error).toBeTruthy();
    expect(parsearPaginado({ limit: 'abc' }).error).toBeTruthy();
    expect(parsearPaginado({ offset: '-1' }).error).toBeTruthy();
    expect(parsearPaginado({ filtro: 'otro' }).error).toBeTruthy();
  });
});

describe('paginarCandidatos (lógica pura)', () => {
  const items = itemsSinteticos(400);

  it('paginación: total = filas que cumplen, limit y offset se respetan', () => {
    const total = refListaCliente(items, '', 'all').length;
    const p1 = paginarCandidatos(items, { filtro: 'all', limit: 30, offset: 0 });
    const p2 = paginarCandidatos(items, { filtro: 'all', limit: 30, offset: 30 });
    expect(p1.total).toBe(total);
    expect(p1.items).toHaveLength(30);
    expect(p1.limit).toBe(30);
    expect(p2.offset).toBe(30);
    expect(claves(p2.items)).toEqual(claves(refListaCliente(items, '', 'all')).slice(30, 60));
    expect(paginarCandidatos(items, { offset: 100000 }).items).toEqual([]);
  });

  it('q multi-palabra: AND por palabras, sin distinguir mayúsculas (igual a la referencia)', () => {
    const q = '  Bicicleta RODADO ';
    const esperado = claves(refListaCliente(items, q, 'all'));
    const r = paginarCandidatos(items, { q, limit: 200 });
    expect(r.total).toBe(esperado.length);
    expect(claves(r.items)).toEqual(esperado.slice(0, 200));
  });

  it('"maza shimano" encuentra "Shimano ... Maza" aunque el orden de palabras cambie', () => {
    const its = [
      { ml_item_id: 'MLA1', ml_variation_id: '', ml_title: 'Shimano Deore Maza Delantera', modo: 'asignar', score_confianza: 0, candidatos: [] },
      { ml_item_id: 'MLA2', ml_variation_id: '', ml_title: 'Shimano Pastillas', modo: 'asignar', score_confianza: 0, candidatos: [] },
      { ml_item_id: 'MLA3', ml_variation_id: '', ml_title: 'Maza Generica', modo: 'asignar', score_confianza: 0, candidatos: [] },
    ];
    expect(claves(paginarCandidatos(its, { q: 'maza shimano' }).items)).toEqual(['MLA1']);
    expect(claves(paginarCandidatos(its, { q: 'shimano maza' }).items)).toEqual(['MLA1']);
  });

  it('acentos y mayúsculas: "ñandú" = "nandu" = "NANDU"; "CASCO" = "casco"', () => {
    const its = [
      { ml_item_id: 'MLA10', ml_variation_id: '', ml_title: 'Campera Ñandú Talle M', modo: 'asignar', score_confianza: 0, candidatos: [] },
      { ml_item_id: 'MLA11', ml_variation_id: '', ml_title: 'Casco Urbano Negro', modo: 'asignar', score_confianza: 0, candidatos: [] },
    ];
    const ref = claves(paginarCandidatos(its, { q: 'ñandú' }).items);
    expect(ref).toEqual(['MLA10']);
    expect(claves(paginarCandidatos(its, { q: 'nandu' }).items)).toEqual(ref);
    expect(claves(paginarCandidatos(its, { q: 'NANDU' }).items)).toEqual(ref);
    expect(claves(paginarCandidatos(its, { q: 'CASCO' }).items)).toEqual(['MLA11']);
    expect(claves(paginarCandidatos(its, { q: 'casco' }).items)).toEqual(['MLA11']);
  });

  it('una palabra de otra clave/ítem no cruza: el AND es por publicación', () => {
    const its = [
      { ml_item_id: 'MLA20', ml_variation_id: '', ml_title: 'Bicicleta Ruta', modo: 'asignar', score_confianza: 0, candidatos: [] },
      { ml_item_id: 'MLA21', ml_variation_id: '', ml_title: 'Mountain Rodado', modo: 'asignar', score_confianza: 0, candidatos: [] },
    ];
    // "ruta" está en MLA20 y "rodado" en MLA21: ninguna publicación tiene ambas
    expect(paginarCandidatos(its, { q: 'ruta rodado' }).total).toBe(0);
    // la clave también cuenta como texto buscable (sin cruzar entre ítems)
    expect(claves(paginarCandidatos(its, { q: 'mla20 ruta' }).items)).toEqual(['MLA20']);
    expect(paginarCandidatos(its, { q: 'mla20 rodado' }).total).toBe(0);
  });

  it('q con espacios dobles, tabs o solo espacios: mismo resultado que sus palabras', () => {
    const base = claves(paginarCandidatos(items, { q: 'bicicleta rodado' }).items);
    expect(claves(paginarCandidatos(items, { q: 'bicicleta    rodado' }).items)).toEqual(base);
    expect(claves(paginarCandidatos(items, { q: '\tbicicleta\t rodado  ' }).items)).toEqual(base);
    expect(paginarCandidatos(items, { q: '   ' }).total).toBe(items.length);
    expect(paginarCandidatos(items, { q: '' }).total).toBe(items.length);
  });

  it('orden y paginación estables: páginas contiguas, sin repetidos ni huecos, mismo orden que la caché', () => {
    const q = 'talle';
    const total = paginarCandidatos(items, { q }).total;
    const a = paginarCandidatos(items, { q, limit: 25, offset: 50 });
    const b = paginarCandidatos(items, { q, limit: 25, offset: 50 });
    expect(claves(a.items)).toEqual(claves(b.items));
    expect(claves(a.items)).toEqual(claves(refListaCliente(items, q, 'all')).slice(50, 75));
    expect(new Set(claves(refListaCliente(items, q, 'all'))).size).toBe(total);
  });

  it('cada filtro devuelve lo mismo que filtroMatcher del cliente', () => {
    for (const f of ['all', 'asignar', 'verificar', 'conf-baja', 'color-talle']) {
      const esperado = claves(refListaCliente(items, '', f));
      const r = paginarCandidatos(items, { filtro: f, limit: 200 });
      expect(r.total, f).toBe(esperado.length);
      expect(claves(r.items), f).toEqual(esperado.slice(0, 200));
    }
  });

  it('conteos por filtro (con q aplicado) coinciden con la pantalla', () => {
    const r = paginarCandidatos(items, { q: 'talle' });
    for (const f of ['all', 'asignar', 'verificar', 'conf-baja', 'color-talle']) {
      expect(r.conteos[f], f).toBe(refListaCliente(items, 'talle', f).length);
    }
    expect(r.total_todas).toBe(items.length);
  });

  it('unión de todas las páginas == filtro antiguo client-side (equivalencia)', () => {
    for (const f of ['all', 'verificar', 'color-talle']) {
      const q = 'o';
      const antiguo = claves(refListaCliente(items, q, f));
      let unido = [];
      for (let off = 0; ; off += 37) {
        const pagina = paginarCandidatos(items, { q, filtro: f, limit: 37, offset: off });
        unido = unido.concat(claves(pagina.items));
        if (pagina.items.length < 37) break;
      }
      expect(unido, f).toEqual(antiguo);
    }
  });
});

describe('GET /api/matcher/candidatos paginado (HTTP, caché caliente)', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TEST_DB}${s}`)) fs.unlinkSync(`${TEST_DB}${s}`);
  });

  function seed(nPubs) {
    const rnd = prng(9);
    const insP = db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, img, atributos_json, actualizado_en) VALUES (?, ?, ?, 'simple', 1, '', NULL, ?)`);
    const insM = db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en)
      VALUES (?, ?, '', ?, 'active', '', 0, '', '', '', '', '', 0, ?)`);
    const palabras = ['Bicicleta', 'Rodado 29', 'Talle', 'Ruta', 'Mountain', 'Niños', 'Negro', 'Rojo', 'Aluminio'];
    db.transaction(() => {
      for (let i = 0; i < 300; i++) insP.run(i + 1, `Bicicleta Rodado 29 Talle ${i}`, `FB-${i + 1}`, ISO);
      for (let i = 0; i < nPubs; i++) {
        const t = Array.from({ length: 4 }, () => palabras[Math.floor(rnd() * palabras.length)]).join(' ');
        insM.run(`MLA${9000 + i}|`, `MLA${9000 + i}`, t, ISO);
      }
    })();
  }

  async function caliente(app) {
    await request(app).get('/api/matcher/candidatos?scope=all');
    let r = null;
    for (let i = 0; i < 1200; i++) {
      r = await request(app).get('/api/matcher/candidatos?scope=all');
      if (r.status === 200 && r.body.cache === true) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('la caché no se calentó a tiempo');
  }

  function appDe() {
    const app = express();
    app.use('/api/matcher', matcherRouter(db, { ml: { clientId: 'c', clientSecret: 's', userId: '9' } }));
    return app;
  }

  it('forma de respuesta paginada y respuesta vieja intacta sin parámetros', async () => {
    seed(200);
    const app = appDe();
    await caliente(app);
    const pag = await request(app).get('/api/matcher/candidatos?scope=all&q=bicicleta&limit=10&offset=5');
    expect(pag.status).toBe(200);
    expect(Object.keys(pag.body).sort()).toEqual(['actualizado', 'cache', 'conteos', 'filtro', 'items', 'limit', 'offset', 'ok', 'q', 'scope', 'total', 'total_todas']);
    expect(pag.body).toMatchObject({ ok: true, limit: 10, offset: 5, filtro: 'all', q: 'bicicleta', cache: true, total_todas: 200 });
    expect(pag.body.items).toHaveLength(10);
    expect(Object.keys(pag.body.items[0]).sort()).toEqual(['clave', 'ml_item_id', 'ml_title', 'ml_variation_id', 'modo', 'score_confianza']);
    const vieja = await request(app).get('/api/matcher/candidatos?scope=all');
    expect(Object.keys(vieja.body)).toEqual(['ok', 'data', 'total', 'actualizado', 'scope', 'cache']);
    expect(vieja.body.total).toBe(200);
  });

  it('400 con parámetros inválidos', async () => {
    seed(20);
    const app = appDe();
    await caliente(app);
    expect((await request(app).get('/api/matcher/candidatos?scope=all&filtro=raro')).status).toBe(400);
    expect((await request(app).get('/api/matcher/candidatos?scope=all&limit=0')).status).toBe(400);
  });

  it('7000 publicaciones: página < 200 KB, equivalencia de páginas con el cruce completo', async () => {
    seed(7000);
    const app = appDe();
    await caliente(app);
    // Referencia: el endpoint viejo (lista completa) filtrado con la copia del código client-side.
    const completo = (await request(app).get('/api/matcher/candidatos?scope=all')).body.data;
    expect(completo).toHaveLength(7000);

    const q = 'rodado';
    const antiguo = claves(refListaCliente(completo, q, 'verificar'));
    let unido = [];
    let bytesMax = 0;
    for (let off = 0; ; off += 200) {
      const r = await request(app).get(`/api/matcher/candidatos?scope=all&q=${q}&filtro=verificar&limit=200&offset=${off}`);
      expect(r.status).toBe(200);
      bytesMax = Math.max(bytesMax, Buffer.byteLength(r.text, 'utf8'));
      unido = unido.concat(r.body.items.map((x) => x.clave));
      if (r.body.items.length < 200) break;
    }
    expect(bytesMax).toBeLessThan(200 * 1024);
    expect(unido).toEqual(antiguo);
  });
});
