import { describe, expect, it } from 'vitest';
import { cotizarProducto, diferenciaDeLinea, MasterControlNoDisponible, configMasterControl } from '../lib/masterControlPricing.js';

const cfg = { url: 'https://tienda.test/', token: 'secreto' };

const respuesta = {
  status: 200,
  data: {
    ok: true, product_id: 5, sku: 'FB-1', nombre: 'Casco', cantidad: 2,
    precio_contado_centavos: 1000000, total_contado_centavos: 2000000,
    planes_permitidos: [3, 6, 9, 12, 18, 24], plan: 6,
    coeficientes: {
      3: { coeficiente: 1.1, precio_unitario_centavos: 1100000, total_linea_centavos: 2200000, importe_por_cuota_centavos: 733334 },
      6: { coeficiente: 1.25, precio_unitario_centavos: 1250000, total_linea_centavos: 2500000, importe_por_cuota_centavos: 416667 },
    },
  },
};

describe('Contrato de financiación con Master Control', () => {
  it('arma la consulta con el token y el plan del pedido', async () => {
    let visto = null;
    await cotizarProducto(cfg, { sku: 'FB-1', plan: 6, cantidad: 2 }, async (url, opciones) => {
      visto = { url, opciones }; return respuesta;
    });
    expect(visto.url).toBe('https://tienda.test/wp-json/fusion-pricing/v1/cotizacion?sku=FB-1&plan=6&cantidad=2');
    expect(visto.opciones.headers['X-Fusion-Token']).toBe('secreto');
  });

  it('un pedido de contado no manda plan', async () => {
    let visto = null;
    await cotizarProducto(cfg, { productId: 5 }, async (url) => { visto = url; return respuesta; });
    expect(visto).not.toContain('plan=');
    expect(visto).toContain('product_id=5');
  });

  // Fail-closed: mostrar la diferencia de contado como si fuera la financiada le cobraría
  // de menos al cliente. Cada camino de error tiene que llegar como error.
  it('falla explícitamente si falta configuración', async () => {
    await expect(cotizarProducto({ url: '', token: '' }, { sku: 'X' })).rejects.toBeInstanceOf(MasterControlNoDisponible);
  });

  it('falla explícitamente si WordPress responde mal', async () => {
    await expect(cotizarProducto(cfg, { sku: 'X' }, async () => ({ status: 401, data: {} })))
      .rejects.toThrow('respondió 401');
    await expect(cotizarProducto(cfg, { sku: 'X' }, async () => ({ status: 200, data: { ok: false } })))
      .rejects.toThrow('respuesta inesperada');
    await expect(cotizarProducto(cfg, { sku: 'X' }, async () => { throw new Error('ECONNREFUSED'); }))
      .rejects.toThrow('ECONNREFUSED');
  });

  it('calcula la diferencia de agregar según el plan del pedido', () => {
    const d = diferenciaDeLinea(respuesta.data, { plan: 6, cantidad: 2 });
    expect(d).toMatchObject({
      cuotas: 6, coeficiente: 1.25,
      contado_centavos: 2000000, financiado_centavos: 2500000, importe_por_cuota_centavos: 416667,
    });
  });

  it('quitar una línea da saldo a favor, con el mismo plan', () => {
    const d = diferenciaDeLinea(respuesta.data, { plan: 6, cantidad: 2, quitar: true });
    expect(d.financiado_centavos).toBe(-2500000);
    expect(d.importe_por_cuota_centavos).toBe(-416667);
  });

  it('sin plan aplicable informa contado y deja la financiación en null', () => {
    const d = diferenciaDeLinea(respuesta.data, { plan: null });
    expect(d).toMatchObject({ plan: null, financiado_centavos: null, contado_centavos: 2000000 });
    // Un plan que la tienda no ofrece tampoco se inventa.
    expect(diferenciaDeLinea(respuesta.data, { plan: 99 }).financiado_centavos).toBeNull();
  });

  it('lee la configuración del entorno', () => {
    expect(configMasterControl({ WOO_URL: 'https://x.test', MASTER_CONTROL_TOKEN: 't' }))
      .toEqual({ url: 'https://x.test', token: 't' });
  });
});
