/**
 * Vigía del backup a la nube (Gate 0). `/opt/fusionbikes/backups/backup.sh` corre fuera de la
 * app (cron del sistema, 06:00 UTC) y deja su resultado en `estado-nube.json`. Esto lo lee cada
 * hora y usa el sistema de incidentes:
 *  - si el último backup completo a B2 es más viejo que `maxHoras` (o el archivo falta o no se
 *    puede leer) abre un incidente crítico, que dispara el email de alerta; cuando vuelve a
 *    haber un backup reciente, lo resuelve.
 *  - si el bucket supera `avisoBytes` abre una advertencia de capacidad: la cuenta B2 no tiene
 *    tarjeta (decisión 2026-09-13) y el plan gratis deja de aceptar subidas a los 10 GB.
 *
 * Nunca lanza: un fallo del vigía no debe afectar a los demás crons.
 */
import fs from 'fs';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const ESTADO_BACKUP_DEFAULT = '/opt/fusionbikes/backups/estado-nube.json';
export const MAX_HORAS_BACKUP = 26;
export const LIMITE_GRATIS_BYTES = 10e9;
export const AVISO_CAPACIDAD_BYTES = 8e9;
const INTEGRACION = 'backup';
const PROCESO = 'backup_nube';
const TIPO = 'backup_vencido';
const TIPO_CAPACIDAD = 'capacidad_bucket';

export function evaluarBackupNube({ estadoPath = ESTADO_BACKUP_DEFAULT, ahora = Date.now(), maxHoras = MAX_HORAS_BACKUP } = {}) {
  let estado;
  try {
    estado = JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
  } catch (e) {
    return { ok: false, motivo: e.code === 'ENOENT' ? 'sin_estado' : 'estado_ilegible', detalle: e.message, bucketBytes: null };
  }
  const bucketBytes = Number.isFinite(Number(estado?.bucket_bytes)) && estado?.bucket_bytes !== null ? Number(estado.bucket_bytes) : null;
  const ultimo = Date.parse(estado?.ultimo_ok || '');
  if (!Number.isFinite(ultimo)) {
    return { ok: false, motivo: 'nunca_ok', detalle: estado?.detalle || null, bucketBytes };
  }
  const horas = (ahora - ultimo) / 3_600_000;
  if (horas > maxHoras) {
    return { ok: false, motivo: 'vencido', horas: Math.round(horas), ultimoOk: estado.ultimo_ok, detalle: estado?.detalle || null, bucketBytes };
  }
  return { ok: true, horas: Math.round(horas), ultimoOk: estado.ultimo_ok, bucketBytes };
}

function revisarCapacidad(db, bucketBytes, avisoBytes) {
  if (bucketBytes === null) return;
  if (bucketBytes <= avisoBytes) {
    confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO, tipoError: TIPO_CAPACIDAD });
    return;
  }
  const gb = (bucketBytes / 1e9).toFixed(1);
  abrirOActualizarIncidente(db, {
    integracion: INTEGRACION,
    proceso: PROCESO,
    tipoError: TIPO_CAPACIDAD,
    severidad: 'advertencia',
    mensajeHumano: `El respaldo en Backblaze ocupa ${gb} GB. La cuenta no tiene tarjeta y a los ${LIMITE_GRATIS_BYTES / 1e9} GB deja de aceptar backups: decidir si cargar tarjeta, limpiar copias viejas de la base o cambiar de proveedor.`,
    mensajeTecnico: `bucket_bytes=${bucketBytes}`,
    contexto: { bucketBytes },
  });
}

export function revisarBackupNube(db, { avisoBytes = AVISO_CAPACIDAD_BYTES, ...opciones } = {}) {
  try {
    const r = evaluarBackupNube(opciones);
    revisarCapacidad(db, r.bucketBytes, avisoBytes);
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
