/**
 * Vigía de backups. Dos fuentes, ambas escritas fuera de la app por crons del sistema:
 *
 * 1. Backup a la nube (Gate 0). `/opt/fusionbikes/backups/backup.sh` (06:00 UTC) deja
 *    `estado-nube.json`. Se lee cada hora:
 *    - último backup completo a B2 más viejo que `maxHoras` (o estado ausente/ilegible) → incidente
 *      crítico con email; se resuelve cuando vuelve a haber uno reciente.
 *    - bucket por encima de `avisoBytes` → advertencia de capacidad (cuenta B2 sin tarjeta, PM-165).
 *
 * 2. PostgreSQL (E0 nivel 1). `scripts/postgres/backup-diario.sh` deja `estado-pg.json` y
 *    `scripts/postgres/estado-archivo.sh` (cada 5 min) deja `estado-pg-archivo.json`. Se lee cada
 *    5 minutos, sólo si PostgreSQL está desplegado (existe `/opt/fusionbikes/postgres`):
 *    - backup verificado más viejo que 26 h → crítico.
 *    - segmento WAL sin archivar hace más de 5 min (RPO del nivel 1) → crítico; más de 3 min → aviso.
 *    - medición de archivado vieja (> 15 min) o ilegible → crítico: sin ella no sabemos el RPO.
 *    - capacidad real (2026-09-15, sin archive-push-queue-max, PM-177): disco del host ≥ 80 % aviso /
 *      ≥ 90 % crítico; bytes en cola .ready ≥ 1 GiB aviso / ≥ 4 GiB crítico; pg_wal ≥ 2 GiB aviso /
 *      ≥ 8 GiB crítico; sin medición de capacidad → crítico. Sin límite de cola, un disco lleno detiene
 *      PostgreSQL: estas alertas son la única protección previa.
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

export const PG_DESPLEGADO_DEFAULT = '/opt/fusionbikes/postgres';
export const ESTADO_PG_DEFAULT = '/opt/fusionbikes/backups/estado-pg.json';
export const ESTADO_PG_ARCHIVO_DEFAULT = '/opt/fusionbikes/backups/estado-pg-archivo.json';
export const PG_ARCHIVO_AVISO_S = 180;
export const PG_ARCHIVO_CRITICO_S = 300;
export const PG_MEDICION_VIEJA_S = 900;
export const PG_DISCO_AVISO_PCT = 80;
export const PG_DISCO_CRITICO_PCT = 90;
export const PG_COLA_AVISO_BYTES = 1024 ** 3;
export const PG_COLA_CRITICO_BYTES = 4 * 1024 ** 3;
export const PG_WAL_AVISO_BYTES = 2 * 1024 ** 3;
export const PG_WAL_CRITICO_BYTES = 8 * 1024 ** 3;
const PROCESO_PG = 'postgres';

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

function leerJson(ruta) {
  try { return { ok: true, datos: JSON.parse(fs.readFileSync(ruta, 'utf8')) }; }
  catch (e) { return { ok: false, motivo: e.code === 'ENOENT' ? 'sin_estado' : 'estado_ilegible', detalle: e.message }; }
}

const GIB = 1024 ** 3;
const gib = (b) => (b / GIB).toFixed(1);

// Umbral escalonado: devuelve 'critico', 'advertencia' o null.
function nivel(valor, aviso, critico) {
  if (valor >= critico) return 'critico';
  if (valor >= aviso) return 'advertencia';
  return null;
}

function evaluarCapacidad(datos, problemas, sanos) {
  const disco = Number(datos.disco_pct);
  const cola = Number(datos.ready_bytes);
  const wal = Number(datos.pg_wal_bytes);
  if (![disco, cola, wal].every(Number.isFinite)) {
    problemas.push({ tipo: 'capacidad_disco', severidad: 'critico', mensajeHumano: 'No hay medición de capacidad de PostgreSQL (disco, pg_wal o cola de WAL). Sin ella no se puede anticipar un disco lleno, que detiene la base.', mensajeTecnico: `disco_pct=${datos.disco_pct} ready_bytes=${datos.ready_bytes} pg_wal_bytes=${datos.pg_wal_bytes}` });
    return;
  }
  const libre = Number(datos.disco_libre_bytes);
  const reglas = [
    ['capacidad_disco', nivel(disco, PG_DISCO_AVISO_PCT, PG_DISCO_CRITICO_PCT), `El disco del VPS donde vive PostgreSQL está al ${disco} %${Number.isFinite(libre) ? ` (${gib(libre)} GiB libres)` : ''}. Si se llena, PostgreSQL se detiene.`, `disco_pct=${disco} disco_libre_bytes=${datos.disco_libre_bytes}`],
    ['cola_wal', nivel(cola, PG_COLA_AVISO_BYTES, PG_COLA_CRITICO_BYTES), `PostgreSQL acumula ${gib(cola)} GiB de WAL sin archivar. Revisar pgBackRest antes de que llene el disco.`, `ready_bytes=${cola} pendientes=${datos.pendientes}`],
    ['pg_wal', nivel(wal, PG_WAL_AVISO_BYTES, PG_WAL_CRITICO_BYTES), `La carpeta pg_wal de PostgreSQL ocupa ${gib(wal)} GiB.`, `pg_wal_bytes=${wal}`],
  ];
  for (const [tipo, severidad, mensajeHumano, mensajeTecnico] of reglas) {
    if (severidad) problemas.push({ tipo, severidad, mensajeHumano, mensajeTecnico });
    else sanos.push(tipo);
  }
}

// Devuelve { desplegado, problemas: [{tipo, severidad, mensajeHumano, mensajeTecnico}], sanos: [tipos] }.
export function evaluarPostgres({
  desplegadoPath = PG_DESPLEGADO_DEFAULT, estadoPath = ESTADO_PG_DEFAULT, archivoPath = ESTADO_PG_ARCHIVO_DEFAULT,
  ahora = Date.now(), maxHoras = MAX_HORAS_BACKUP,
} = {}) {
  if (!fs.existsSync(desplegadoPath)) return { desplegado: false, problemas: [], sanos: [] };
  const problemas = [];
  const sanos = [];

  const backup = leerJson(estadoPath);
  const ultimo = backup.ok ? Date.parse(backup.datos?.ultimo_ok || '') : NaN;
  if (!Number.isFinite(ultimo)) {
    problemas.push({ tipo: 'backup_vencido', severidad: 'critico', mensajeHumano: 'PostgreSQL no tiene ningún backup verificado registrado. Revisar /opt/fusionbikes/backups/backup-pg.log.', mensajeTecnico: backup.ok ? `nunca_ok: ${backup.datos?.detalle || ''}` : `${backup.motivo}: ${backup.detalle}` });
  } else if ((ahora - ultimo) / 3_600_000 > maxHoras) {
    const horas = Math.round((ahora - ultimo) / 3_600_000);
    problemas.push({ tipo: 'backup_vencido', severidad: 'critico', mensajeHumano: `El último backup verificado de PostgreSQL fue hace ${horas} h. Revisar /opt/fusionbikes/backups/backup-pg.log.`, mensajeTecnico: `vencido ${horas} h; ${backup.datos?.detalle || ''}` });
  } else {
    sanos.push('backup_vencido');
  }

  const archivo = leerJson(archivoPath);
  const medido = archivo.ok ? Date.parse(archivo.datos?.medido || '') : NaN;
  if (!archivo.ok || !archivo.datos?.ok || !Number.isFinite(medido) || (ahora - medido) / 1000 > PG_MEDICION_VIEJA_S) {
    const detalle = !archivo.ok ? `${archivo.motivo}: ${archivo.detalle}` : !archivo.datos?.ok ? `medición con error: ${archivo.datos?.detalle}` : `medición de hace ${Math.round((ahora - medido) / 1000)} s`;
    problemas.push({ tipo: 'archivo_wal', severidad: 'critico', mensajeHumano: 'No hay medición reciente del archivado de WAL de PostgreSQL: no se puede asegurar el RPO de 5 minutos.', mensajeTecnico: detalle });
  } else {
    const viejo = Number(archivo.datos.mas_viejo_s) || 0;
    const pendientes = Number(archivo.datos.pendientes) || 0;
    if (viejo > PG_ARCHIVO_CRITICO_S) {
      problemas.push({ tipo: 'archivo_wal', severidad: 'critico', mensajeHumano: `PostgreSQL tiene ${pendientes} segmento(s) de WAL sin archivar; el más viejo hace ${Math.round(viejo / 60)} min. Se está incumpliendo el RPO de 5 minutos.`, mensajeTecnico: `pendientes=${pendientes} mas_viejo_s=${viejo}` });
    } else if (viejo > PG_ARCHIVO_AVISO_S) {
      problemas.push({ tipo: 'archivo_wal', severidad: 'advertencia', mensajeHumano: `El archivado de WAL de PostgreSQL está demorado ${Math.round(viejo / 60)} min (${pendientes} segmento(s)).`, mensajeTecnico: `pendientes=${pendientes} mas_viejo_s=${viejo}` });
    } else {
      sanos.push('archivo_wal');
    }
    evaluarCapacidad(archivo.datos, problemas, sanos);
  }
  return { desplegado: true, problemas, sanos };
}

export function revisarBackupPostgres(db, opciones = {}) {
  try {
    const r = evaluarPostgres(opciones);
    if (!r.desplegado) return r;
    for (const tipo of r.sanos) confirmarCicloSano(db, { integracion: INTEGRACION, proceso: PROCESO_PG, tipoError: tipo });
    for (const p of r.problemas) {
      abrirOActualizarIncidente(db, {
        integracion: INTEGRACION, proceso: PROCESO_PG, tipoError: p.tipo, severidad: p.severidad,
        mensajeHumano: p.mensajeHumano, mensajeTecnico: p.mensajeTecnico, contexto: { tipo: p.tipo },
      });
    }
    return r;
  } catch (e) {
    console.error('[vigiaBackup] error PostgreSQL (fail-open):', e.message);
    return { desplegado: null, problemas: [], sanos: [], error: true };
  }
}
