/**
 * Helpers de fecha compartidos. Extraído de lib/coberturaCola.js (hallazgo del revisor,
 * 2026-08-13): había una función `inicioHoyISO()` local con corte a medianoche **UTC**
 * (hora del server) y routes/preparacion.js estaba a punto de copiarla de nuevo para
 * `cargados_hoy` — dos copias del mismo defecto en vez de una función corregida.
 */

const ZONA_BUENOS_AIRES = 'America/Argentina/Buenos_Aires';

// Offset real (en ms) entre UTC y la hora de pared de `timeZone` en el instante `date`,
// vía Intl en vez de una constante fija (nit del revisor: Argentina no tiene horario de
// verano hoy, pero un offset fijo UTC-3 hardcodeado fallaría en silencio si eso cambiara
// — ya pasó en el pasado en el país. Intl.DateTimeFormat consulta la base tz del propio
// Node, así que se ajusta solo si Argentina vuelve a tener DST.
function offsetMs(date, timeZone) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const comoUTC = Date.UTC(partes.year, partes.month - 1, partes.day, partes.hour, partes.minute, partes.second);
  return comoUTC - date.getTime();
}

/**
 * Inicio del día de HOY en hora de Buenos Aires, devuelto como instante UTC en ISO.
 * Antes se cortaba a medianoche UTC (= 21:00 Argentina), así que los contadores "hoy"
 * se reiniciaban tres horas antes de tiempo y arrastraban trabajo del día anterior.
 */
export function inicioHoyBuenosAiresISO() {
  const ahora = new Date();
  const offset = offsetMs(ahora, ZONA_BUENOS_AIRES); // negativo (UTC-3 => ~ -3h)
  // Sumar el offset (negativo) deja el reloj interno (en UTC) mostrando la hora de pared
  // de Buenos Aires; ahí sí tiene sentido pedirle "medianoche" con setUTCHours. Restar el
  // offset de vuelta convierte esa medianoche de pared en el instante UTC real.
  const comoHoraLocal = new Date(ahora.getTime() + offset);
  comoHoraLocal.setUTCHours(0, 0, 0, 0);
  return new Date(comoHoraLocal.getTime() - offset).toISOString();
}
