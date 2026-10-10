import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db/index.js';
import { colaCasos } from '../lib/catalogoVinculos.js';
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
      // 70 masivos + 5 del fixture visibles en "abiertos" (MLA5 va a intervención). Con la base anonimizada (~24) sube.
      expect(r.total).toBe(75);
      expect(r.data).toHaveLength(50);
      const segunda = colaCasos(db, { filtro: 'abiertos', limit: 50, offset: 50 });
      expect(segunda.data.length).toBe(25);
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
