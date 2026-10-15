// E-1c: script de operación para listar/levantar bajas de Woo vigentes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../db/index.js';
import { gestionarBajasWoo } from '../scripts/ops/bajas-woo.mjs';
import { registrarBajasWoo } from '../lib/wooBajas.js';

let db, logs;
const log = (m) => logs.push(m);
beforeEach(() => { db = openDb(':memory:'); logs = []; registrarBajasWoo(db, [{ sku: 'A-1', id_woo: 1 }, { sku: 'B-2', id_woo: 2 }]); });
afterEach(() => db.close());
const skus = () => db.prepare('SELECT sku FROM woo_bajas_confirmadas ORDER BY sku').all().map((r) => r.sku);

describe('bajas-woo', () => {
  it('listar muestra las bajas vigentes sin tocar nada', () => {
    const r = gestionarBajasWoo(db, { accion: 'listar', log });
    expect(r.bajas.map((b) => b.sku)).toEqual(['A-1', 'B-2']);
    expect(skus()).toEqual(['A-1', 'B-2']);
  });
  it('--dry-run no levanta ni encola', () => {
    const encolados = [];
    const r = gestionarBajasWoo(db, { accion: 'levantar', skus: ['A-1'], dryRun: true, encolar: (d, s) => encolados.push(...s), log });
    expect(r.levantadas).toEqual([]);
    expect(skus()).toEqual(['A-1', 'B-2']);
    expect(encolados).toEqual([]);
  });
  it('levanta los SKUs pedidos, encola su bolsa y avisa de los que no tenían baja', () => {
    const encolados = [];
    const r = gestionarBajasWoo(db, { accion: 'levantar', skus: ['A-1', 'Z-9'], encolar: (d, s) => encolados.push(...s), log });
    expect(r).toMatchObject({ levantadas: ['A-1'], inexistentes: ['Z-9'] });
    expect(skus()).toEqual(['B-2']);
    expect(encolados).toEqual(['A-1']);
  });
  it('levantar todas (skus=null)', () => {
    gestionarBajasWoo(db, { accion: 'levantar', skus: null, log });
    expect(skus()).toEqual([]);
  });
  it('acción desconocida falla', () => {
    expect(() => gestionarBajasWoo(db, { accion: 'borrar', log })).toThrow(/acción desconocida/);
  });
});
