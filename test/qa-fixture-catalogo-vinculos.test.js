import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db/index.js';
import { colaCasos } from '../lib/catalogoVinculos.js';
import express from 'express';
import request from 'supertest';
import {
  buscarProductosFusion, conflictosDeIdentificador, detalleConflictoIdentificador, marcarIdentificadorIncorrecto,
} from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';
import {
  sembrar, limpiarSembrado, parsearArgs, validarDestino, MASIVOS_MAX,
} from '../scripts/qa/fixtures/catalogo-vinculos.mjs';

// Base NUEVA en un directorio temporal propio (no la de QA ni la de prod, ni test/tmp compartidos).
function baseTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qafx-masivos-'));
  const ruta = path.join(dir, 'fusion.sqlite');
  return { dir, ruta, db: openDb(ruta) };
}

describe('scripts/qa/fixtures/catalogo-vinculos --masivos', () => {
  it('parsearArgs separa --masivos (con espacio o con =) de la ruta, y default 0', () => {
    expect(parsearArgs(['--masivos', '70', '/tmp/x.sqlite', '--permitir-copia'])).toEqual({ masivos: 70, posicional: ['/tmp/x.sqlite'] });
    expect(parsearArgs(['--masivos=5'])).toEqual({ masivos: 5, posicional: [] });
    expect(parsearArgs(['--limpiar'])).toEqual({ masivos: 0, posicional: [] });
  });

  it('rechaza valores no enteros o fuera de rango antes de tocar la base', () => {
    expect(() => parsearArgs(['--masivos'])).toThrow(/--masivos/);
    expect(() => parsearArgs(['--masivos', 'abc'])).toThrow(/--masivos/);
    expect(() => parsearArgs(['--masivos', '-3'])).toThrow(/--masivos/);
    expect(() => parsearArgs([`--masivos=${MASIVOS_MAX + 1}`])).toThrow(/--masivos/);
  });

  it('validarDestino sigue rehusando la ruta de producción', () => {
    expect(() => validarDestino('/opt/fusionbikes/herramientas/data/fusion.sqlite', { permitirCopia: true })).toThrow(/PRODUCCIÓN/);
  });

  it('siembra N casos abiertos que la cola lista, y la cola pagina con limit/offset', () => {
    const { dir, db } = baseTemporal();
    try {
      db.transaction(() => sembrar(db, { masivos: 70 }))();
      const r = colaCasos(db, { filtro: 'abiertos', limit: 50, offset: 0 });
      // 70 masivos + 6 del fixture visibles en "abiertos" (MLA5 va a intervención; MLA8 es el caso con foto).
      // Con la base anonimizada (~24) sube.
      expect(r.total).toBe(76);
      expect(r.data).toHaveLength(50);
      const segunda = colaCasos(db, { filtro: 'abiertos', limit: 50, offset: 50 });
      expect(segunda.data.length).toBe(26);
      const claves = [...r.data, ...segunda.data].map((f) => f.ml_key);
      expect(new Set(claves).size).toBe(r.total);
      expect(claves.filter((k) => /^QAFX-M\d/.test(k)).length).toBe(70);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('es idempotente: volver a sembrar no duplica ni cambia el total', () => {
    const { dir, db } = baseTemporal();
    try {
      const siembra = db.transaction(() => { limpiarSembrado(db); return sembrar(db, { masivos: 70 }); });
      siembra();
      const total1 = colaCasos(db, { filtro: 'abiertos' }).total;
      siembra();
      expect(colaCasos(db, { filtro: 'abiertos' }).total).toBe(total1);
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key GLOB 'QAFX-M[0-9]*'").get().n).toBe(70);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--limpiar (limpiarSembrado) borra también los masivos y deja la cola sin ellos', () => {
    const { dir, db } = baseTemporal();
    try {
      db.transaction(() => sembrar(db, { masivos: 70 }))();
      db.transaction(() => limpiarSembrado(db))();
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key LIKE 'QAFX-%'").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE clave LIKE 'QAFX-%'").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku LIKE 'QAFX-%'").get().n).toBe(0);
      expect(colaCasos(db, { filtro: 'abiertos' }).total).toBe(0);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('sin --masivos el modo normal no agrega casos masivos', () => {
    const { dir, db } = baseTemporal();
    try {
      db.transaction(() => sembrar(db))();
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key GLOB 'QAFX-M[0-9]*'").get().n).toBe(0);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('scripts/qa/fixtures/catalogo-vinculos: caso con foto (tecla f)', () => {
  it('QAFX-MLA8| existe, está abierto y su candidato Woo tiene imagen (catalogo_cache.img), visible en /productos/buscar', () => {
    const { dir, db } = baseTemporal();
    try {
      db.transaction(() => sembrar(db))();
      const caso = db.prepare("SELECT estado, responsable FROM identidad_casos WHERE ml_key='QAFX-MLA8|'").get();
      expect(caso).toMatchObject({ estado: 'urgente', responsable: null });
      expect(colaCasos(db, { filtro: 'abiertos' }).data.map((f) => f.ml_key)).toContain('QAFX-MLA8|');
      const woo = db.prepare("SELECT img FROM catalogo_cache WHERE sku='QAFX-SKU-8'").get();
      expect(woo.img).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(woo.img).not.toMatch(/^https?:/);
      // La búsqueda inicial del panel usa el título ML: el candidato con foto tiene que venir primero.
      const r = buscarProductosFusion(db, { q: 'QAFX Mochila hidratacion 2L' });
      expect(r[0]).toMatchObject({ sku_woo: 'QAFX-SKU-8' });
      expect(r[0].img).toBe(woo.img);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('idempotente: sembrar dos veces deja una sola fila con foto para el caso', () => {
    const { dir, db } = baseTemporal();
    try {
      const siembra = db.transaction(() => { limpiarSembrado(db); return sembrar(db); });
      siembra();
      siembra();
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key='QAFX-MLA8|'").get().n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku='QAFX-SKU-8'").get().n).toBe(1);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--limpiar quita el caso con foto y su producto', () => {
    const { dir, db } = baseTemporal();
    try {
      db.transaction(() => sembrar(db))();
      db.transaction(() => limpiarSembrado(db))();
      expect(db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku='QAFX-SKU-8'").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key='QAFX-MLA8|'").get().n).toBe(0);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('scripts/qa/fixtures/catalogo-vinculos: conflicto de GTIN para permitir_unico', () => {
  const GTIN = '07790000000010';   // canónico de 14 dígitos (EAN-13 7790000000010)
  const sembrarOk = (db) => db.transaction(() => { limpiarSembrado(db); return sembrar(db); })();
  const idDe = (db, sku) => db.prepare("SELECT id FROM productos_fusion WHERE primary_woo_id=?").get(9900100 + Number(sku)).id;

  it('el GTIN aparece en conflicto: QAFX-6 activo (único) y QAFX-7 en conflicto', () => {
    const { dir, db } = baseTemporal();
    try {
      const r = sembrarOk(db);
      expect(r.gtinConflicto).toBe('7790000000010');
      const lista = conflictosDeIdentificador(db).find((c) => c.valor_normalizado === GTIN);
      expect(lista).toMatchObject({ productos: 2 });
      const det = detalleConflictoIdentificador(db, GTIN);
      expect(det.productos.map((p) => [p.id, p.estado]).sort()).toEqual([[idDe(db, 6), 'activo'], [idDe(db, 7), 'conflicto']].sort());
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('"No le corresponde" sobre el activo único pide permitir_unico (lib y ruta); con permitir_unico se marca', async () => {
    const { dir, db } = baseTemporal();
    try {
      sembrarOk(db);
      const pid = idDe(db, 6);
      const sin = marcarIdentificadorIncorrecto(db, pid, GTIN, 'qa');
      expect(sin).toMatchObject({ ok: false, code: 'INVALID_STATE', requiere_confirmacion: 'permitir_unico' });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { username: 'jose', is_admin: true, permisos: [] }; next(); });
      app.use('/api/identidad-productos', identidadProductosRouter(db));
      const ruta = await request(app).post('/api/identidad-productos/identificadores/incorrecto')
        .send({ valor_normalizado: GTIN, producto_id: pid, motivo: 'QA' });
      expect(ruta.status).toBe(409);
      expect(ruta.body).toMatchObject({ requiere_confirmacion: 'permitir_unico' });
      const ok = await request(app).post('/api/identidad-productos/identificadores/incorrecto')
        .send({ valor_normalizado: GTIN, producto_id: pid, motivo: 'QA', permitir_unico: true });
      expect(ok.status).toBe(200);
      expect(db.prepare("SELECT estado FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=? AND producto_id=?").get(GTIN, pid).estado).toBe('incorrecto');
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('idempotente: sembrar dos veces no duplica filas del GTIN', () => {
    const { dir, db } = baseTemporal();
    try {
      sembrarOk(db);
      sembrarOk(db);
      expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=?").get(GTIN).n).toBe(2);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--limpiar saca el conflicto sin borrar filas (el trigger impide DELETE de identificadores)', () => {
    const { dir, db } = baseTemporal();
    try {
      sembrarOk(db);
      db.transaction(() => limpiarSembrado(db))();
      expect(conflictosDeIdentificador(db).find((c) => c.valor_normalizado === GTIN)).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=? AND estado IN ('activo','conflicto')").get(GTIN).n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=?").get(GTIN).n).toBe(2);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
