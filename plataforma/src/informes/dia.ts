/*
 * src/informes/dia.ts — el día que cubre cada informe.
 *
 * Argentina no tiene horario de verano desde 2009, pero el offset no se escribe a mano: se pregunta a la
 * base de datos de zonas de Node. Manifiesto y reporte usan esta misma ventana; antes uno decía UTC y el
 * otro salía 07:00 ART, así que no quedaba claro qué día se reportaba (hallazgo 16 de la revisión externa).
 */
export const ZONA = 'America/Argentina/Buenos_Aires';
const TOPE_DIAS = 30;

const FORMATO = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

/** La fecha calendario ART de un instante, en YYYY-MM-DD. */
export function fechaArt(instante: Date): string {
  return FORMATO.format(instante);
}

/** El instante UTC de la medianoche ART que abre esa fecha. */
export function medianocheArt(fecha: string): Date {
  // Se prueban los offsets posibles y se acepta el que cae en la fecha pedida a las 00:00.
  for (const offset of [3, 2, 4]) {
    const tentativa = new Date(`${fecha}T0${offset}:00:00.000Z`);
    if (fechaArt(tentativa) === fecha && new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(tentativa) === '00') {
      return tentativa;
    }
  }
  throw new Error(`medianocheArt: no se pudo ubicar la medianoche de ${fecha}`);
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function ventanaDiaAnterior(ahora: Date): { fecha: string; desde: Date; hasta: Date } {
  const fecha = sumarDias(fechaArt(ahora), -1);
  return { fecha, desde: medianocheArt(fecha), hasta: medianocheArt(sumarDias(fecha, 1)) };
}

export function diasFaltantes(ultima: string | null, ahora: Date): string[] {
  const objetivo = ventanaDiaAnterior(ahora).fecha;
  if (!ultima) return [objetivo];
  const dias: string[] = [];
  for (let f = sumarDias(ultima, 1); f <= objetivo; f = sumarDias(f, 1)) {
    dias.push(f);
    if (dias.length === TOPE_DIAS) break;
  }
  return dias;
}
