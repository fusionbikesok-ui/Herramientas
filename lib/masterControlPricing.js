/*
 * lib/masterControlPricing.js — Cliente del contrato de financiación de Master Control.
 *
 * Master Control vive exclusivamente en WordPress; el VPS no lee sus archivos, tablas ni
 * opciones. El coeficiente de cuotas se pregunta por HTTP a
 * `GET /wp-json/fusion-pricing/v1/cotizacion`, que expone lo que ya calculan
 * `PricingEngine` y `DataService`. Duplicar la cuenta acá crearía una segunda fuente de
 * verdad para el mismo importe.
 *
 * Fail-closed a propósito: si WordPress no responde, esto devuelve un error explícito y la
 * pantalla dice que no puede calcular la financiación. Mostrar la diferencia de contado
 * como si fuera la financiada le cobraría de menos al cliente sin que nadie se entere.
 */
import axios from 'axios';

export class MasterControlNoDisponible extends Error {
  constructor(mensaje, causa) {
    super(mensaje);
    this.name = 'MasterControlNoDisponible';
    this.code = 'MASTER_CONTROL_NO_DISPONIBLE';
    this.causa = causa || null;
  }
}

export function configMasterControl(env = process.env) {
  return {
    url: env.WOO_URL || '',
    token: env.MASTER_CONTROL_TOKEN || '',
  };
}

/**
 * Cotiza un producto según el plan de cuotas del pedido.
 *
 * @param {{url: string, token: string}} cfg
 * @param {{productId?: number, sku?: string, plan?: number|null, cantidad?: number}} consulta
 * @param {Function} [fetchImpl] inyectable para pruebas: recibe (url, opciones).
 */
export async function cotizarProducto(cfg, { productId, sku, plan, cantidad = 1 } = {}, fetchImpl) {
  if (!cfg?.url || !cfg?.token) {
    throw new MasterControlNoDisponible('Falta configurar WOO_URL o MASTER_CONTROL_TOKEN');
  }
  if (!productId && !sku) {
    throw new MasterControlNoDisponible('Hay que indicar productId o sku');
  }

  const params = new URLSearchParams();
  if (productId) params.set('product_id', String(productId));
  if (sku) params.set('sku', String(sku));
  // Un pedido de contado no manda plan: el endpoint devuelve igual el contado y todos los
  // coeficientes, y `plan_aplicado` viene en null.
  if (plan) params.set('plan', String(plan));
  params.set('cantidad', String(Math.max(1, Number(cantidad) || 1)));

  const url = `${String(cfg.url).replace(/\/$/, '')}/wp-json/fusion-pricing/v1/cotizacion?${params}`;
  const pedir = fetchImpl || ((u, o) => axios.request({ url: u, method: 'get', headers: o.headers, timeout: 15000, validateStatus: () => true }));

  let resp;
  try {
    resp = await pedir(url, { headers: { 'X-Fusion-Token': cfg.token } });
  } catch (error) {
    throw new MasterControlNoDisponible(`No se pudo consultar Master Control: ${error.message}`, error);
  }
  if (!resp || resp.status < 200 || resp.status >= 300) {
    throw new MasterControlNoDisponible(`Master Control respondió ${resp?.status ?? 'sin status'}`);
  }
  const datos = resp.data;
  if (!datos?.ok) throw new MasterControlNoDisponible('Master Control devolvió una respuesta inesperada');
  return datos;
}

/**
 * Diferencia económica de agregar (signo +) o quitar (signo −) una línea, expresada según
 * el plan del pedido. Devuelve centavos enteros, que es como guarda todo `gestion_*`.
 */
export function diferenciaDeLinea(cotizacion, { plan, cantidad = 1, quitar = false } = {}) {
  const signo = quitar ? -1 : 1;
  const clave = plan == null ? null : String(plan);
  const financiado = clave && cotizacion.coeficientes?.[clave];
  if (!financiado) {
    return {
      plan: null,
      cuotas: null,
      coeficiente: null,
      contado_centavos: signo * cotizacion.total_contado_centavos,
      financiado_centavos: null,
      importe_por_cuota_centavos: null,
    };
  }
  return {
    plan: Number(plan),
    cuotas: Number(plan),
    coeficiente: financiado.coeficiente,
    contado_centavos: signo * cotizacion.total_contado_centavos,
    financiado_centavos: signo * financiado.total_linea_centavos,
    importe_por_cuota_centavos: signo * financiado.importe_por_cuota_centavos,
  };
}
