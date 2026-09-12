/**
 * El precio de ML que deja el neto igual al precio de contado de la tienda.
 *
 * Se resuelve por punto fijo —P = contado + comisión(P) + envío(P)— preguntándole a ML por cada
 * precio candidato, en vez de extrapolar la tasa efectiva de hoy. El motivo está medido: la
 * comisión de ML es porcentaje MÁS un costo fijo, así que estirar la tasa efectiva multiplica el
 * fijo y deja el precio por encima de lo necesario.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';
import { precioObjetivoMl, precioSugerido } from '../lib/mlPrecios.js';

const TEST_DB = './test/tmp-precio-objetivo.sqlite';
const CFG = { userId: '999' };
let db;

// Simula a ML: comisión = porcentaje + fijo por tramo, envío por tramo de precio.
// Los números son los medidos en producción (13,79% + $1.250 fijos por debajo de $30.000).
function responderComoMl({ pct = 0.1379, fijo = 1250, topeFijo = 30000, envioPorPrecio = () => 0 } = {}) {
  // Firma real: mlFetch(db, cfg, method, path, body, opts)
  mlFetch.mockImplementation(async (_db, _cfg, _metodo, url) => {
    if (url.includes('listing_prices')) {
      const price = Number(new URL('http://x' + url).searchParams.get('price'));
      const fee = price * pct + (price < topeFijo ? fijo : 0);
      return { status: 200, data: { sale_fee_amount: +fee.toFixed(2) } };
    }
    if (url.includes('shipping_options/free')) {
      const price = Number(new URL('http://x' + url).searchParams.get('item_price') || 0);
      return { status: 200, data: { coverage: { all_country: { list_cost: envioPorPrecio(price) } } } };
    }
    return { status: 404, data: {} };
  });
}

const ITEM = { itemId: 'MLA1', categoryId: 'MLA1234', listingTypeId: 'gold_special', freeShipping: false };

beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
afterEach(() => { db.close(); for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f); });

describe('precioObjetivoMl — el neto tiene que quedar igual al contado', () => {
  it('el precio que devuelve deja exactamente el contado como neto', async () => {
    responderComoMl();
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 12000 });
    expect(r.convergio).toBe(true);
    // neto = precio − comisión − envío, con la comisión al precio NUEVO
    expect(r.neto).toBeGreaterThanOrEqual(12000);
    expect(r.neto - 12000).toBeLessThanOrEqual(100); // el redondeo hacia arriba a $100
    expect(r.precio % 100).toBe(0);
  });

  // El caso que motivó el cambio: FB-21170, $12.000 con comisión de $2.904,65 (13,79% + $1.250).
  it('no repite el error de extrapolar la tasa efectiva', async () => {
    responderComoMl();
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 12000 });
    // La fórmula vieja usa la tasa EFECTIVA de hoy (24,2%) y se pasa.
    const viejo = precioSugerido(12000, 2904.65, 0, 12000);
    expect(viejo).toBeGreaterThan(r.precio);
    expect(viejo - r.precio).toBeGreaterThan(300);
  });

  it('converge aunque el precio nuevo cambie de tramo de comisión', async () => {
    // Objetivo alto: el precio candidato cruza los $30.000 y el fijo desaparece a mitad del cálculo.
    responderComoMl();
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 27000 });
    expect(r.convergio).toBe(true);
    expect(r.neto).toBeGreaterThanOrEqual(27000);
    expect(r.vueltas).toBeLessThanOrEqual(5);
  });

  it('el envío se calcula al precio NUEVO, no al de hoy', async () => {
    // Publicación sin costo de envío hoy que cruza el umbral al subir: aparecen $7.000.
    responderComoMl({ envioPorPrecio: (p) => (p >= 40000 ? 7000 : 0) });
    // `envioActual` es lo que paga hoy: sin ese dato no se puede afirmar que cambió.
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, freeShipping: true, contado: 36000, envioActual: 0 });
    expect(r.envio).toBe(7000);
    expect(r.neto).toBeGreaterThanOrEqual(36000);
    expect(r.cruza_umbral_envio).toBe(true);
  });

  it('avisa cuando el envío NO cambia, para no alarmar de más', async () => {
    responderComoMl({ envioPorPrecio: () => 6600 });
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, freeShipping: true, contado: 100000, envioActual: 6600 });
    expect(r.cruza_umbral_envio).toBe(false);
    expect(r.envio).toBe(6600);
  });

  it('redondea SIEMPRE hacia arriba: el neto nunca queda por debajo del contado', async () => {
    responderComoMl();
    for (const contado of [9999, 12345, 33333, 87654]) {
      const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado });
      expect(r.precio % 100).toBe(0);
      expect(r.neto).toBeGreaterThanOrEqual(contado);
    }
  });

  // Se cortaba apenas el neto superaba el objetivo, y como la semilla arranca 20% arriba, en
  // ítems de comisión baja el precio quedaba hasta $40.000 por encima de lo necesario (medido
  // sobre publicaciones reales). Un precio de más no es gratis: es una venta que no ocurre.
  it('no se pasa del objetivo: el neto no puede quedar muy por encima del contado', async () => {
    responderComoMl({ pct: 0.05, fijo: 0 });      // comisión baja: la semilla del +20% sobra
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 100000 });
    expect(r.neto).toBeGreaterThanOrEqual(100000);
    // Con un paso de redondeo de $100, pasarse de $200 significa que no buscó el punto fijo.
    expect(r.neto - 100000).toBeLessThanOrEqual(200);
  });

  it('si ML no contesta la comisión, no inventa un precio', async () => {
    mlFetch.mockResolvedValue({ status: 500, data: {} });
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 12000 });
    expect(r.precio).toBeNull();
    expect(r.convergio).toBe(false);
    expect(r.motivo).toMatch(/comisión/i);
  });

  it('sin contado no hay objetivo posible', async () => {
    responderComoMl();
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: null });
    expect(r.precio).toBeNull();
    expect(r.motivo).toMatch(/contado/i);
  });

  it('una comisión que se come todo el precio no da un precio infinito', async () => {
    responderComoMl({ pct: 1.2, fijo: 0 });
    const r = await precioObjetivoMl(db, CFG, { ...ITEM, contado: 12000 });
    expect(r.precio).toBeNull();
    expect(r.convergio).toBe(false);
  });
});
