import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { matcherRouter, computarCandidatosApi, computarCandidatosApiAsync } from '../routes/matcher.js';
import { topCandidatosPorTokens, lcsLen, tsr, ratio } from '../lib/matcherEngine.js';

// Pruebas de rendimiento del cruce de candidatos (Matcher). No miden tiempos: verifican que las
// optimizaciones den EXACTAMENTE el mismo resultado que la versión original y que el cómputo en
// background ceda el event loop. Los conteos de cesiones son deterministas (por tramos), no por reloj.

const TEST_DB = './test/tmp-matcher-rendimiento.sqlite';
const ISO = '2026-10-10T12:00:00.000Z';

// ── Referencias: copia fiel del código original (HEAD antes del fix) ──────────────────────────────
function refTopCandidatos(tks, n, indice) {
  const cuenta = {};
  for (const t of tks) if (indice[t]) for (const p of indice[t]) cuenta[p] = (cuenta[p] || 0) + 1;
  return Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a]).slice(0, 50).map(Number);
}
function refLcs(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const cur = new Int32Array(n + 1), ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) cur[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[n];
}
function refRatio(a, b) { const la = a.length, lb = b.length; if (!la && !lb) return 1; if (!la || !lb) return 0; return 2 * refLcs(a, b) / (la + lb); }
function refTsr(a, b) {
  const sa = new Set(a.split(' ').filter((x) => x)), sb = new Set(b.split(' ').filter((x) => x));
  const inter = [...sa].filter((x) => sb.has(x)).sort(), dA = [...sa].filter((x) => !sb.has(x)).sort(), dB = [...sb].filter((x) => !sa.has(x)).sort();
  const t0 = inter.join(' '), t1 = inter.concat(dA).join(' ').trim(), t2 = inter.concat(dB).join(' ').trim();
  return Math.max(refRatio(t0, t1), refRatio(t0, t2), refRatio(t1, t2));
}

// Generador determinista (LCG) para datos de prueba reproducibles.
function prng(seed = 42) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

describe('optimizaciones del cruce: mismo resultado que el original', () => {
  it('topCandidatosPorTokens devuelve las mismas posiciones, en el mismo orden, que el sort original', () => {
    const rnd = prng(7);
    const N = 400, palabras = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const indice = {};
    for (let i = 0; i < N; i++) {
      const toks = new Set(Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => palabras[Math.floor(rnd() * palabras.length)]));
      for (const t of toks) (indice[t] || (indice[t] = [])).push(i);
    }
    for (let k = 0; k < 300; k++) {
      const tks = new Set(Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => palabras[Math.floor(rnd() * palabras.length)]));
      expect(topCandidatosPorTokens(tks, N, indice)).toEqual(refTopCandidatos(tks, N, indice));
    }
  });

  it('lcsLen y tsr dan el mismo valor que la versión original', () => {
    const rnd = prng(3);
    const alfabeto = 'ab cde';
    const rand = (max) => Array.from({ length: Math.floor(rnd() * max) }, () => alfabeto[Math.floor(rnd() * alfabeto.length)]).join('');
    for (let k = 0; k < 400; k++) {
      const a = rand(30), b = rand(30);
      expect(lcsLen(a, b)).toBe(refLcs(a, b));
      expect(ratio(a, b)).toBe(refRatio(a, b));
      expect(tsr(a, b)).toBe(refTsr(a, b));
      expect(tsr(a, b)).toBe(refTsr(a, b)); // segunda llamada: memo de tokens, mismo valor
    }
  });
});

describe('cruce en background: async = sync y cede el event loop', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TEST_DB}${s}`)) fs.unlinkSync(`${TEST_DB}${s}`);
  });

  const MARCAS = ['Shimano', 'Sram', 'Giant', 'Trek', 'Fox', 'Bell'];
  const TIPOS = ['Pedales', 'Casco', 'Cubierta', 'Cadena', 'Manubrio', 'Freno'];
  function sembrar({ productos, publicaciones }) {
    const rnd = prng(11);
    const insP = db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, img, atributos_json, actualizado_en) VALUES (?, ?, ?, 'simple', 1, '', NULL, ?)`);
    const insM = db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en)
      VALUES (?, ?, '', ?, 'active', '', 0, '', '', '', '', '', 0, ?)`);
    db.transaction(() => {
      for (let i = 0; i < productos; i++) {
        const nombre = `${TIPOS[i % TIPOS.length]} ${MARCAS[Math.floor(rnd() * MARCAS.length)]} M${100 + i}`;
        insP.run(1000 + i, nombre, `FB-${1000 + i}`, ISO);
      }
      for (let i = 0; i < publicaciones; i++) {
        const titulo = `${TIPOS[Math.floor(rnd() * TIPOS.length)]} ${MARCAS[Math.floor(rnd() * MARCAS.length)]} M${100 + Math.floor(rnd() * productos)}`;
        insM.run(`MLA${5000 + i}|`, `MLA${5000 + i}`, titulo, ISO);
      }
    })();
  }

  it('computarCandidatosApiAsync devuelve exactamente lo mismo que computarCandidatosApi', async () => {
    sembrar({ productos: 60, publicaciones: 80 });
    const sync = JSON.stringify(computarCandidatosApi(db, 'all'));
    const async = JSON.stringify(await computarCandidatosApiAsync(db, 'all'));
    expect(async).toBe(sync);
    expect(JSON.parse(sync).total).toBe(80);
  });

  it('cede el event loop durante el cruce: una tarea encadenada con setImmediate avanza mientras calcula', async () => {
    // 700 publicaciones = 3 tramos de 300 en construirMLdesdeApi: al menos 3 cesiones sólo por esa fase.
    sembrar({ productos: 25, publicaciones: 700 });
    let vueltas = 0, corriendo = true;
    const bucle = () => { if (!corriendo) return; vueltas++; setImmediate(bucle); };
    bucle();
    const r = await computarCandidatosApiAsync(db, 'all');
    corriendo = false;
    expect(r.total).toBe(700);
    expect(vueltas).toBeGreaterThanOrEqual(3);
  });
});

describe('GET /candidatos: respuesta con caché caliente', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TEST_DB}${s}`)) fs.unlinkSync(`${TEST_DB}${s}`);
  });

  it('202 mientras calcula; luego 200 con data = lista completa (serializada por tramos, mismo JSON)', async () => {
    const rnd = prng(5);
    const insP = db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, img, atributos_json, actualizado_en) VALUES (?, ?, ?, 'simple', 1, '', NULL, ?)`);
    const insM = db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en)
      VALUES (?, ?, '', ?, 'active', '', 0, '', '', '', '', '', 0, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 30; i++) insP.run(i + 1, `Bicicleta Rodado 29 Talle ${i}`, `FB-${i + 1}`, ISO);
      for (let i = 0; i < 1200; i++) insM.run(`MLA${9000 + i}|`, `MLA${9000 + i}`, `Bicicleta Rodado 29 Talle ${Math.floor(rnd() * 30)}`, ISO);
    })();
    const app = express();
    app.use('/api/matcher', matcherRouter(db, { ml: { clientId: 'c', clientSecret: 's', userId: '9' } }));

    const primera = await request(app).get('/api/matcher/candidatos?scope=all');
    expect(primera.status).toBe(202);
    expect(primera.body).toEqual({ ok: true, computing: true, scope: 'all' });

    let r = null;
    for (let i = 0; i < 200; i++) {
      r = await request(app).get('/api/matcher/candidatos?scope=all');
      if (r.status === 200 && r.body.cache === true) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, total: 1200, scope: 'all', cache: true });
    expect(r.body.data).toHaveLength(1200);
    expect(Object.keys(r.body)).toEqual(['ok', 'data', 'total', 'actualizado', 'scope', 'cache']);
  });
});
