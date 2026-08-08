/**
 * Presupuesto de llamadas a MercadoLibre: token bucket por recurso.
 *
 * Vive acá y no en cada módulo a propósito. El límite de ML es por CUENTA, así
 * que afinar el delay de cada cron por separado no controla nada: lo que ML ve
 * es la suma de los 9 crons más lo que dispare el usuario a mano. Este es el
 * único lugar donde se decide si una llamada sale.
 *
 * Techos: los de lib/mlLimites.js, ya con el 15% de margen aplicado.
 * Cada llamada consume cupo del recurso específico (lectura/escritura/oauth)
 * Y del global; si cualquiera de los dos está agotado, espera. Gana el más
 * restrictivo, que es justamente la regla pedida.
 *
 * Las llamadas manuales del usuario también consumen cupo — el límite de ML no
 * distingue quién la disparó. Lo que sí obtienen es prioridad de espera más
 * generosa (ver ESPERA_MAX_MS): preferimos que una acción interactiva tarde un
 * poco a que falle.
 */

import { cupoEfectivo } from './mlLimites.js';

// Cuánto puede esperar una llamada a que se libere cupo antes de darse por
// vencida. Si se agota, el caller recibe un 429 sintético y su lógica
// fail-closed habitual se encarga — nunca se saltea el presupuesto.
const ESPERA_MAX_MS = { automatica: 15_000, manual: 30_000 };

// Granularidad del reintento mientras se espera cupo. Con el paso en 100ms y como una
// espera necesita en promedio 2 pasos por token liberado (el sleep no está sincronizado
// con el refill), el ritmo real que se logra es ~5/s, no el ~7/s que daría 1 paso por
// token: NO subirlo más, y no bajarlo tampoco — un paso menor solo generaría más
// iteraciones ociosas sin ganar throughput real (el propio refill sigue acotando a `cupo`
// por minuto).
const PASO_ESPERA_MS = 100;

// Techo de ráfaga: cuántos tokens puede acumular un bucket antes de vaciarse todo de
// golpe. ML no mide promedios, castiga la ráfaga (ver docs/superpowers/plans/
// 2026-08-08-rafaga-ml-pendientes.md) — antes el techo era el cupo entero de un minuto
// (hasta 425 llamadas de lectura saliendo sin ninguna separación). Con esto, capacidad y
// ritmo dejan de ser el mismo número: el promedio por minuto no cambia (ver _refill),
// pero ya no se puede gastar de un saque.
const RAFAGA_MAX_MS = 3000;

function _techoRafaga(recurso) {
  const cupo = cupoEfectivo(recurso);
  return Math.max(1, Math.ceil((cupo * RAFAGA_MAX_MS) / 60_000));
}

/** Estado por recurso: { tokens, ultimoRefill }. Se crea perezosamente. */
const _buckets = new Map();

function _bucket(recurso) {
  if (!_buckets.has(recurso)) {
    // Arranca en el techo de ráfaga, no en el cupo entero del minuto: un proceso recién
    // levantado no arrastra deuda, pero tampoco puede vaciar de golpe un minuto completo.
    _buckets.set(recurso, { tokens: _techoRafaga(recurso), ultimoRefill: Date.now() });
  }
  return _buckets.get(recurso);
}

function _refill(recurso) {
  const b = _bucket(recurso);
  const cupo = cupoEfectivo(recurso);
  const techo = _techoRafaga(recurso);
  const ahora = Date.now();
  const transcurridoMs = ahora - b.ultimoRefill;
  if (transcurridoMs <= 0) return b;

  // Refill continuo: cupo tokens por minuto, prorrateado (el promedio no cambia). Lo que
  // cambia es el tope de acumulación: ya no `cupo` sino `techo` (ventana de ráfaga corta),
  // así que el bucket nunca vuelve a llenarse hasta el minuto entero.
  b.tokens = Math.min(techo, b.tokens + (transcurridoMs / 60_000) * cupo);
  b.ultimoRefill = ahora;
  return b;
}

/** ¿Hay al menos 1 token en todos estos recursos? */
function _hayCupo(recursos) {
  return recursos.every(r => _refill(r).tokens >= 1);
}

function _consumir(recursos) {
  for (const r of recursos) _bucket(r).tokens -= 1;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reserva cupo para una llamada. Devuelve true si se puede salir a red, false
 * si se agotó la espera máxima (el caller debe tratarlo como 429).
 *
 * `recursos` son todos los que la llamada consume a la vez, típicamente
 * ['global', 'escritura'].
 */
export async function reservarCupo(recursos, { manual = false } = {}) {
  const limite = manual ? ESPERA_MAX_MS.manual : ESPERA_MAX_MS.automatica;
  const hasta = Date.now() + limite;

  while (!_hayCupo(recursos)) {
    if (Date.now() >= hasta) return false;
    await _sleep(PASO_ESPERA_MS);
  }
  _consumir(recursos);
  return true;
}

/** Estado actual del presupuesto, para diagnóstico y para /api/sync/estado. */
export function estadoPresupuesto() {
  const out = {};
  for (const recurso of _buckets.keys()) {
    const b = _refill(recurso);
    out[recurso] = {
      disponibles: Math.floor(b.tokens),
      techo_rpm: cupoEfectivo(recurso),
      techo_rafaga: _techoRafaga(recurso),
    };
  }
  return out;
}

/** Solo para tests: vacía los buckets para que cada test arranque parejo. */
export function _resetPresupuestoParaTests() {
  _buckets.clear();
}

/** Solo para tests: expone la misma fórmula de techo de ráfaga que usa el bucket real. */
export function _techoRafagaParaTests(recurso) {
  return _techoRafaga(recurso);
}
