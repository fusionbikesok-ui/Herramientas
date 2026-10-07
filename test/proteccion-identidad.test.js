import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { modoProteccion, frenaIdentidad, sqlFrenaIdentidad, clavesSinVinculoAFrenar, CLASIFICACIONES_SIN_VINCULO } from '../lib/proteccionIdentidad.js';

const TEST_DB = './test/proteccion-identidad.sqlite';
const TS = '2026-10-07T12:00:00.000Z';

describe('proteccionIdentidad', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  const pub = (clave, sellerSku, extra = {}) => db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(clave, clave.split('|')[0], clave.split('|')[1] || '', 'x', extra.status ?? 'active', sellerSku, extra.cantidad ?? 5);
  const decision = (clave, sku, accion = 'confirmar') => db.prepare(
    "INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,datetime('now'))").run(clave, sku, accion);
  const caso = (clave, clasificacion, estado = 'urgente') => db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,?,'urgente','fp',?,?)`).run(clave, clasificacion, estado, TS, TS);

  describe('modoProteccion', () => {
    it('default sombra; valores válidos; inválido cuenta como sombra', () => {
      expect(modoProteccion({})).toBe('sombra');
      expect(modoProteccion({ IDENTIDAD_PROTECCION: 'activo' })).toBe('activo');
      expect(modoProteccion({ IDENTIDAD_PROTECCION: ' Apagado ' })).toBe('apagado');
      expect(modoProteccion({ IDENTIDAD_PROTECCION: 'sombra' })).toBe('sombra');
      expect(modoProteccion({ IDENTIDAD_PROTECCION: 'loquesea' })).toBe('sombra');
    });
  });

  describe('R2: el SKU manda (publicación vinculada)', () => {
    it('seller_sku igual al vinculado con gtin_contradictorio: sigue normal', () => {
      pub('MLA1|', 'FB-1'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'gtin_contradictorio');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(false);
    });
    it('seller_sku igual al vinculado con contradiccion_titulo: sigue normal', () => {
      pub('MLA1|', 'FB-1'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'contradiccion_titulo');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(false);
    });
    it('seller_sku distinto con contradicción: frena', () => {
      pub('MLA1|', 'FB-9'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'gtin_contradictorio');
      expect(frenaIdentidad(db, 'MLA1|')).toMatchObject({ frena: true, motivo: 'contradiccion_sku_distinto' });
    });
    it('seller_sku faltante con contradicción: frena', () => {
      pub('MLA1|', null); decision('MLA1|', 'FB-1'); caso('MLA1|', 'contradiccion_titulo', 'tomado');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(true);
    });
    it('intervencion frena aunque el SKU sea igual', () => {
      pub('MLA1|', 'FB-1'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'sku_exacto', 'intervencion');
      expect(frenaIdentidad(db, 'MLA1|')).toMatchObject({ frena: true, motivo: 'intervencion' });
    });
    it('decision_no_aplicada y pendiente no frenan', () => {
      pub('MLA1|', 'FB-9'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'decision_no_aplicada', 'pendiente');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(false);
    });
    it('caso cerrado (verificado/resuelto/exceptuado) no frena', () => {
      pub('MLA1|', 'FB-9'); decision('MLA1|', 'FB-1'); caso('MLA1|', 'gtin_contradictorio', 'resuelto');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(false);
    });
    it('clave sin caso no frena', () => {
      pub('MLA1|', 'FB-1'); decision('MLA1|', 'FB-1');
      expect(frenaIdentidad(db, 'MLA1|')).toMatchObject({ frena: false });
    });
    it('omitir nunca frena (no se sincroniza)', () => {
      pub('MLA1|', 'FB-9'); decision('MLA1|', null, 'omitir'); caso('MLA1|', 'sku_inexistente', 'urgente');
      expect(frenaIdentidad(db, 'MLA1|')).toMatchObject({ frena: false, motivo: 'omitir' });
    });
  });

  describe('R4: sin decisión con caso abierto', () => {
    it.each(CLASIFICACIONES_SIN_VINCULO)('%s frena', (cl) => {
      pub('MLA1|', null); caso('MLA1|', cl);
      expect(frenaIdentidad(db, 'MLA1|')).toMatchObject({ frena: true, motivo: `sin_vinculo:${cl}` });
    });
    it('otra clasificación sin decisión (p. ej. gtin_contradictorio) no frena por R4', () => {
      pub('MLA1|', 'FB-1'); caso('MLA1|', 'gtin_contradictorio');
      expect(frenaIdentidad(db, 'MLA1|').frena).toBe(false);
    });
  });

  describe('SQL equivalente (la CTE del sync)', () => {
    it('da lo mismo que frenaIdentidad sobre el mismo fixture', () => {
      const casos = [
        ['A', 'FB-1', 'FB-1', 'gtin_contradictorio', 'urgente'],
        ['B', 'FB-9', 'FB-1', 'gtin_contradictorio', 'urgente'],
        ['C', null, 'FB-1', 'contradiccion_titulo', 'tomado'],
        ['D', 'FB-1', 'FB-1', 'sku_exacto', 'intervencion'],
        ['E', 'FB-9', 'FB-1', 'decision_no_aplicada', 'pendiente'],
        ['F', 'FB-9', 'FB-1', 'gtin_contradictorio', 'resuelto'],
        ['G', 'FB-1', 'FB-1', null, null],
      ];
      for (const [n, seller, vinc, cl, est] of casos) {
        pub(`MLA${n}|`, seller); decision(`MLA${n}|`, vinc);
        if (cl) caso(`MLA${n}|`, cl, est);
      }
      const sql = db.prepare(`SELECT d.clave, ${sqlFrenaIdentidad('d.clave', 'd.sku')} AS f FROM sku_matcher_decisiones d ORDER BY d.clave`).all();
      for (const r of sql) expect(!!r.f, r.clave).toBe(frenaIdentidad(db, r.clave).frena);
      expect(sql.filter((r) => r.f).map((r) => r.clave)).toEqual(['MLAB|', 'MLAC|', 'MLAD|']);
    });
  });

  describe('clavesSinVinculoAFrenar (R4 para el sync)', () => {
    it('lista activas con stock, sin decisión y con caso abierto, con su clasificación', () => {
      pub('MLA1|', null); caso('MLA1|', 'sku_ausente');                       // sí
      pub('MLA2|', 'X'); caso('MLA2|', 'sku_inexistente', 'tomado');          // sí
      pub('MLA3|', null); caso('MLA3|', 'sku_ausente', 'resuelto');           // caso cerrado
      pub('MLA4|', null); caso('MLA4|', 'sku_ausente'); decision('MLA4|', null, 'omitir'); // omitir
      pub('MLA5|', 'FB-1'); caso('MLA5|', 'sku_ausente'); decision('MLA5|', 'FB-1');       // vinculada
      pub('MLA6|', null, { status: 'paused' }); caso('MLA6|', 'sku_ausente'); // pausada
      pub('MLA7|', null, { cantidad: 0 }); caso('MLA7|', 'sku_ausente');      // sin stock
      const r = clavesSinVinculoAFrenar(db);
      expect(r.map((x) => [x.clave, x.clasificacion])).toEqual([['MLA1|', 'sku_ausente'], ['MLA2|', 'sku_inexistente']]);
    });
  });
});
