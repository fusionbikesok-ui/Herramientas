// Constantes del aviso de ventas retenidas por Guardia ML (plan
// docs/superpowers/plans/2026-09-13-guardia-ventas-retenidas.md). Viven aparte para que el worker
// de push las use sin importar lib/guardiaMl.js y, con él, el cliente de MercadoLibre.
export const INTEGRACION_GUARDIA_ML = 'guardia_ml';
export const PROCESO_VENTA_RETENIDA = 'venta_retenida';
// Decisión de José 2026-09-13: un único recordatorio, a las 2 horas.
export const RECORDATORIO_VENTA_RETENIDA_MIN = 120;

export function esAvisoVentaRetenida(inc) {
  return inc?.integracion === INTEGRACION_GUARDIA_ML && inc?.proceso === PROCESO_VENTA_RETENIDA;
}
