/**
 * Camino real de routes/sync.js (_procesarOrden vía syncMlToWc): una venta de una clave "no sincronizar"
 * (Fase D) se retiene SIEMPRE, aunque el seller_sku de la venta resuelva a un único producto del catálogo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncMlToWc } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const FILE = './test/tmp-sync-no-sincronizar.sqlite';
const CFG = { ml: { clientId: 'c', clientSecret: 's', userId: '99999' }, woo: { url: 'https://x', ck: 'a', cs: 'b' } };
const now = () => new Date().toISOString();

describe('_procesarOrden con "no sincronizar"', () => {
  let db;
  beforeEach(() => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    db = openDb(FILE);
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,regular_price,actualizado_en) VALUES (100,?,?,?,5,300,300,?)')
      .run('Bicicleta', 'BIKE-UNICO', 'simple', now());
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,status,seller_sku,actualizado_en)
      VALUES ('MLA300|','MLA300','','active',NULL,?)`).run(now());
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });

  for (const variante of ['a', 'b', 'c']) {
    it(`variante ${variante}: la venta con seller_sku único queda retenida y no crea pedido en Woo`, async () => {
      db.prepare(`INSERT INTO sku_matcher_decisiones (clave,sku,accion,origen,actualizado_en) VALUES ('MLA300|',NULL,'omitir',?,?)`)
        .run(`no_sincronizar_${variante}`, now());
      const orden = { id: `ORD-NS-${variante}`, date_created: '2026-10-01T00:00:00Z', status: 'paid',
        buyer: { first_name: 'A', last_name: 'B', nickname: 'ab', email: 'a@b.c' },
        order_items: [{ item: { id: 'MLA300', variation_id: '', seller_sku: 'BIKE-UNICO' }, quantity: 1, unit_price: 100 }] };
      mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
      wooFetch.mockImplementation(async () => { throw new Error('no debe llamarse a Woo'); });

      const p = syncMlToWc(db, CFG);
      await vi.runAllTimersAsync();
      await p;

      expect(wooFetch).not.toHaveBeenCalled();
      expect(db.prepare("SELECT estado FROM guardia_ml_pedidos_retenidos WHERE ml_order_id=?").get(orden.id)?.estado).toBe('retenido');
    });
  }
});
