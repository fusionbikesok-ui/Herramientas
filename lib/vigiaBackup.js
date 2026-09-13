/**
 * Vigía del backup a la nube (Gate 0). `/opt/fusionbikes/backups/backup.sh` corre fuera de la
 * app (cron del sistema, 06:00 UTC) y deja su resultado en `estado-nube.json`. Esto lo lee cada
 * hora y usa el sistema de incidentes: si el último backup completo a B2 es más viejo que
 * `maxHoras` (o el archivo falta o no se puede leer) abre un incidente crítico, que dispara el
 * email de alerta; cuando vuelve a haber un backup reciente, lo resuelve.
 *
 * Nunca lanza: un fallo del vigía no debe afectar a los demás crons.
 */
import fs from 'fs';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const ESTADO_BACKUP_DEFAULT = '/opt/fusionbikes/backups/estado-nube.json';
export const MAX_HORAS_BACKUP = 26;
const INTEGRACION = 'backup';
const PROCESO = 'backup_nube';
const TIPO = 'backup_vencido';

export function evaluarBackupNube({ estadoPath = ESTADO_BACKUP_DEFAULT, ahora = Date.now(), maxHoras = MAX_HORAS_BACKUP } = {}) {
  let estado;
  try {
    estado = JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
  } catch (e) {
    return { ok: false, motivo: e.code === 'ENOENT' ? 'sin_estado' : 'estado_ilegible', detalle: e.message };
  }
  const ultimo = Date.parse(estado?.ultimo_ok || '');
  if (!Number.isFinite(ultimo)) {
    return { ok: false, motivo: 'nunca_ok', detalle: estado?.detalle || null };
  }
  const horas = (ahora - ultimo) / 3_600_000;
  if (horas > maxHoras) {
    return { ok: false, motivo: 'vencido', horas: Math.round(horas), ultimoOk: estado.ultimo_ok, detalle: estado?.detalle || null };
  }
  return { ok: true, horas: Math.round(horas), ultimoOk: estado.ultimo_ok };
}

export function revisarBackupNube(db, opciones = {}) {
  try {
    const r = evaluarBackupNube(opciones);
    if (r.ok) {
      confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO });
      return r;
    }
    const cuando = r.ultimoOk ? `El último backup completo fue hace ${r.horas} h (${r.ultimoOk}).` : 'No hay registro de ningún backup completo.';
    abrirOActualizarIncidente(db, {
      integracion: INTEGRACION,
      proceso: PROCESO,
      tipoError: TIPO,
      severidad: 'critico',
      mensajeHumano: `El respaldo a la nube (Backblaze) no se completó. ${cuando} Revisar /opt/fusionbikes/backups/backup.log.`,
      mensajeTecnico: `${r.motivo}${r.detalle ? `: ${r.detalle}` : ''}`,
      contexto: { motivo: r.motivo, horas: r.horas ?? null },
    });
    return r;
  } catch (e) {
    console.error('[vigiaBackup] error (fail-open):', e.message);
    return { ok: false, motivo: 'error_vigia' };
  }
}
