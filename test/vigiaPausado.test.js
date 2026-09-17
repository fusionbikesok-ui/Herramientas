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

  describe('ruido de catalog_product_id', () => {
    const previo = (n, anterior, nuevo, hace = 3600e3) => db.prepare(`INSERT INTO ml_publicacion_cambios
      (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en) VALUES (?,?,?,?,?,?,0,?)`)
      .run(`MLA${n}|`, `MLA${n}`, `FB-${n}`, 'catalog_product_id', anterior, nuevo, new Date(Date.now() - hace).toISOString());

    it('producto → vacío se asienta cerrado y no pausa', async () => {
      const r = await procesarCambios(db, CFG, [cambio(1, { valor_anterior: 'MLA44441017', valor_nuevo: null })]);
      expect(r).toMatchObject({ pausadas: 0, ignorados_por_ruido: 1 });
      expect(mlFetch).not.toHaveBeenCalled();
      const f = db.prepare('SELECT * FROM ml_publicacion_cambios').get();
      expect(f.revisado_por).toBe('vigia-auto');
      expect(f.revisado_en).not.toBeNull();
      expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(0);
    });

    it('vacío → producto ya visto en 7 días no pausa', async () => {
      previo(1, 'MLA44441017', null);
      const r = await procesarCambios(db, CFG, [cambio(1)]);
      expect(r).toMatchObject({ pausadas: 0, ignorados_por_ruido: 1 });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('oscilación A→B→A no pausa', async () => {
      previo(1, 'MLA1', 'MLA44441017');
      const r = await procesarCambios(db, CFG, [cambio(1, { valor_anterior: 'MLA44441017', valor_nuevo: 'MLA1' })]);
      expect(r.pausadas).toBe(0);
    });

    it('un valor visto hace más de 7 días vuelve a pausar', async () => {
      previo(1, 'MLA44441017', null, 8 * 86400e3);
      const r = await procesarCambios(db, CFG, [cambio(1)]);
      expect(r.pausadas).toBe(1);
    });

    it('el historial de OTRA publicación no cuenta', async () => {
      previo(2, 'MLA44441017', null);
      expect((await procesarCambios(db, CFG, [cambio(1)])).pausadas).toBe(1);
    });

    it('el ruido no cuenta para el umbral de pausa masiva', async () => {
      const ruido = Array.from({ length: UMBRAL_PAUSA_MASIVA + 3 }, (_, i) => cambio(100 + i, { valor_anterior: 'X', valor_nuevo: null }));
      const r = await procesarCambios(db, CFG, [...ruido, cambio(1)]);
      expect(r).toMatchObject({ pausadas: 1, omitidos_por_umbral: 0, ignorados_por_ruido: UMBRAL_PAUSA_MASIVA + 3 });
    });

    it('UNITS_PER_PACK a vacío sigue pausando', async () => {
      const r = await procesarCambios(db, CFG, [cambio(1, { campo: 'UNITS_PER_PACK', valor_anterior: '2', valor_nuevo: null })]);
      expect(r.pausadas).toBe(1);
    });

    it('publicación creada hace poco: vacío → producto no pausa', async () => {
      const r = await procesarCambios(db, CFG, [cambio(1, { creada_en: new Date(Date.now() - 3600e3).toISOString() })]);
      expect(r).toMatchObject({ pausadas: 0, ignorados_por_ruido: 1 });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('publicación vieja: vacío → producto nuevo sigue pausando', async () => {
      const r = await procesarCambios(db, CFG, [cambio(1, { creada_en: '2025-01-01T00:00:00.000Z' })]);
      expect(r.pausadas).toBe(1);
    });

    it('publicación nueva: salto entre dos productos sí pausa', async () => {
      const r = await procesarCambios(db, CFG, [cambio(1, { valor_anterior: 'MLA1', creada_en: new Date().toISOString() })]);
      expect(r.pausadas).toBe(1);
    });
  });
});
