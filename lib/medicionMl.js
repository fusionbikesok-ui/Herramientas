/**
 * Medición durable de llamadas del legado a Mercado Libre, por minuto y recurso (E1 T3: base para fijar el
 * techo del bucket `shadow` del gateway con siete días reales). Acumula en memoria y escribe el minuto
 * anterior cuando cambia el minuto. Fail-open: medir nunca puede romper una llamada a ML.
 * Retención: 30 días.
 */
const acumulado = new Map(); // `${minuto}|${recurso}` -> { reales, status_429, sinteticas }
let ultimaPurga = 0;

const minutoDe = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

function volcar(db, antesDe) {
  const pendientes = [...acumulado.entries()].filter(([clave]) => clave.split('|')[0] < antesDe);
  if (!pendientes.length) return;
  const up = db.prepare(`INSERT INTO ml_llamadas_minuto (minuto, recurso, reales, status_429, sinteticas) VALUES (?,?,?,?,?)
    ON CONFLICT(minuto, recurso) DO UPDATE SET reales=reales+excluded.reales, status_429=status_429+excluded.status_429,
      sinteticas=sinteticas+excluded.sinteticas`);
  db.transaction(() => {
    for (const [clave, v] of pendientes) {
      const [minuto, recurso] = clave.split('|');
      up.run(minuto, recurso, v.reales, v.status_429, v.sinteticas);
    }
  })();
  for (const [clave] of pendientes) acumulado.delete(clave);
}

export function medirLlamadaMl(db, recurso, { sintetica = false, status = null } = {}, ahoraMs = Date.now()) {
  try {
    const minuto = minutoDe(ahoraMs);
    const clave = `${minuto}|${recurso}`;
    const v = acumulado.get(clave) || { reales: 0, status_429: 0, sinteticas: 0 };
    if (sintetica) v.sinteticas += 1; else { v.reales += 1; if (status === 429) v.status_429 += 1; }
    acumulado.set(clave, v);
    if (!db || db.open === false) return;
    volcar(db, minuto);
    if (ahoraMs - ultimaPurga > 3600_000) {
      ultimaPurga = ahoraMs;
      db.prepare('DELETE FROM ml_llamadas_minuto WHERE minuto < ?').run(minutoDe(ahoraMs - 30 * 86400_000));
    }
  } catch { /* fail-open */ }
}

/** Para pruebas y para cerrar el minuto en curso a mano. */
export function volcarMedicionMl(db, ahoraMs = Date.now()) {
  try { volcar(db, minutoDe(ahoraMs + 60_000)); } catch { /* fail-open */ }
}

/** Resumen para proponer el techo: por recurso, percentiles de llamadas reales por minuto en la ventana. */
export function resumenMedicionMl(db, { dias = 7, ahoraMs = Date.now() } = {}) {
  const desde = minutoDe(ahoraMs - dias * 86400_000);
  const filas = db.prepare('SELECT minuto, recurso, reales, status_429, sinteticas FROM ml_llamadas_minuto WHERE minuto >= ? ORDER BY minuto').all(desde);
  const por = {};
  for (const f of filas) (por[f.recurso] ||= []).push(f);
  const pct = (xs, p) => { if (!xs.length) return 0; const o = [...xs].sort((a, b) => a - b); return o[Math.min(o.length - 1, Math.ceil(p / 100 * o.length) - 1)]; };
  const minutosVentana = dias * 1440;
  return {
    desde, minutos_con_datos: new Set(filas.map((f) => f.minuto)).size, minutos_ventana: minutosVentana,
    recursos: Object.fromEntries(Object.entries(por).map(([r, xs]) => {
      // Los minutos sin llamadas cuentan como cero para los percentiles.
      const reales = [...xs.map((x) => x.reales), ...Array(Math.max(0, minutosVentana - xs.length)).fill(0)];
      return [r, { p50: pct(reales, 50), p95: pct(reales, 95), p99: pct(reales, 99), max: Math.max(0, ...xs.map((x) => x.reales)),
        total_429: xs.reduce((s, x) => s + x.status_429, 0), total_sinteticas: xs.reduce((s, x) => s + x.sinteticas, 0) }];
    })),
  };
}
