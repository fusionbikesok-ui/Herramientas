import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db/index.js';
import { colaCasos } from '../lib/catalogoVinculos.js';
import { buscarProductosFusion } from '../lib/identidadProductos.js';
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
