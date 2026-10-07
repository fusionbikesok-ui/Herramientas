import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { reporteSombraFaseC } from '../routes/sync.js';

const TEST_DB = './test/fase-c-sombra.sqlite';
const TS = '2026-10-07T12:00:00.000Z';

describe('Fase C: reporte de sombra', () => {
  let db; let idWoo = 0;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  const prod = (sku, stock = 7) => db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`).run(++idWoo, sku, sku, stock, TS);
  const pub = (n, sellerSku, qty = 7) => {
    const clave = `MLA${n}|`;
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en) VALUES (?,?,'','x','active',?,?,?)`).run(clave, `MLA${n}`, sellerSku, qty, TS);
    return clave;
  };
  const dec = (clave, sku, accion = 'confirmar') => db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,?)").run(clave, sku, accion, TS);
  const caso = (clave, clasificacion, estado = 'urgente') => db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,?,'urgente','fp',?,?)`).run(clave, clasificacion, estado, TS, TS);
  const guardia = (clave) => db.prepare(`INSERT INTO guardia_ml_casos (clave,estado,motivo,bloquea_sync,creado_en,actualizado_en) VALUES (?,'abierto','sin_cobertura',1,?,?)`).run(clave, TS, TS);

  it('gtin_contradictorio con SKU igual sale como sin cambio; omitir no aparece', () => {
    prod('FB-1'); const a = pub(1, 'FB-1'); dec(a, 'FB-1'); caso(a, 'gtin_contradictorio');
    prod('FB-2'); const b = pub(2, 'FB-2'); dec(b, 'FB-2', 'omitir'); guardia(b);
    const r = reporteSombraFaseC(db);
    expect(r.cambian).toEqual([]);
    expect(r.sin_cambio).toBe(1);
    expect(JSON.stringify(r)).not.toContain('MLA2|');
  });

  it('intervención baja a 0 con su regla; Guardia que bloqueaba y ya no, pasa a enviar', () => {
    prod('FB-3'); const a = pub(3, 'FB-3'); dec(a, 'FB-3'); caso(a, 'sku_exacto', 'intervencion');
    prod('FB-4'); const b = pub(4, 'FB-4'); dec(b, 'FB-4'); guardia(b);
    const r = reporteSombraFaseC(db);
    const ra = r.cambian.find((x) => x.clave === a);
    expect(ra).toMatchObject({ antes: 7, despues: 0, regla: 'intervencion' });
    const rb = r.cambian.find((x) => x.clave === b);
    expect(rb).toMatchObject({ antes: null, despues: 7, regla: 'guardia_deja_de_bloquear' });
  });

  it('autovínculo (sin escribir) y R4 por clasificación', () => {
    prod('FB-5'); const a = pub(5, 'FB-5');
    const b = pub(6, ''); caso(b, 'sku_ausente');
    const c = pub(7, 'NOEXISTE'); caso(c, 'sku_inexistente');
    const d = pub(8, 'FB-5'); // ambiguo con a
    const e = pub(9, 'X'); caso(e, 'stock_no_verificado', 'pendiente');
    const r = reporteSombraFaseC(db);
    expect(r.se_vincularian).toEqual([]); // a y d comparten SKU: ninguna
    expect(r.a_cero_por_r4.por_clasificacion).toEqual({ sku_ausente: 1, sku_inexistente: 1 });
    expect(r.sin_decision_sin_frenar.por_clasificacion).toEqual({ stock_no_verificado: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones').get().n).toBe(0);
    void a; void d;
  });

  it('autovínculo: SKU exacto y único se informa y no se escribe', () => {
    prod('FB-10'); const a = pub(10, 'FB-10');
    const r = reporteSombraFaseC(db);
    expect(r.se_vincularian.map((x) => x.clave)).toEqual([a]);
    expect(db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones').get().n).toBe(0);
  });
});
