import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { refrescarPublicacionesMlAcotado } from '../routes/matcher.js';

const TEST_DB = './test/vigia-refresco.sqlite';
// `userId` es obligatorio: mlCfgOk de routes/matcher.js:209 lo exige y, sin él, el refresco
// aborta con "Configuración de MercadoLibre incompleta" antes de llegar a la detección.
// Mismo valor que usa test/cobertura-actualizar-ml.test.js.
const CFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

// Responde el multiget de /items con un item simple y el catalog_product_id pedido.
function mockItems(catalogProductId) {
  mlFetch.mockImplementation(async (_db, _cfg, metodo, url) => {
    if (metodo === 'get' && url.includes('/items/bulk?ids=')) {
      return { status: 200, data: [{ code: 200, body: {
        id: 'MLA1', title: 'Cubierta', status: 'active', sub_status: [],
        // El SKU sale del ATRIBUTO SELLER_SKU, no de seller_custom_field: skuDesdeAtributosMl
        // ignora ese campo a propósito (lib/modelos/publicacionMl.js:45).
        seller_custom_field: 'FB-64881',
        attributes: [{ id: 'SELLER_SKU', name: 'SKU', value_name: 'FB-64881' }], variations: [],
        thumbnail: 't', permalink: 'p', catalog_listing: !!catalogProductId,
        catalog_product_id: catalogProductId, price: 302585, available_quantity: 3,
      } }] };
    }
    return { status: 200, data: {} };
  });
}

describe('vigía enganchado al refresco', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('la primera corrida no detecta nada (no hay línea base)', async () => {
    mockItems(null);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(0);
  });

  // El caso GP5000: segunda corrida, ahora atada a un producto de catálogo distinto.
  it('la segunda corrida con otro catalog_product_id detecta, pausa y asienta', async () => {
    mockItems(null);
    await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    mockItems('MLA44441017');
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(1);
    expect(r.vigia.pausadas).toBe(1);
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.campo).toBe('catalog_product_id');
    expect(fila.valor_nuevo).toBe('MLA44441017');
  });

  // El auto-vínculo por seller_sku existía y estaba testeado desde el incidente del
  // 2026-08-27, pero NADIE lo llamaba fuera de los tests: las publicaciones nuevas con un SKU
  // correcto quedaban sin vincular y por lo tanto sin sincronizar stock. Este test fija el
  // CABLEADO, no la función: que el refresco efectivamente lo corra.
  it('el refresco auto-vincula una publicación cuyo seller_sku existe en Woo', async () => {
    db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en)
      VALUES (1, 'Casco Giro Isode', 'FB-64881', 'simple', 3, datetime('now'))`).run();
    mockItems(null);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);

    expect(r.auto_vinculadas).toBe(1);
    const d = db.prepare("SELECT sku, accion, origen FROM sku_matcher_decisiones WHERE clave='MLA1|'").get();
    expect(d).toMatchObject({ sku: 'FB-64881', accion: 'asignar', origen: 'auto_seller_sku' });
  });

  it('no auto-vincula si ese SKU no existe en Woo', async () => {
    mockItems(null);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.auto_vinculadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones').get().n).toBe(0);
  });

  it('una corrida sin cambios no asienta nada', async () => {
    mockItems('MLA44441017');
    await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    const r = await refrescarPublicacionesMlAcotado(db, CFG, ['MLA1']);
    expect(r.vigia.detectados).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios').get().n).toBe(0);
  });
});
