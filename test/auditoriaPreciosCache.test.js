import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { sincronizarAuditoriaPreciosDesdeCache, _reiniciarAuditoriaParaTests } from '../lib/auditoriaPrecios.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const PATH = './test/tmp-auditoria-precios-cache.sqlite';
const CFG = { clientId: 'c', clientSecret: 's', userId: '9' };
const now = () => new Date().toISOString();

function seed(db, { clave = 'MLA1|', activo = true, regular = 1500 } = {}) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,es_variante,precio,category_id,listing_type_id,free_shipping,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(clave, 'MLA1', '', 'Casco', activo ? 'active' : 'paused', 0, 1000, 'MLA1', 'gold_special', 1, now());
  db.prepare('INSERT INTO sku_matcher_decisiones (clave,sku,wc_nombre,accion,actualizado_en) VALUES (?,?,?,?,?)')
    .run(clave, 'FB-1', 'Casco', 'confirmar', now());
  db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,regular_price,actualizado_en) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 'Casco', 'FB-1', 'simple', 2, regular, regular, now());
}

describe('auditoría de precios desde caché', () => {
  let db;
  beforeEach(() => {
    db = openDb(PATH); vi.clearAllMocks(); _reiniciarAuditoriaParaTests();
    // La auditoría no necesita token si comisión/envío ya están cacheados.
  });
  afterEach(() => { db.close(); if (fs.existsSync(PATH)) fs.unlinkSync(PATH); });

  it('calcula localmente, sin pedir /items, y no reescribe una huella intacta', async () => {
    seed(db);
    db.prepare('INSERT INTO ml_precios_cache (clave,valor,actualizado_en) VALUES (?,?,?)').run('fee:1000:MLA1:gold_special', 100, now());
    db.prepare('INSERT INTO ml_precios_cache (clave,valor,actualizado_en) VALUES (?,?,?)').run('envio:MLA1:1000', 50, now());
    axios.request.mockImplementation(() => { throw new Error('no debe consultar ML'); });

    const primera = await sincronizarAuditoriaPreciosDesdeCache(db, { origen: 'test', mlCfg: CFG });
    expect(primera.recalculadas).toBe(1);
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT neto,estado,pendiente_motivo FROM ml_precio_auditoria WHERE clave=?').get('MLA1|'))
      .toMatchObject({ neto: 850, estado: 'bajo', pendiente_motivo: null });

    const segunda = await sincronizarAuditoriaPreciosDesdeCache(db, { origen: 'test', mlCfg: CFG });
    expect(segunda.sin_cambios).toBe(1);
  });

  it('poda una fila que dejó de estar activa sólo bajo snapshot ML confirmado', async () => {
    seed(db);
    db.prepare('INSERT INTO ml_precios_cache (clave,valor,actualizado_en) VALUES (?,?,?)').run('fee:1000:MLA1:gold_special', 100, now());
    db.prepare('INSERT INTO ml_precios_cache (clave,valor,actualizado_en) VALUES (?,?,?)').run('envio:MLA1:1000', 50, now());
    db.prepare(`INSERT INTO ml_precio_auditoria (clave,item_id,titulo,sku,estado,actualizado_en)
      VALUES ('MLA-VIEJA|','MLA-VIEJA','Vieja','FB-1','ok',?)`).run(now());
    await sincronizarAuditoriaPreciosDesdeCache(db, { origen: 'ml_completo', podar: true, mlCfg: CFG });
    expect(db.prepare("SELECT 1 FROM ml_precio_auditoria WHERE clave='MLA-VIEJA|'").get()).toBeUndefined();
  });
});
