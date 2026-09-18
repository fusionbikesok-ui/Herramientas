/*
 * src/informes/vuelta.ts — la vuelta diaria de informes: arma, firma, sube y avisa cada día que falte.
 *
 * Cada artefacto (manifiesto y reporte, por día) avanza por dos caminos independientes de
 * `informes.entregas`: el depósito (`generado → firmado → subido`) y el aviso (`pendiente → avisado`). El
 * email sale aunque la subida falle, porque avisar no depende de B2; y un email enviado no da por subido el
 * archivo, así que el reintento de B2 sigue vivo en la vuelta siguiente.
 *
 * Reintentar no necesita releer el archivo pendiente: el contenido de un día cerrado se rearma igual, y
 * Ed25519 es determinístico, así que el sobre refirmado es idéntico byte a byte. El hash guardado en la fila
 * lo comprueba: si el contenido cambió, `reclamar` lo rechaza y no se sube algo distinto de lo firmado.
 *
 * La vuelta no abre incidentes: devuelve las entregas atrasadas y las expone por la API interna, y el legado
 * es el que alerta (diseño §6 y tarea 11). La hora entra por parámetro: nada de reloj adentro.
 */
import { createHash, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { canonizar } from './jcs.ts';
import { firmar } from './firma.ts';
import { diasFaltantes } from './dia.ts';
import { armarManifiesto, type Manifiesto } from './manifiesto.ts';
import { armarReporte, type Reporte } from './reporte.ts';
import { anotarFallo, avanzarAviso, avanzarDeposito, pendientesVencidas, reclamar, type Reclamo, type TipoEntrega } from './entregas.ts';
import { armarCuerpo, type DatosClave, type Mensaje } from './correo.ts';
import type { Deposito } from './deposito.ts';

export interface CfgInformes {
  clave: { kid: string; privada: KeyObject };
  deposito: Deposito;
  correo: { enviar(mensaje: Mensaje): Promise<void> };
  datosClave: DatosClave;
}

export interface ResultadoVuelta {
  hechos: string[];
  fallados: string[];
  atrasadas: Array<{ tipo: string; fecha: string }>;
}

const hashDe = (contenido: unknown) => createHash('sha256').update(canonizar(contenido), 'utf8').digest('hex');
const claveObjeto = (tipo: TipoEntrega, fecha: string) => `e1/${tipo === 'manifiesto' ? 'manifiestos' : 'reportes'}/${fecha}.json`;

/** Los días a trabajar: los que nunca se emitieron más los que quedaron a medias, del más viejo al más nuevo. */
async function diasATrabajar(pool: pg.Pool, ahora: Date): Promise<string[]> {
  const ultima = await pool.query<{ fecha: string | null }>(
    `SELECT to_char(max(fecha), 'YYYY-MM-DD') AS fecha FROM informes.entregas WHERE tipo = 'reporte'`,
  );
  const aMedias = await pool.query<{ fecha: string }>(
    `SELECT DISTINCT to_char(fecha, 'YYYY-MM-DD') AS fecha FROM informes.entregas
      WHERE estado_deposito <> 'subido' OR estado_aviso <> 'avisado'`,
  );
  const dias = new Set([...aMedias.rows.map((r) => r.fecha), ...diasFaltantes(ultima.rows[0]?.fecha ?? null, ahora)]);
  return [...dias].sort();
}

interface Artefacto { tipo: TipoEntrega; contenido: Manifiesto | Reporte; reclamo: Reclamo; cuerpo: string }

export async function vueltaDeInformes(pool: pg.Pool, cfg: CfgInformes, ahora: Date = new Date()): Promise<ResultadoVuelta> {
  const hechos: string[] = [];
  const fallados: string[] = [];

  for (const fecha of await diasATrabajar(pool, ahora)) {
    const manifiesto = await armarManifiesto(pool, fecha);
    const reporte = await armarReporte(pool, fecha, { manifiesto });
    const artefactos: Artefacto[] = [];

    for (const [tipo, contenido] of [['manifiesto', manifiesto], ['reporte', reporte]] as const) {
      const reclamo = await reclamar(pool, tipo, fecha, { hash: hashDe(contenido), ahora });
      // null: otro proceso la tiene, ya está terminada, o el contenido cambió. En los tres casos, no se toca.
      if (!reclamo) continue;
      const cuerpo = JSON.stringify(firmar(contenido, cfg.clave));
      artefactos.push({ tipo, contenido, reclamo, cuerpo });

      if (reclamo.deposito === 'generado') {
        const ruta = await cfg.deposito.guardarPendiente(claveObjeto(tipo, fecha), cuerpo);
        const datos: Record<string, unknown> = { kid: cfg.clave.kid, ruta_pendiente: ruta };
        if (tipo === 'reporte') datos.semaforo = (contenido as Reporte).semaforo;
        if (!await avanzarDeposito(pool, reclamo, 'firmado', datos, ahora)) continue;
        reclamo.deposito = 'firmado';
      }
      if (reclamo.deposito === 'firmado') await depositar(pool, cfg, reclamo, tipo, fecha, cuerpo, ahora, fallados);
    }

    // Un solo email por día, con el reporte adjunto, y recién ahí se marca el aviso de los dos artefactos.
    const pendientes = artefactos.filter((a) => a.reclamo.aviso === 'pendiente');
    const delReporte = artefactos.find((a) => a.tipo === 'reporte');
    if (pendientes.length && delReporte) {
      try {
        const { asunto, texto } = armarCuerpo(delReporte.contenido as Reporte, cfg.datosClave);
        await cfg.correo.enviar({ asunto, texto, adjuntos: [{ nombre: `reporte-${fecha}.json`, contenido: delReporte.cuerpo }] });
        for (const a of pendientes) {
          if (await avanzarAviso(pool, a.reclamo, ahora)) a.reclamo.aviso = 'avisado';
        }
      } catch (error) {
        for (const a of pendientes) await anotarFallo(pool, a.reclamo, 'aviso', (error as Error).message, ahora);
        for (const a of pendientes) fallados.push(`${a.tipo}:${fecha}`);
      }
    }

    for (const a of artefactos) {
      if (a.reclamo.deposito === 'subido' && a.reclamo.aviso === 'avisado') hechos.push(`${a.tipo}:${fecha}`);
    }
  }

  const atrasadas = (await pendientesVencidas(pool, ahora)).map(({ tipo, fecha }) => ({ tipo, fecha }));
  return { hechos, fallados: [...new Set(fallados)], atrasadas };
}

async function depositar(
  pool: pg.Pool, cfg: CfgInformes, reclamo: Reclamo, tipo: TipoEntrega, fecha: string, cuerpo: string,
  ahora: Date, fallados: string[],
): Promise<void> {
  const objeto = claveObjeto(tipo, fecha);
  let subida: { versionId: string; retencion: string } | null = null;
  try {
    subida = await cfg.deposito.subir(objeto, cuerpo, ahora);
  } catch (error) {
    // En duda, no se reintenta a ciegas: repetir el PUT crearía otra versión, y en compliance queda un año.
    // Primero se pregunta si ya está, con la credencial de lectura.
    const ya = await cfg.deposito.consultar(objeto).catch(() => null);
    if (ya && ya.modo === 'COMPLIANCE') subida = { versionId: ya.versionId, retencion: ya.retencion };
    else {
      await anotarFallo(pool, reclamo, 'deposito', (error as Error).message, ahora);
      fallados.push(`${tipo}:${fecha}`);
      return;
    }
  }
  const ok = await avanzarDeposito(pool, reclamo, 'subido', {
    b2_object_key: objeto, b2_version_id: subida.versionId, retention_until: subida.retencion,
  }, ahora);
  if (!ok) return;
  reclamo.deposito = 'subido';
  // El pendiente se borra recién con la subida confirmada y anotada: antes, es la única copia fuera de la base.
  const fila = await pool.query<{ ruta_pendiente: string | null }>(
    `SELECT ruta_pendiente FROM informes.entregas WHERE tipo = $1 AND fecha = $2`, [tipo, fecha]);
  const ruta = fila.rows[0]?.ruta_pendiente;
  if (ruta) await cfg.deposito.limpiarPendiente(ruta).catch(() => undefined);
}
