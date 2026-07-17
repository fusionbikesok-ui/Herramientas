import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { getMapeoConocido, guardarMapeo, registrarNuevosPendientes, resolverMapeoPendientes } from '../db/mapeo.js';

const TEST_DB = './test/tmp-mapeo.sqlite';

describe('mapeo data layer', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('guardarMapeo then getMapeoConocido returns saved relations', () => {
    const db = openDb(TEST_DB);
    guardarMapeo(db, [{ clave: 'casco-bell-l', idWoo: 101, variacion: 'Talle L' }]);
    const mapa = getMapeoConocido(db);
    expect(mapa['casco-bell-l']).toEqual({ idWoo: 101, variacion: 'Talle L' });
    db.close();
  });

  it('registrarNuevosPendientes inserts unresolved rows', () => {
    const db = openDb(TEST_DB);
    registrarNuevosPendientes(db, [{ nombreOriginal: 'Casco Bell XL', claveNormalizada: 'casco-bell-xl' }]);
    const row = db.prepare('SELECT * FROM pendientes_mapeo WHERE clave_normalizada = ?').get('casco-bell-xl');
    expect(row.resuelto).toBe(0);
    db.close();
  });

  it('resolverMapeoPendientes marks resolved when catalogo has matching sku/nombre', () => {
    const db = openDb(TEST_DB);
    registrarNuevosPendientes(db, [{ nombreOriginal: 'Casco Bell XL', claveNormalizada: 'casco-bell-xl' }]);
    const resultado = resolverMapeoPendientes(db, [{ id_woo: 5, nombre: 'Casco Bell XL', sku: 'CBXL', tipo: 'simple', id_padre: null, stock: 3 }]);
    expect(resultado.resueltos).toBe(1);
    const row = db.prepare('SELECT resuelto FROM pendientes_mapeo WHERE clave_normalizada = ?').get('casco-bell-xl');
    expect(row.resuelto).toBe(1);
    db.close();
  });
});
