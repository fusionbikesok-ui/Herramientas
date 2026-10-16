/**
 * Vigía de deriva VPS ↔ git. `scripts/ops/drift-vps-cron.sh` (diario, 07:15 UTC) corre drift-vps.sh y deja
 * `estado-drift.json`. Se lee cada hora:
 *    - rc=1 (hay diferencias) → advertencia 'deriva'; el mensaje lista una muestra de archivos.
 *    - rc=2 (el script no pudo comparar), estado ausente, ilegible o de más de 26 h → advertencia
 *      'deriva_sin_medicion': sin la medición no se sabe si el VPS coincide con git.
 *    - rc=0 reciente → se resuelven ambos.
 *
 * Nunca lanza: un fallo del vigía no debe afectar a los demás crons.
 */
import fs from 'fs';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const ESTADO_DRIFT_DEFAULT = '/opt/fusionbikes/backups/estado-drift.json';
export const MAX_HORAS_DRIFT = 26;
const INTEGRACION = 'vps';
const PROCESO = 'deriva_git';
const TIPO_DERIVA = 'deriva';
const TIPO_SIN_MEDICION = 'deriva_sin_medicion';
const MUESTRA_EN_MENSAJE = 10;
// Defensa en profundidad: el wrapper ya omite estas rutas, pero el estado es un archivo y puede venir de otra versión.
const RUTA_SECRETA = /\.env|secret|token|key|\.pem|credential/i;
const limpiarRuta = (m) => (RUTA_SECRETA.test(String(m)) ? String(m).replace(/\S+$/, '[ruta omitida]') : String(m));

export function evaluarDrift({ estadoPath = ESTADO_DRIFT_DEFAULT, ahora = Date.now(), maxHoras = MAX_HORAS_DRIFT } = {}) {
  let estado;
  try {
    estado = JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
  } catch (e) {
    return { medido: false, motivo: e.code === 'ENOENT' ? 'sin_estado' : 'estado_ilegible', detalle: e.message };
  }
  const corrida = Date.parse(estado?.ultimo_corrida || '');
  if (!Number.isFinite(corrida)) return { medido: false, motivo: 'estado_ilegible', detalle: 'ultimo_corrida inválido' };
  const horas = (ahora - corrida) / 3_600_000;
  if (horas < -0.25) return { medido: false, motivo: 'fecha_futura', detalle: `ultimo_corrida en el futuro (${estado.ultimo_corrida})` };
  if (horas > maxHoras) return { medido: false, motivo: 'vencido', detalle: `última corrida hace ${Math.round(horas)} h (${estado.ultimo_corrida})` };
  const rc = Number(estado.rc);
  if (rc === 0 || rc === 1) return { medido: true, rc, estado };
  return { medido: false, motivo: estado.motivo || 'script_fallo', detalle: `drift-vps.sh terminó con rc=${estado.rc}${estado.motivo ? ` (${estado.motivo})` : ''}` };
}

export function revisarDrift(db, opciones = {}) {
  try {
    const r = evaluarDrift(opciones);
    if (!r.medido) {
      abrirOActualizarIncidente(db, {
        integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO_SIN_MEDICION, severidad: 'advertencia',
        mensajeHumano: 'No hay una medición reciente de la deriva entre el VPS y git, así que no se sabe si lo que corre coincide con lo versionado. Revisar /var/log/fusion/drift-vps.log y el cron fusion-drift.',
        mensajeTecnico: `${r.motivo}: ${r.detalle}`,
        contexto: { motivo: r.motivo },
      });
      return r;
    }
    confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO_SIN_MEDICION });
    if (r.rc === 0) {
      confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO_DERIVA });
      return r;
    }
    const { total = 0, muestra = [], por_bloque: porBloque = {}, imagenes_distintas: imagenes = 0, ref_sha: refSha = null } = r.estado;
    const lista = muestra.slice(0, MUESTRA_EN_MENSAJE).map(limpiarRuta).join('; ');
    const resto = total > MUESTRA_EN_MENSAJE ? ` (y ${total - MUESTRA_EN_MENSAJE} más)` : '';
    abrirOActualizarIncidente(db, {
      integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO_DERIVA, severidad: 'advertencia',
      mensajeHumano: `${total} archivos del VPS no coinciden con git: ${lista}${resto}. Versionarlos o revertirlos; el detalle está en /var/log/fusion/drift-vps.log.`,
      mensajeTecnico: `rc=1 total=${total} imagenes_distintas=${imagenes} ref=${refSha}`,
      contexto: { por_bloque: porBloque, imagenes_distintas: imagenes, ref_sha: refSha },
    });
    return r;
  } catch (e) {
    console.error('[vigiaDrift] error (fail-open):', e.message);
    return { medido: false, motivo: 'error_vigia' };
  }
}
