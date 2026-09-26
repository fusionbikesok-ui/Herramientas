import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { reclasificar } from '../scripts/vigia-reclasificar-abiertos.mjs';

const TEST_DB = './test/vigia-reclasif.sqlite';
const CFG = {};
describe('vigia-reclasificar-abiertos', () => {
  let db;
  const fila = (item, ant, nue, id) => db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en) VALUES (?,?,?,?,?,?,0,?)`)
    .run(`${item}|`, item, 's', 'catalog_product_id', ant, nue, new Date().toISOString());
  const cache = (item, q) => db.prepare(`INSERT INTO ml_publicaciones_cache (item_id,status,available_quantity,actualizado_en) VALUES (?,?,?,?)`).run(item, 'active', q, 'now');
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); mlFetch.mockResolvedValue({ status: 200, data: { last_updated: '2000-01-01T00:00:00Z' } }); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('dry-run no escribe; apply cierra sin stock y deja migración abierta; sin escrituras a ML', async () => {
    fila('MLA1', 'A', 'B'); cache('MLA1', 0);
    fila('MLA2', 'X', 'Y'); fila('MLA3', 'X', 'Y'); cache('MLA2', 5); cache('MLA3', 5);
    const seco = await reclasificar(db, CFG);
    expect(seco.items.find((i) => i.item_id === 'MLA1').accion).toBe('cerrar_sin_stock');
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE revisado_en IS NULL').get().n).toBe(3);
    await reclasificar(db, CFG, { apply: true });
    const f = db.prepare("SELECT * FROM ml_publicacion_cambios WHERE item_id='MLA1'").get();
    expect(f.revisado_por).toBe('vigia-auto'); expect(f.bloquea_reactivador).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE item_id IN ('MLA2','MLA3') AND revisado_en IS NULL").get().n).toBe(2);
    expect(mlFetch.mock.calls.every((c) => c[2] === 'get')).toBe(true);
  });

  it('tope de lecturas y fail-closed ante error', async () => {
    for (let i = 0; i < 8; i++) { fila(`MLB${i}`, `V${i}`, `N${i}`); cache(`MLB${i}`, 3); }
    mlFetch.mockRejectedValue(new Error('429'));
    const r = await reclasificar(db, CFG);
    expect(mlFetch.mock.calls.length).toBeLessThanOrEqual(10);
    expect(r.items.every((i) => i.accion === 'dejar_abierto')).toBe(true);
  });
});
