/*
 * src/informes/vuelta.ts — la vuelta diaria de informes: arma, firma, sube y avisa cada día que falte.
 *
 * Cada artefacto (manifiesto y reporte, por día) avanza por dos caminos independientes de
 * `informes.entregas`: el depósito (`generado → firmado → subido`) y el aviso (`pendiente → avisado`). El
 * email sale aunque la subida falle, porque avisar no depende de B2; y un email enviado no da por subido el
 * archivo, así que el reintento de B2 sigue vivo en la vuelta siguiente.
 *
 * Reintentar no necesita releer el archivo pendiente: el contenido de un día cerrado se rearma igual (el
 * reporte congela el estado al corte), y Ed25519 es determinístico, así que el sobre refirmado es idéntico
 * byte a byte. El hash guardado en la fila lo comprueba: si el contenido cambió, `reclamar` lo rechaza y no se
 * sube algo distinto de lo firmado.
 *
 * Nunca se sube dos veces lo mismo: antes de cada PUT se pregunta a B2 si el objeto ya está (un proceso pudo
 * caerse después de que B2 lo aceptó y antes de anotarlo). Si está con el mismo hash y la retención bien, se
 * adopta; si está con otro contenido, se anota el conflicto y NO se pisa. En compliance, una copia de más
 * queda un año (revisión de la tanda A, crítico 1).
 *
 * Dos relojes: `ahora` decide QUÉ días se trabajan; `reloj()` es la hora real para el permiso y la
 * retención. Con un solo `ahora` congelado, una vuelta larga seguía creyéndose dueña de un permiso vencido
 * (revisión de la tanda A, crítico 3).
 *
 * La vuelta no abre incidentes: devuelve las entregas atrasadas y las expone por la API interna, y el legado
 * es el que alerta (diseño §6 y tarea 11).
 */
import { createHash, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { canonizar } from './jcs.ts';
import { firmar, type Sobre } from './firma.ts';
import { diasFaltantes } from './dia.ts';
import { armarManifiesto, type Manifiesto } from './manifiesto.ts';
import { armarReporte, type Reporte } from './reporte.ts';
import { anotarFallo, avanzarAviso, avanzarDeposito, pendientesVencidas, reclamar, type Reclamo, type TipoEntrega } from './entregas.ts';
import { armarCuerpo, type DatosClave, type Mensaje } from './correo.ts';
import { RETENCION_DIAS, type Deposito } from './deposito.ts';

export interface CfgInformes {
  clave: { kid: string; privada: KeyObject };
  deposito: Deposito;
  correo: { enviar(mensaje: Mensaje): Promise<void> };
  datosClave: DatosClave;
  /** Hora real para el permiso y la retención. En producción, el reloj del sistema. */
  reloj?: () => Date;
}

export interface ResultadoVuelta {
  hechos: string[];
  fallados: string[];
  atrasadas: Array<{ tipo: string; fecha: string }>;
  /**
   * Informes cuyo objeto en B2 quedó OCULTO por un marcador de borrado. La versión retenida sigue existiendo
   * (Object Lock la protege), pero un cliente normal recibe 404, así que la evidencia deja de estar a la vista.
   * En B2 el permiso de escritura incluye ocultar, así que la propia credencial de la plataforma puede hacerlo:
   * verificado contra B2 real el 2026-09-18. No se puede prevenir con permisos; se detecta y se reporta.
   */
  ocultos: Array<{ tipo: string; fecha: string; versionRetenida: string | null }>;
}

const sha256 = (datos: string) => createHash('sha256').update(datos, 'utf8').digest('hex');
const hashDe = (contenido: unknown) => sha256(canonizar(contenido));
const claveObjeto = (tipo: TipoEntrega, fecha: string) => `e1/${tipo === 'manifiesto' ? 'manifiestos' : 'reportes'}/${fecha}.json`;
// Un objeto adoptado tiene que seguir retenido al menos un año desde ahora, con un margen de tolerancia.
const RETENCION_MINIMA_ADOPTADA_MS = (RETENCION_DIAS - 5) * 86_400_000;

/** Los días a trabajar: los que nunca se emitieron más los que quedaron a medias, del más viejo al más nuevo. */
async function diasATrabajar(pool: pg.Pool, ahora: Date): Promise<string[]> {
  const ultima = await pool.query<{ fecha: string | null }>(
    `SELECT to_char(max(fecha), 'YYYY-MM-DD') AS fecha FROM informes.entregas WHERE tipo = 'reporte'`,
  );
  const aMedias = await pool.query<{ fecha: string }>(
    `SELECT DISTINCT to_char(fecha, 'YYYY-MM-DD') AS fecha FROM informes.entregas
      WHERE estado_deposito <> 'subido' OR estado_aviso <> 'avisado'`,
  );
  // Un día puede estar subido y avisado y quedarse sin su fila canónica si el proceso se cortó entre las dos
  // escrituras. Si no se lo vuelve a elegir, nadie lo repara nunca (hallazgo crítico de la revisión 2026-09-18).
  const sinCanonico = await pool.query<{ fecha: string }>(
    `SELECT DISTINCT to_char(e.fecha, 'YYYY-MM-DD') AS fecha
       FROM informes.entregas e
       LEFT JOIN audit.audit_daily_manifests m ON e.tipo = 'manifiesto' AND m.manifest_date = e.fecha
       LEFT JOIN integrations.daily_shadow_reports r ON e.tipo = 'reporte' AND r.report_date = e.fecha
      WHERE e.estado_deposito = 'subido'
        AND ((e.tipo = 'manifiesto' AND m.manifest_date IS NULL) OR (e.tipo = 'reporte' AND r.report_date IS NULL))`,
  );
  const dias = new Set([
    ...aMedias.rows.map((r) => r.fecha), ...sinCanonico.rows.map((r) => r.fecha),
    ...diasFaltantes(ultima.rows[0]?.fecha ?? null, ahora),
  ]);
  return [...dias].sort();
}

interface Artefacto { tipo: TipoEntrega; contenido: Manifiesto | Reporte; reclamo: Reclamo; sobre: Sobre; cuerpo: string }

export async function vueltaDeInformes(pool: pg.Pool, cfg: CfgInformes, ahora: Date = new Date()): Promise<ResultadoVuelta> {
  const reloj = cfg.reloj ?? (() => new Date());
  const hechos: string[] = [];
  const fallados: string[] = [];

  for (const fecha of await diasATrabajar(pool, ahora)) {
    const manifiesto = await armarManifiesto(pool, fecha);
    const reporte = await armarReporte(pool, fecha, { manifiesto });
    const artefactos: Artefacto[] = [];

    for (const [tipo, contenido] of [['manifiesto', manifiesto], ['reporte', reporte]] as const) {
      const hash = hashDe(contenido);
      const reclamo = await reclamar(pool, tipo, fecha, { hash, ahora: reloj() });
      // null: otro proceso la tiene, ya está terminada, o el contenido cambió. En los tres casos no se toca,
      // pero una entrega TERMINADA puede haberse quedado sin su fila canónica (corte entre las dos escrituras),
      // y entonces nadie la repararía: se repone acá, con el mismo contenido que se firmó (hash igual).
      if (!reclamo) {
        await repararCanonico(pool, cfg, tipo, fecha, contenido, hash);
        continue;
      }
      const sobre = firmar(contenido, cfg.clave);
      const cuerpo = JSON.stringify(sobre);
      artefactos.push({ tipo, contenido, reclamo, sobre, cuerpo });

      if (reclamo.deposito === 'generado') {
        const ruta = await cfg.deposito.guardarPendiente(claveObjeto(tipo, fecha), cuerpo);
        const datos: Record<string, unknown> = { kid: cfg.clave.kid, ruta_pendiente: ruta };
        if (tipo === 'reporte') datos.semaforo = (contenido as Reporte).semaforo;
        if (!await avanzarDeposito(pool, reclamo, 'firmado', datos, reloj())) continue;
        reclamo.deposito = 'firmado';
      }
      if (reclamo.deposito === 'firmado') {
        await depositar(pool, cfg, reclamo, tipo, fecha, cuerpo, reloj, fallados);
      }
      // La fila canónica se escribe SIEMPRE que el depósito esté confirmado, no sólo en la vuelta que subió:
      // son dos escrituras, y un corte entre ellas dejaba la entrega cerrada y sin registro canónico.
      // `registrarCanonico` es idempotente.
      if (reclamo.deposito === 'subido') {
        const subida = await subidaDe(pool, tipo, fecha);
        if (subida) await registrarCanonico(pool, tipo, contenido, sobre, subida);
      }
    }

    await avisar(pool, cfg, fecha, artefactos, reloj, fallados);

    for (const a of artefactos) {
      if (a.reclamo.deposito === 'subido' && a.reclamo.aviso === 'avisado') hechos.push(`${a.tipo}:${fecha}`);
    }
  }

  const atrasadas = (await pendientesVencidas(pool, reloj())).map(({ tipo, fecha }) => ({ tipo, fecha }));
  const ocultos = await revisarOcultos(pool, cfg, reloj());
  return { hechos, fallados: [...new Set(fallados)], atrasadas, ocultos };
}

/**
 * Revisa que los objetos ya subidos sigan VISIBLES en B2. Se limita a los últimos días para que el costo no
 * crezca con la historia: lo que interesa es detectar un ocultamiento reciente, y la retención protege al resto.
 * Un fallo al consultar no rompe la vuelta: se informa como si no se pudiera verificar.
 */
const DIAS_VISIBILIDAD = 7;

async function revisarOcultos(
  pool: pg.Pool, cfg: CfgInformes, ahora: Date,
): Promise<Array<{ tipo: string; fecha: string; versionRetenida: string | null }>> {
  const desde = new Date(ahora.getTime() - DIAS_VISIBILIDAD * 86_400_000).toISOString().slice(0, 10);
  const r = await pool.query<{ tipo: TipoEntrega; fecha: string }>(
    `SELECT tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha FROM informes.entregas
      WHERE estado_deposito = 'subido' AND fecha >= $1::date ORDER BY fecha DESC, tipo`,
    [desde],
  );
  const ocultos: Array<{ tipo: string; fecha: string; versionRetenida: string | null }> = [];
  for (const { tipo, fecha } of r.rows) {
    let v;
    try {
      v = await cfg.deposito.versiones(claveObjeto(tipo, fecha));
    } catch {
      // Sin poder consultar no se afirma nada, ni que está oculto ni que no: el vigilante ya alerta si la
      // plataforma no responde, y la marca anterior se conserva.
      continue;
    }
    if (v.oculto) {
      ocultos.push({ tipo, fecha, versionRetenida: v.versionRetenida });
      // Se marca en la base para que la ruta interna lo exponga y el vigilante del legado lo alerte: el
      // resultado de esta vuelta sólo lo ve el log del scheduler.
      await pool.query(
        `UPDATE informes.entregas SET oculto_en = COALESCE(oculto_en, $3), oculto_version_retenida = $4
          WHERE tipo = $1 AND fecha = $2`, [tipo, fecha, ahora, v.versionRetenida]);
    } else {
      await pool.query(
        `UPDATE informes.entregas SET oculto_en = NULL, oculto_version_retenida = NULL
          WHERE tipo = $1 AND fecha = $2 AND oculto_en IS NOT NULL`, [tipo, fecha]);
    }
  }
  return ocultos;
}

/** Un email por día, con el reporte adjunto; recién ahí se marca el aviso de los artefactos que tiene. */
async function avisar(
  pool: pg.Pool, cfg: CfgInformes, fecha: string, artefactos: Artefacto[], reloj: () => Date, fallados: string[],
): Promise<void> {
  const pendientes = artefactos.filter((a) => a.reclamo.aviso === 'pendiente');
  if (!pendientes.length) return;
  const delReporte = artefactos.find((a) => a.tipo === 'reporte');

  if (!delReporte) {
    // Este proceso tiene el manifiesto pero no el reporte. Si el reporte ya se avisó (otro proceso mandó el
    // email del día), el manifiesto se da por avisado; si no, queda para la vuelta siguiente. Sin esto, un
    // reparto de reclamos entre dos schedulers dejaba el manifiesto pendiente para siempre.
    const r = await pool.query<{ estado_aviso: string }>(
      `SELECT estado_aviso FROM informes.entregas WHERE tipo = 'reporte' AND fecha = $1`, [fecha]);
    if (r.rows[0]?.estado_aviso !== 'avisado') return;
    for (const a of pendientes) if (await avanzarAviso(pool, a.reclamo, reloj())) a.reclamo.aviso = 'avisado';
    return;
  }

  try {
    const { asunto, texto } = armarCuerpo(delReporte.contenido as Reporte, cfg.datosClave);
    // La identidad lleva el día y el hash del reporte firmado: un reenvío del mismo informe se deduplica en el
    // receptor, y un informe distinto del mismo día (rearmado) llega como mensaje nuevo, que es lo correcto.
    const identidad = `informe-${fecha}-${sha256(delReporte.cuerpo).slice(0, 16)}`;
    await cfg.correo.enviar({
      asunto, texto, identidad,
      adjuntos: [{ nombre: `reporte-${fecha}.json`, contenido: delReporte.cuerpo }],
    });
  } catch (error) {
    for (const a of pendientes) {
      await anotarFallo(pool, a.reclamo, 'aviso', (error as Error).message, reloj());
      fallados.push(`${a.tipo}:${fecha}`);
    }
    return;
  }
  for (const a of pendientes) if (await avanzarAviso(pool, a.reclamo, reloj())) a.reclamo.aviso = 'avisado';
  await pool.query(`UPDATE integrations.daily_shadow_reports SET email_sent_at = $2 WHERE report_date = $1`, [fecha, reloj()]);
}

/**
 * Sube el sobre, sin duplicar nunca. Devuelve la versión y retención confirmadas, o null si quedó pendiente.
 */
async function depositar(
  pool: pg.Pool, cfg: CfgInformes, reclamo: Reclamo, tipo: TipoEntrega, fecha: string, cuerpo: string,
  reloj: () => Date, fallados: string[],
): Promise<{ versionId: string; retencion: string } | null> {
  const objeto = claveObjeto(tipo, fecha);
  const esperado = sha256(cuerpo);
  const fallo = async (motivo: string) => {
    await anotarFallo(pool, reclamo, 'deposito', motivo, reloj());
    fallados.push(`${tipo}:${fecha}`);
    return null;
  };

  // Lo que ya esté en B2 sólo se adopta si es exactamente esto y quedó bien retenido.
  const adoptar = (ya: { versionId: string; retencion: string; modo: string; sha256: string | null }) =>
    ya.sha256 === esperado && ya.modo === 'COMPLIANCE'
    && Date.parse(ya.retencion) >= reloj().getTime() + RETENCION_MINIMA_ADOPTADA_MS;

  let subida: { versionId: string; retencion: string } | null = null;
  let previo;
  try {
    previo = await cfg.deposito.consultar(objeto);
  } catch (error) {
    // Sin poder preguntar no se sube: un PUT a ciegas es justo lo que puede duplicar.
    return fallo(`no se pudo consultar B2 antes de subir: ${(error as Error).message}`);
  }
  if (previo) {
    if (!adoptar(previo)) return fallo(`ya hay en B2 otro contenido o retención para ${objeto}; no se pisa`);
    subida = { versionId: previo.versionId, retencion: previo.retencion };
  } else {
    try {
      subida = await cfg.deposito.subir(objeto, cuerpo, reloj());
    } catch (error) {
      // En duda (timeout, red cortada): se vuelve a preguntar antes de dar por fallado.
      const ya = await cfg.deposito.consultar(objeto).catch(() => null);
      if (ya && adoptar(ya)) subida = { versionId: ya.versionId, retencion: ya.retencion };
      else return fallo((error as Error).message);
    }
  }

  const ok = await avanzarDeposito(pool, reclamo, 'subido', {
    b2_object_key: objeto, b2_version_id: subida.versionId, retention_until: subida.retencion,
  }, reloj());
  if (!ok) return null;
  reclamo.deposito = 'subido';
  // El pendiente se borra recién con la subida confirmada y anotada: antes, es la única copia fuera de la base.
  const fila = await pool.query<{ ruta_pendiente: string | null }>(
    `SELECT ruta_pendiente FROM informes.entregas WHERE tipo = $1 AND fecha = $2`, [tipo, fecha]);
  const ruta = fila.rows[0]?.ruta_pendiente;
  if (ruta) await cfg.deposito.limpiarPendiente(ruta).catch(() => undefined);
  return subida;
}

/**
 * Repone la fila canónica de una entrega ya subida cuando falta, sin tocar B2 ni el email. Sólo actúa si el
 * contenido recalculado es exactamente el que se firmó (mismo hash): si el día cambió, no hay nada que reponer.
 */
async function repararCanonico(
  pool: pg.Pool, cfg: CfgInformes, tipo: TipoEntrega, fecha: string,
  contenido: Manifiesto | Reporte, hash: string,
): Promise<void> {
  const r = await pool.query<{ estado_deposito: string; hash_contenido: string }>(
    `SELECT estado_deposito, hash_contenido FROM informes.entregas WHERE tipo = $1 AND fecha = $2`, [tipo, fecha]);
  const fila = r.rows[0];
  if (!fila || fila.estado_deposito !== 'subido' || fila.hash_contenido !== hash) return;
  const subida = await subidaDe(pool, tipo, fecha);
  if (subida) await registrarCanonico(pool, tipo, contenido, firmar(contenido, cfg.clave), subida);
}

/** Los datos de la subida ya confirmada, leídos de la entrega: la fila canónica se puede reparar después. */
async function subidaDe(
  pool: pg.Pool, tipo: TipoEntrega, fecha: string,
): Promise<{ versionId: string; retencion: string } | null> {
  const r = await pool.query<{ b2_version_id: string | null; retention_until: string | null }>(
    `SELECT b2_version_id, retention_until FROM informes.entregas WHERE tipo = $1 AND fecha = $2`, [tipo, fecha]);
  const f = r.rows[0];
  return f?.b2_version_id && f.retention_until ? { versionId: f.b2_version_id, retencion: f.retention_until } : null;
}

/**
 * Con la subida confirmada, se escribe la fila de la tabla canónica del tramo 1 (`audit.audit_daily_manifests`
 * o `integrations.daily_shadow_reports`), que sólo admite clave de objeto y versión reales. Idempotente.
 */
async function registrarCanonico(
  pool: pg.Pool, tipo: TipoEntrega, contenido: Manifiesto | Reporte, sobre: Sobre,
  subida: { versionId: string; retencion: string },
): Promise<void> {
  const firma = Buffer.from(sobre.firma, 'base64');
  const objeto = claveObjeto(tipo, contenido.fecha);
  if (tipo === 'manifiesto') {
    const m = contenido as Manifiesto;
    await pool.query(
      `INSERT INTO audit.audit_daily_manifests
         (manifest_date, first_chain_seq, last_chain_seq, last_hash, event_count, signature, signing_key_id,
          b2_object_key, b2_version_id, retention_mode, retention_until)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, $8, $9, 'compliance', $10)
       ON CONFLICT (manifest_date) DO NOTHING`,
      [m.fecha, m.primer_chain_seq, m.ultimo_chain_seq, m.ultimo_hash, m.eventos, firma, sobre.kid, objeto, subida.versionId, subida.retencion],
    );
    return;
  }
  await pool.query(
    `INSERT INTO integrations.daily_shadow_reports
       (report_date, report_sha256, signature, signing_key_id, b2_object_key, b2_version_id, retention_until)
     VALUES ($1, decode($2, 'hex'), $3, $4, $5, $6, $7)
     ON CONFLICT (report_date) DO NOTHING`,
    [contenido.fecha, hashDe(contenido), firma, sobre.kid, objeto, subida.versionId, subida.retencion],
  );
}
