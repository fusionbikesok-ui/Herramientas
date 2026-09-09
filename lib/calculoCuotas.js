/** Calcula la diferencia de contado y su importe financiado con una tasa explícita. */
export function calcularDiferenciaPorCuotas({ diferenciaContadoCentavos, cuotas, coeficiente }) {
  const contado = Number(diferenciaContadoCentavos);
  const nCuotas = Number(cuotas);
  const tasa = Number(coeficiente);
  if (!Number.isSafeInteger(contado) || contado === 0) return { ok: false, code: 'DIFERENCIA_INVALIDA' };
  if (!Number.isInteger(nCuotas) || nCuotas < 1) return { ok: false, code: 'CUOTAS_NO_DISPONIBLES' };
  if (!Number.isFinite(tasa) || tasa <= 0) return { ok: false, code: 'TASA_NO_DISPONIBLE' };
  const total = Math.round(contado * tasa);
  return { ok: true, diferencia_contado_centavos: contado, cuotas: nCuotas, coeficiente: tasa,
    diferencia_financiada_centavos: total, importe_por_cuota_centavos: Math.round(total / nCuotas) };
}
