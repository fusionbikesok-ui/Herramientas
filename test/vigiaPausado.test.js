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
    expect(r.pausadas).toBe(0);
    expect(r.sin_stock).toBe(1);
    expect(r.errores).toBe(0);
    expect(db.prepare('SELECT pausada FROM ml_publicacion_cambios').get().pausada).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigia_formato'").get().n).toBe(1);
  });

  it('sin stock auto-cierra el cambio y bloquea al reactivador', async () => {
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,sub_status,available_quantity,actualizado_en)
      VALUES ('MLA1|','MLA1','','x','paused','out_of_stock',0,datetime('now'))`).run();
    const r = await procesarCambios(db, CFG, [cambio(1)]);
    expect(r).toMatchObject({ pausadas: 0, sin_stock: 1 });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT revisado_por, bloquea_reactivador, pausa_error FROM ml_publicacion_cambios').get())
      .toMatchObject({ revisado_por: 'vigia-auto', bloquea_reactivador: 1 });
    expect(db.prepare('SELECT pausa_error FROM ml_publicacion_cambios').get().pausa_error).toContain('sin stock');
  });

  it('clasifica como migración una pareja repetida sin llamar a ML', async () => {
    db.prepare(`INSERT INTO ml_publicacion_cambios
      (clave,item_id,campo,valor_anterior,valor_nuevo,detectado_en)
      VALUES ('OLD|','OLD','catalog_product_id','MLA1','MLA2',datetime('now'))`).run();
    const r = await procesarCambios(db, CFG, [cambio(1, { valor_anterior: 'MLA1', valor_nuevo: 'MLA2' })]);
    expect(r).toMatchObject({ migraciones_sin_pausa: 1, pausadas: 0 });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM ml_publicacion_cambios WHERE item_id=?').get('MLA1'))
      .toMatchObject({ pausada: 0, revisado_en: null });
    expect(db.prepare('SELECT pausa_error FROM ml_publicacion_cambios WHERE item_id=?').get('MLA1').pausa_error)
      .toContain('migración de ML: no se pausa');
  });

  const par = { valor_anterior: 'MLA-OLD', valor_nuevo: 'MLA-NEW' };
  const producto = (status, last_updated) => ({ status, data: last_updated ? { last_updated } : {} });
  const ISO = (msAtras) => new Date(Date.now() - msAtras).toISOString();
  const H = 3600e3;
  // Los GET /products devuelven lo indicado por id; los PUT a items responden 200.
  const productos = (mapa) => mlFetch.mockImplementation(async (_db, _c, metodo, ruta) => {
    if (metodo === 'put') return { status: 200, data: {} };
    const r = mapa[ruta.replace('/products/', '')];
    if (r instanceof Error) throw r;
    return r ?? { status: 200, data: {} };
  });

  it('migración por 404: el producto anterior fue borrado, se avisa sin pausar', async () => {
    productos({ 'MLA-OLD': producto(404) });
    const r = await procesarCambios(db, CFG, [cambio(1, par)]);
    expect(r).toMatchObject({ migraciones_sin_pausa: 1, pausadas: 0 });
    expect(mlFetch.mock.calls.filter((c) => c[2] === 'put')).toHaveLength(0);
    expect(db.prepare('SELECT pausada, revisado_en FROM ml_publicacion_cambios').get()).toMatchObject({ pausada: 0, revisado_en: null });
  });

  it('migración por fechas: viejo y nuevo modificados hace poco y a minutos entre sí', async () => {
    productos({ 'MLA-OLD': producto(200, ISO(10 * H)), 'MLA-NEW': producto(200, ISO(10 * H - 60e3)) });
    expect(await procesarCambios(db, CFG, [cambio(1, par)])).toMatchObject({ migraciones_sin_pausa: 1, pausadas: 0 });
  });

  it('no es migración si los dos productos se modificaron con horas de diferencia: pausa como hoy', async () => {
    productos({ 'MLA-OLD': producto(200, ISO(60 * H)), 'MLA-NEW': producto(200, ISO(2 * H)) });
    expect(await procesarCambios(db, CFG, [cambio(1, par)])).toMatchObject({ migraciones_sin_pausa: 0, pausadas: 1 });
  });

  it('caso GP5000: salto aislado a un producto nunca visto, sin señal de migración, pausa', async () => {
    productos({ 'MLA-OLD': producto(200, ISO(500 * H)), 'MLA-NEW': producto(200, ISO(400 * H)) });
    const r = await procesarCambios(db, CFG, [cambio(1, par)]);
    expect(r).toMatchObject({ migraciones_sin_pausa: 0, pausadas: 1 });
    expect(mlFetch).toHaveBeenCalledWith(db, CFG, 'put', '/items/MLA1', { status: 'paused' });
  });

  it('fail-closed: si la lectura de /products da 429, falla o no es 200/404, pausa', async () => {
    for (const falla of [{ status: 429, data: null }, new Error('red caída'), { status: 500, data: null }]) {
      db.prepare('DELETE FROM ml_publicacion_cambios').run();
      vi.clearAllMocks();
      productos({ 'MLA-OLD': falla, 'MLA-NEW': falla });
      expect(await procesarCambios(db, CFG, [cambio(1, par)])).toMatchObject({ migraciones_sin_pausa: 0, pausadas: 1 });
    }
  });

  it('el mismo par ya registrado en LA MISMA publicación no cuenta como migración (es oscilación)', async () => {
    productos({ 'MLA-OLD': producto(200, ISO(500 * H)), 'MLA-NEW': producto(200, ISO(400 * H)) });
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,campo,valor_anterior,valor_nuevo,detectado_en)
      VALUES ('MLA1|v2','MLA1','catalog_product_id','MLA-OLD','MLA-NEW',?)`).run(ISO(1 * H));
    expect(await procesarCambios(db, CFG, [cambio(1, par)])).toMatchObject({ migraciones_sin_pausa: 0, pausadas: 0, ignorados_por_ruido: 1 });
  });

  it('la ventana de 48 h: un par visto en otra publicación hace 60 h no cuenta', async () => {
    productos({ 'MLA-OLD': producto(200, ISO(500 * H)), 'MLA-NEW': producto(200, ISO(400 * H)) });
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,campo,valor_anterior,valor_nuevo,detectado_en)
      VALUES ('OTRA|','OTRA','catalog_product_id','MLA-OLD','MLA-NEW',?)`).run(ISO(60 * H));
    expect(await procesarCambios(db, CFG, [cambio(1, par)])).toMatchObject({ migraciones_sin_pausa: 0, pausadas: 1 });
  });

  it('dos publicaciones con el mismo par en la misma corrida: migración sin llamar a ML', async () => {
    const r = await procesarCambios(db, CFG, [cambio(1, par), cambio(2, par)]);
    expect(r).toMatchObject({ migraciones_sin_pausa: 2, pausadas: 0 });
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('las lecturas de /products tienen tope por corrida; pasado el tope se pausa (fail-closed)', async () => {
    productos({});
    const lista = Array.from({ length: 4 }, (_, i) => cambio(i + 1, { valor_anterior: `V${i}`, valor_nuevo: `N${i}` }));
    await procesarCambios(db, CFG, lista, { umbral: 50 });
    expect(mlFetch.mock.calls.filter((c) => c[2] === 'get').length).toBeLessThanOrEqual(10);
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
