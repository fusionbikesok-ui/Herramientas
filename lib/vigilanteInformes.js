/**
 * E1 T4 — vigilante de los informes diarios firmados. A partir de las 09:00 ART le pregunta a la plataforma
 * si salió el informe del día anterior y si quedaron entregas atrasadas, y si algo falta abre un incidente
 * crítico, que sale por el aviso de incidentes que ya existe.
 *
 * Vive en el legado a propósito: es el único aviso que sobrevive a que la plataforma se caiga entera. La
 * numeración de días del propio informe sólo detecta un salto cuando llega el informe siguiente, y una caída
 * definitiva no llega nunca (hallazgo 22 de la revisión externa del diseño).
 *
 * Firma el pedido con el mismo HMAC interno y keyring que la copia de sombra. No lanza nunca: un error de red
 * es justamente un caso a informar, no una excepción.
 */
import crypto from 'crypto';
import { firmarInterno } from './internoHmac.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const RUTA_ESTADO_INFORMES = '/internal/v1/informes/estado';
export const HORA_VIGILANTE_ART = 9;
const ZONA = 'America/Argentina/Buenos_Aires';
const INTEGRACION = 'plataforma';
const PROCESO = 'vigilante_informes';
const TIPOS = ['informe_faltante', 'entregas_atrasadas', 'plataforma_sin_respuesta'];

const fechaArt = (instante) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(instante);
const horaArt = (instante) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(instante));

function diaAnterior(instante) {
  const d = new Date(`${fechaArt(instante)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function abrir(db, tipoError, mensajeHumano, contexto) {
  abrirOActualizarIncidente(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError, severidad: 'critico', mensajeHumano, contexto });
}

/**
 * @returns {Promise<{ estado: 'temprano' | 'ok' | 'falta' | 'atrasadas' | 'sin_respuesta', esperado?: string }>}
 */
export async function revisarInformeDelDia(db, { url, keyring, fetch: hacerFetch = globalThis.fetch, ahora = new Date(), timeoutMs = 10_000 }) {
  if (horaArt(ahora) < HORA_VIGILANTE_ART) return { estado: 'temprano' };
  const esperado = diaAnterior(ahora);

  let estado;
  try {
    const ts = String(Math.floor(ahora.getTime() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const clave = keyring.keys[keyring.activeKeyId];
    const r = await hacerFetch(`${url}${RUTA_ESTADO_INFORMES}`, {
      method: 'GET',
      headers: {
        'x-fusion-key-id': keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
        'x-fusion-signature': firmarInterno(clave, ts, nonce, 'GET', RUTA_ESTADO_INFORMES, Buffer.alloc(0)),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`la plataforma respondió ${r.status}`);
    estado = await r.json();
    // Aunque venga firmada, una respuesta con otra forma no se usa: con `{ ultimo: "zzzz" }` se habría
    // interpretado como sana y cerrado incidentes abiertos.
    const fecha = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const valida = estado && typeof estado === 'object'
      && (estado.ultimo === null || fecha(estado.ultimo))
      && Array.isArray(estado.atrasadas)
      && estado.atrasadas.every((a) => a && ['manifiesto', 'reporte'].includes(a.tipo) && fecha(a.fecha));
    if (!valida) throw new Error('la plataforma devolvió un estado con forma inválida');
  } catch (e) {
    abrir(db, 'plataforma_sin_respuesta',
      `No se pudo consultar si salió el informe firmado del ${esperado}: la plataforma no respondió. Revisar el servicio de la plataforma.`,
      { error: String(e?.message ?? e).slice(0, 200) });
    return { estado: 'sin_respuesta', esperado };
  }
  confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: 'plataforma_sin_respuesta' });

  // Fechas en YYYY-MM-DD: comparar como texto ordena igual que como fecha.
  if (!estado?.ultimo || estado.ultimo < esperado) {
    abrir(db, 'informe_faltante',
      `No salió el informe firmado del ${esperado} (último avisado: ${estado?.ultimo ?? 'ninguno'}). Un día sin informe corta la campaña de 7 días.`,
      { esperado, ultimo: estado?.ultimo ?? null });
    return { estado: 'falta', esperado };
  }
  confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: 'informe_faltante' });

  const atrasadas = Array.isArray(estado.atrasadas) ? estado.atrasadas : [];
  if (atrasadas.length) {
    abrir(db, 'entregas_atrasadas',
      `Hay ${atrasadas.length} informe(s) firmados que llevan más de 24 h sin subirse a Backblaze. Revisar las credenciales de B2 o la red.`,
      { atrasadas: atrasadas.slice(0, 10).map((a) => `${a.tipo}:${a.fecha}`) });
    return { estado: 'atrasadas', esperado };
  }
  confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: 'entregas_atrasadas' });
  return { estado: 'ok', esperado };
}

export { TIPOS as TIPOS_VIGILANTE_INFORMES };
