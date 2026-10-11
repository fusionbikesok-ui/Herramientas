import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db/index.js';
import { marcarIdentificadorIncorrecto, conflictosDeIdentificador } from '../lib/identidadProductos.js';
import { sembrar, limpiarSembrado } from '../scripts/qa/fixtures/catalogo-vinculos.mjs';

// Base NUEVA en un directorio temporal propio (no la de QA ni la de prod).
function baseTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtin-titular-unico-'));
  return { dir, db: openDb(path.join(dir, 'fusion.sqlite')) };
}

const GTIN = '07790000000010';

describe('marcarIdentificadorIncorrecto: el último reclamante deja de estar en conflicto', () => {
  const sembrarOk = (db) => db.transaction(() => { limpiarSembrado(db); return sembrar(db); })();
  const idDe = (db, sku) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(9900100 + Number(sku)).id;
  const estadoDe = (db, sku) => db.prepare(`SELECT i.estado FROM identificadores_producto i
    WHERE i.tipo='gtin' AND i.valor_normalizado=? AND i.producto_id=?`).get(GTIN, idDe(db, sku)).estado;

  it('QAFX-6 activo único + QAFX-7 en conflicto: "No le corresponde" con permitir_unico deja a QAFX-7 activo', () => {
    const { dir, db } = baseTemporal();
    try {
      sembrarOk(db);
      const r = marcarIdentificadorIncorrecto(db, idDe(db, 6), GTIN, 'qa', 'QA', { permitirUnico: true });
      expect(r).toMatchObject({ ok: true });
      expect(estadoDe(db, 6)).toBe('incorrecto');
      expect(estadoDe(db, 7)).toBe('activo');
      expect(conflictosDeIdentificador(db).find((c) => c.valor_normalizado === GTIN)).toBeUndefined();
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('no promueve si quedan varios reclamantes en conflicto (sigue siendo una disputa real)', () => {
    const { dir, db } = baseTemporal();
    try {
      sembrarOk(db);
      // Tres reclamantes: A activo, B y C en conflicto. Al descartar A quedan B y C sin titular: no se elige por regla.
      const idB = idDe(db, 7);
      const idC = idDe(db, 8);
      const filaDe = (producto) => db.prepare("SELECT * FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=? AND producto_id=?").get(GTIN, producto);
      const base = filaDe(idB);
      db.prepare(`INSERT INTO identificadores_producto (tipo,valor_normalizado,valor_crudo,subtipo,fuente,producto_id,estado,orden,creado_en,actualizado_en)
        VALUES ('gtin',?,?,?,?,?,'conflicto',?,?,?)`).run(GTIN, base.valor_crudo, base.subtipo, base.fuente, idC, base.orden, base.creado_en, base.actualizado_en);
      db.prepare("UPDATE identificadores_producto SET estado='conflicto' WHERE tipo='gtin' AND valor_normalizado=? AND producto_id=?").run(GTIN, idDe(db, 6));
      db.prepare("UPDATE identificadores_producto SET estado='activo' WHERE tipo='gtin' AND valor_normalizado=? AND producto_id=?").run(GTIN, idB);
      expect(marcarIdentificadorIncorrecto(db, idB, GTIN, 'qa', 'QA', { permitirUnico: true })).toMatchObject({ ok: true });
      const quedan = db.prepare("SELECT estado FROM identificadores_producto WHERE tipo='gtin' AND valor_normalizado=? AND estado IN ('activo','conflicto') ORDER BY producto_id").all(GTIN);
      expect(quedan.map((q) => q.estado)).toEqual(['conflicto', 'conflicto']);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
