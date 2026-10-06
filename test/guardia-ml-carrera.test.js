import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { escanearGuardiaMl, encolarOperacionGuardia, procesarOperacionesGuardia } from '../lib/guardiaMl.js';
import { marcarClaveNoSincroniza } from '../lib/identidadProductos.js';

// El hook corre dentro del await remoto: simula al humano que marca "No sincronizar" mientras ML responde.
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: async () => { if (globalThis.__hookMl) { const h = globalThis.__hookMl; globalThis.__hookMl = null; h(); } return { status: 200, ok: true, data: {} }; },
  categorizarErrorMl: () => 'interno',
  estadoCooldownMl: () => ({ activo: false }),
}));

const FILE = './test/tmp-guardia-carrera.sqlite';
const now = () => new Date().toISOString();

describe('worker de Guardia ML: No sincronizar durante la operación remota', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); db.prepare("UPDATE guardia_ml_config SET modo='acciones' WHERE id=1").run(); });
  afterEach(() => { globalThis.__hookMl = null; db.close(); if (fs.existsSync(FILE)) fs.unlinkSync(FILE); });

  function preparar({ overrideOmitir }) {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (1,'Casco urbano negro','FB-9','simple',2,?)`).run(now());
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
      VALUES ('MLA-R|','MLA-R','','Casco urbano negro','active','',2,?)`).run(now());
    escanearGuardiaMl(db);
    const caso = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA-R|'").get();
    db.prepare("UPDATE guardia_ml_casos SET estado='pendiente_ml' WHERE id=?").run(caso.id);
    encolarOperacionGuardia(db, { casoId: caso.id, tipo: 'vincular', sku: 'FB-9', overrideOmitir });
    return caso.id;
  }

  for (const overrideOmitir of [false, true]) {
    it(`un omitir humano posterior no se pisa ni se marca completada (override_omitir=${overrideOmitir})`, async () => {
      preparar({ overrideOmitir });
      globalThis.__hookMl = () => {
        const r = marcarClaveNoSincroniza(db, { clave: 'MLA-R|', actor: 'ana', expectedSku: null });
        expect(r.ok).toBe(true);
      };
      await procesarOperacionesGuardia(db, { ml: {} });
      expect(db.prepare('SELECT estado FROM guardia_ml_operaciones ORDER BY id DESC LIMIT 1').get().estado).not.toBe('completada');
      expect(db.prepare("SELECT accion,sku,confirmado_por FROM sku_matcher_decisiones WHERE clave='MLA-R|'").get())
        .toMatchObject({ accion: 'omitir', sku: null, confirmado_por: 'ana' });
      expect(db.prepare("SELECT 1 FROM guardia_ml_eventos WHERE evento='operacion_cancelada_por_omitir'").get()).toBeTruthy();
    });
  }

  it('sin carrera, la operación se completa y vincula como siempre', async () => {
    preparar({ overrideOmitir: false });
    await procesarOperacionesGuardia(db, { ml: {} });
    expect(db.prepare('SELECT estado FROM guardia_ml_operaciones ORDER BY id DESC LIMIT 1').get().estado).toBe('completada');
    expect(db.prepare("SELECT accion,sku FROM sku_matcher_decisiones WHERE clave='MLA-R|'").get()).toMatchObject({ accion: 'confirmar', sku: 'FB-9' });
  });
});
