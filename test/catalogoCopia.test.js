/**
 * E2 T1 tarea 11 — copia consistente del matcher y de los casos de identidad.
 * El contrato del hash y el recorrido completo contra la API real están en la plataforma
 * (plataforma/test/catalogo/api-interna.test.ts).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  canonizar, hashFilas, tomarFoto, filasDecisiones, filasIdentidad, enviarCopia, msHastaProximaCopia, copiaDiaria,
} from '../lib/catalogoCopia.js';

const TEST_DB = './test/tmp-catalogo-copia.sqlite';
let db;
const keyring = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 2) } };

const decision = (clave, sku, accion = 'confirmar', origen = null, confirmado_por = 'jose') => db.prepare(
  'INSERT INTO sku_matcher_decisiones (clave, sku, accion, origen, confirmado_por, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)')
  .run(clave, sku, accion, origen, confirmado_por, '2026-09-18T10:00:00.000Z');
const caso = (ml_key, estado, severidad = 'normal') => db.prepare(`INSERT INTO identidad_casos
  (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, primera_deteccion_en, ultima_deteccion_en)
  VALUES ('ml_fusion', ?, 'sin_match', ?, ?, 'f', 'x', 'x')`).run(ml_key, estado, severidad).lastInsertRowid;

/** Un fetch que responde según la ruta, y guarda lo que recibió. */
function plataformaFalsa(respuestas) {
  const recibidos = [];
  const fetch = async (url, init) => {
    const ruta = new URL(url).pathname;
    recibidos.push({ ruta, cuerpo: JSON.parse(init.body.toString()) });
    const r = respuestas(ruta, recibidos.length);
    return { status: r.status, text: async () => JSON.stringify(r.json ?? {}) };
  };
  return { fetch, recibidos };
}
const feliz = (ruta) => (ruta.endsWith('/copias') ? { status: 201, json: { copy_id: 'c1' } }
  : ruta.endsWith('/lotes') ? { status: 202 } : { status: 200, json: { abiertas: 0, cerradas: 0 } });

describe('E2-CPY-03 copia del catálogo desde el legado', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterAll(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  it('JSON canónico: claves ordenadas, sin espacios, y el hash no depende del orden de las filas', () => {
    expect(canonizar({ b: 1, a: [true, null, 'ñ'] })).toBe('{"a":[true,null,"ñ"],"b":1}');
    const a = { recurso: 'MLA1', variacion: '' }; const b = { recurso: 'MLA2', variacion: '3' };
    expect(hashFilas([a, b])).toBe(hashFilas([b, a]));
  });

  it('la foto trae las decisiones con su actor, y deja afuera las que no tienen forma válida', async () => {
    decision('MLA1|', 'FB-1');
    decision('MLA2|7', 'FB-2', 'asignar', 'auto_seller_sku', null);
    decision('MLA3|', null, 'omitir', null, null);
    decision('ROTA', 'FB-4');
    const f = await tomarFoto(db);
    try {
      const { filas, invalidas } = filasDecisiones(f.foto);
      expect(invalidas).toEqual(['ROTA']);
      expect(filas).toEqual([
        { recurso: 'MLA1', variacion: '', sku: 'FB-1', accion: 'confirmar', actor: 'persona', motivo: null, confirmado_por: 'jose', actualizado_en_legado: '2026-09-18T10:00:00.000Z' },
        { recurso: 'MLA2', variacion: '7', sku: 'FB-2', accion: 'asignar', actor: 'sistema', motivo: 'autoasignación por SKU', confirmado_por: null, actualizado_en_legado: '2026-09-18T10:00:00.000Z' },
        { recurso: 'MLA3', variacion: '', sku: null, accion: 'omitir', actor: 'persona', motivo: null, confirmado_por: null, actualizado_en_legado: '2026-09-18T10:00:00.000Z' },
      ]);
    } finally { f.cerrar(); }
  });

  it('la foto es consistente: lo que se escribe después no aparece, y el archivo temporal se borra', async () => {
    decision('MLA1|', 'FB-1');
    const f = await tomarFoto(db);
    decision('MLA2|', 'FB-2');
    expect(filasDecisiones(f.foto).filas).toHaveLength(1);
    const archivo = f.foto.name;
    f.cerrar();
    expect(fs.existsSync(archivo)).toBe(false);
  });

  it('de identidad sólo van los casos abiertos, con su prioridad', async () => {
    caso('MLA1|', 'pendiente', 'critica');
    caso('MLA2|', 'tomado');
    caso('MLA3|', 'verificado');
    const f = await tomarFoto(db);
    try {
      expect(filasIdentidad(f.foto).filas.map((c) => [c.recurso, c.prioridad, c.detalle.estado])).toEqual([
        ['MLA1', 'urgente', 'pendiente'], ['MLA2', 'normal', 'tomado'],
      ]);
    } finally { f.cerrar(); }
  });

  it('manda la copia en lotes numerados con su conteo y hash, y confirma al final', async () => {
    const filas = Array.from({ length: 5 }, (_, i) => ({ recurso: `MLA${i}`, variacion: '' }));
    const p = plataformaFalsa(feliz);
    await enviarCopia({ url: 'http://p', keyring, fetch: p.fetch, tipo: 'matcher', filas, corte: new Date(), lote: 2 });
    expect(p.recibidos.map((r) => r.ruta.split('/').slice(-1)[0])).toEqual(['copias', 'lotes', 'lotes', 'lotes', 'confirmar']);
    expect(p.recibidos[0].cuerpo).toMatchObject({ tipo: 'matcher', total_esperado: 5, hash_esperado: hashFilas(filas) });
    expect(p.recibidos.slice(1, 4).map((r) => r.cuerpo.numero)).toEqual([1, 2, 3]);
  });

  it('reintenta un 5xx, pero no un 4xx', async () => {
    const sinEspera = async () => {};
    const falla = plataformaFalsa((ruta, n) => (n === 1 ? { status: 503 } : feliz(ruta)));
    await expect(enviarCopia({ url: 'http://p', keyring, fetch: falla.fetch, tipo: 'matcher', filas: [], corte: new Date(), espera: sinEspera })).resolves.toBeTruthy();
    const mala = plataformaFalsa((ruta) => (ruta.endsWith('/confirmar') ? { status: 409, json: { code: 'hash_distinto' } } : feliz(ruta)));
    await expect(enviarCopia({ url: 'http://p', keyring, fetch: mala.fetch, tipo: 'matcher', filas: [], corte: new Date(), espera: sinEspera }))
      .rejects.toThrow(/409 hash_distinto/);
    expect(mala.recibidos.filter((r) => r.ruta.endsWith('/confirmar'))).toHaveLength(1);
  });

  it('la próxima copia es a las 03:30 de Argentina (06:30 UTC)', () => {
    expect(msHastaProximaCopia(new Date('2026-09-19T06:00:00Z'))).toBe(30 * 60_000);
    expect(msHastaProximaCopia(new Date('2026-09-19T06:30:00Z'))).toBe(24 * 3_600_000);
    expect(msHastaProximaCopia(new Date('2026-09-19T07:00:00Z'))).toBe(23.5 * 3_600_000);
  });

  describe('copia diaria', () => {
    const incidentes = () => { const a = []; const c = []; return { a, c, abrir: (i) => a.push(i.tipoError), cerrar: (i) => c.push(i.tipoError) }; };

    it('limpia: cierra los incidentes', async () => {
      const i = incidentes();
      const r = await copiaDiaria(db, { url: 'http://p', keyring, fetch: plataformaFalsa(feliz).fetch }, i);
      expect(r.diferencias).toBe(0);
      expect(i.a).toEqual([]);
      expect(i.c).toEqual(['copia_fallida', 'divergencia']);
    });

    it('con diferencias: abre divergencia, porque un evento se perdió', async () => {
      const i = incidentes();
      const conDif = plataformaFalsa((ruta) => (ruta.endsWith('/confirmar') ? { status: 200, json: { abiertas: 2, cerradas: 1 } } : feliz(ruta)));
      const r = await copiaDiaria(db, { url: 'http://p', keyring, fetch: conDif.fetch }, i);
      expect(r.diferencias).toBe(6);
      expect(i.a).toEqual(['divergencia']);
    });

    it('si falla, abre copia_fallida', async () => {
      const i = incidentes();
      const caida = { fetch: async () => { throw new Error('ECONNREFUSED'); } };
      const sin = { url: 'http://p', keyring, fetch: caida.fetch };
      await expect(copiaDiaria(db, sin, i)).rejects.toThrow();
      expect(i.a).toEqual(['copia_fallida']);
    }, 20_000);
  });
});
