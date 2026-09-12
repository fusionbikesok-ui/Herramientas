import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { procesarCambios, UMBRAL_PAUSA_MASIVA } from '../lib/vigiaPausado.js';

const TEST_DB = './test/vigia-pausado.sqlite';
const CFG = { clientId: 'x', clientSecret: 'y', redirectUri: 'z' };

function cambio(n, extra = {}) {
  return { clave: `MLA${n}|`, item_id: `MLA${n}`, sku: `FB-${n}`, campo: 'catalog_product_id',
    valor_anterior: null, valor_nuevo: 'MLA44441017', ...extra };
}

describe('vigiaPausado', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); mlFetch.mockResolvedValue({ status: 200, data: {} }); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('un cambio se asienta, se pausa en ML y abre incidente', async () => {
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(r.detectados).toBe(1);
    expect(r.pausadas).toBe(1);
    expect(mlFetch).toHaveBeenCalledWith(db, CFG, 'put', '/items/MLA1', { status: 'paused' });
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.pausada).toBe(1);
    expect(fila.revisado_en).toBeNull();
    const inc = db.prepare("SELECT * FROM incidentes_operativos WHERE proceso='vigia_formato'").get();
    expect(inc.severidad).toBe('critico');
  });

  it('sin cambios no hace nada ni abre incidente', async () => {
    const r = await procesarCambios(db, CFG, []);
    expect(r).toMatchObject({ detectados: 0, pausadas: 0 });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(0);
  });

  it('superado el umbral no pausa NINGUNA y abre un solo incidente', async () => {
    const muchos = Array.from({ length: UMBRAL_PAUSA_MASIVA + 1 }, (_, i) => cambio(i + 1));
    const r = await procesarCambios(db, CFG, muchos);
    expect(r.pausadas).toBe(0);
    expect(r.omitidos_por_umbral).toBe(UMBRAL_PAUSA_MASIVA + 1);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios').get().n).toBe(UMBRAL_PAUSA_MASIVA + 1);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE pausada=1').get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('justo en el umbral SÍ pausa', async () => {
    const justos = Array.from({ length: UMBRAL_PAUSA_MASIVA }, (_, i) => cambio(i + 1));
    const r = await procesarCambios(db, CFG, justos);
    expect(r.pausadas).toBe(UMBRAL_PAUSA_MASIVA);
  });

  it('si ML rechaza el pausado, el cambio queda asentado con el error y el aviso sale igual', async () => {
    mlFetch.mockResolvedValue({ status: 403, data: { message: 'forbidden' } });
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(r.pausadas).toBe(0);
    expect(r.errores).toBe(1);
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
    expect(fila.pausada).toBe(0);
    expect(fila.pausa_error).toContain('403');
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('una publicación YA pausada no se vuelve a pausar, pero el cambio se asienta y avisa', async () => {
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
      VALUES ('MLA1|','MLA1','','x','paused','out_of_stock',0,datetime('now'))`).run();
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(r.pausadas).toBe(1);
    expect(r.errores).toBe(0);
    expect(db.prepare('SELECT pausada FROM ml_publicacion_cambios').get().pausada).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('dos cambios del mismo item pausan una sola vez', async () => {
    const r = await procesarCambios(db, CFG, [cambio(1), cambio(1, { campo: 'UNITS_PER_PACK', valor_anterior: '1', valor_nuevo: '2' })]);
    expect(r.detectados).toBe(2);
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE pausada=1').get().n).toBe(2);
  });
});
