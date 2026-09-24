/*
 * src/informes/correccion.ts — corrección firmada de los manifiestos con `last_hash` incorrecto.
 *
 * Bug real, corregido en manifiesto.ts (commit 58a611d1): un ORDER BY resolvía contra el alias de
 * salida `chain_seq::text` y ordenaba lexicográficamente, así que un evento con chain_seq de 4
 * dígitos que empezaba con '9' (p. ej. 9999) le ganaba en orden de texto a uno de 5 dígitos que
 * empezaba con '1' (11165, etc.), y el manifiesto quedaba firmado con el hash de un evento viejo en
 * vez del último real del día. Decisión de José: publicar una corrección firmada aparte, SIN tocar
 * ni resubir los manifiestos originales — la evidencia ya subida a B2 en modo compliance es
 * irreversible por diseño, y corregirla ahí adentro rompería esa garantía.
 *
 * La corrección es su propio artefacto firmado (mismo par de claves, mismo depósito, misma
 * retención compliance), bajo una clave de objeto NUEVA
 * (`correcciones/<fecha-emisión>-manifiestos-<sha8>.json`, con los primeros 8 caracteres del hash
 * del sobre firmado: dos correcciones publicadas el mismo día, con conjuntos de fechas distintos,
 * no pueden chocar en la misma clave "vigente" de B2), nunca la del original. Registra un evento
 * append-only en audit.audit_events para que quede trazado que se publicó, con la clave de objeto,
 * el version id y el hash del JSON firmado.
 *
 * Idempotente por diseño de "última palabra": antes de publicar, se pregunta a `audit.audit_events`
 * si ya hay una corrección publicada para el mismo conjunto de fechas (mismo payload.fechas
 * ordenado) — de haberla, no se publica una segunda. Esto es más simple que reconciliar contra B2 y
 * suficiente: el único escritor de correcciones es este módulo.
 */
import type pg from 'pg';
import type { KeyObject } from 'node:crypto';
import { createHash, randomUUID } from 'node:crypto';
import { firmar, type Sobre } from './firma.ts';
import { registrarEvento } from '../audit/auditoria.ts';
import type { Deposito } from './deposito.ts';

/** El commit donde se arregló manifiesto.ts: se declara en el JSON para que quede trazado desde cuándo el bug no puede volver a producir este mismo error. */
export const COMMIT_FIX = '58a611d1';
export const CAUSA = "ORDER BY resolvía contra el alias chain_seq::text: orden lexicográfico, 9999 > 10000+";

export interface DiaCorregido {
  fecha: string;
  last_chain_seq: string;
  hash_declarado: string;
  hash_correcto: string;
  b2_object_key_original: string | null;
  b2_version_id_original: string | null;
}

export interface ContenidoCorreccion {
  tipo: 'correccion_manifiesto';
  emitido_en: string;
  commit_fix: string;
  causa: string;
  dias: DiaCorregido[];
}

export interface OpcionesCorreccion {
  fechas: string[];
  clave: { kid: string; privada: KeyObject };
  deposito: Deposito;
  reloj?: () => Date;
  companyId: string;
  /** true (default): sólo arma y muestra el JSON, sin firmar ni subir ni registrar nada. */
  dryRun?: boolean;
}

export type ResultadoCorreccion =
  | { publicado: true; dias: DiaCorregido[]; b2ObjectKey: string; b2VersionId: string; hashSobre: string }
  | { publicado: false; motivo: 'sin_discrepancias' | 'ya_publicada' | 'dry_run'; dias: DiaCorregido[] };

// El sha8 del contenido evita que dos correcciones publicadas el mismo día (conjuntos de fechas
// distintos) choquen en la misma clave de objeto: B2 versiona, pero la versión "vigente" (la que
// devuelve un GET sin versionId) pisaría a la anterior, y un lector que no pida versión explícita
// vería sólo la última.
const claveObjeto = (fechaEmision: string, sha8: string) => `correcciones/${fechaEmision}-manifiestos-${sha8}.json`;
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Para cada fecha pedida, compara el `last_hash` declarado en `audit_daily_manifests` contra el
 * hash real del evento con ese `last_chain_seq` (columna numérica, sin el bug del alias). Sólo
 * devuelve los días donde difieren.
 */
async function detectarDiscrepancias(pool: pg.Pool, fechas: string[]): Promise<DiaCorregido[]> {
  const r = await pool.query<{
    fecha: string; last_chain_seq: string | null; hash_declarado: string | null; hash_correcto: string | null;
    b2_object_key: string | null; b2_version_id: string | null;
  }>(
    `SELECT to_char(m.manifest_date, 'YYYY-MM-DD') AS fecha, m.last_chain_seq::text AS last_chain_seq,
            encode(m.last_hash, 'hex') AS hash_declarado, encode(e.hash, 'hex') AS hash_correcto,
            m.b2_object_key, m.b2_version_id
       FROM audit.audit_daily_manifests m
       LEFT JOIN audit.audit_events e ON e.chain_seq = m.last_chain_seq
      WHERE m.manifest_date = ANY($1::date[])`,
    [fechas],
  );
  const dias: DiaCorregido[] = [];
  for (const f of r.rows) {
    if (!f.last_chain_seq || !f.hash_declarado || !f.hash_correcto) continue; // día vacío o sin evento: nada que reconciliar acá
    if (f.hash_declarado === f.hash_correcto) continue;
    dias.push({
      fecha: f.fecha, last_chain_seq: f.last_chain_seq, hash_declarado: f.hash_declarado,
      hash_correcto: f.hash_correcto, b2_object_key_original: f.b2_object_key, b2_version_id_original: f.b2_version_id,
    });
  }
  return dias.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Clave estable de un conjunto de fechas, para comparar correcciones ya publicadas sin ambigüedad de orden. */
const clavesDeFechas = (dias: DiaCorregido[]) => [...dias.map((d) => d.fecha)].sort().join(',');

async function correccionYaPublicada(pool: pg.Pool, fechasOrdenadas: string): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit.audit_events
      WHERE action = 'informes.correccion_publicada' AND payload->>'fechas' = $1`,
    [fechasOrdenadas],
  );
  return (r.rows[0]?.n ?? '0') !== '0';
}

export async function publicarCorreccion(pool: pg.Pool, o: OpcionesCorreccion): Promise<ResultadoCorreccion> {
  const reloj = o.reloj ?? (() => new Date());
  const dias = await detectarDiscrepancias(pool, o.fechas);
  if (!dias.length) return { publicado: false, motivo: 'sin_discrepancias', dias: [] };

  const fechasOrdenadas = clavesDeFechas(dias);
  if (await correccionYaPublicada(pool, fechasOrdenadas)) return { publicado: false, motivo: 'ya_publicada', dias };

  if (o.dryRun ?? true) return { publicado: false, motivo: 'dry_run', dias };

  const ahora = reloj();
  const fechaEmision = ahora.toISOString().slice(0, 10);
  const contenido: ContenidoCorreccion = {
    tipo: 'correccion_manifiesto', emitido_en: ahora.toISOString(), commit_fix: COMMIT_FIX, causa: CAUSA, dias,
  };
  const sobre: Sobre = firmar(contenido, o.clave);
  const cuerpo = JSON.stringify(sobre);
  const hashSobre = sha256Hex(cuerpo);
  const objeto = claveObjeto(fechaEmision, hashSobre.slice(0, 8));

  await o.deposito.guardarPendiente(objeto, cuerpo);
  const subida = await o.deposito.subir(objeto, cuerpo, ahora);
  await o.deposito.limpiarPendiente(objeto).catch(() => undefined);

  await registrarEvento(pool, {
    companyId: o.companyId, actorType: 'system', actorId: 'correccion-manifiestos',
    action: 'informes.correccion_publicada', aggregateType: 'audit_daily_manifests', aggregateId: objeto,
    correlationId: randomUUID(),
    payload: { fechas: fechasOrdenadas, b2_object_key: objeto, b2_version_id: subida.versionId, hash_sobre: hashSobre },
  });

  return { publicado: true, dias, b2ObjectKey: objeto, b2VersionId: subida.versionId, hashSobre };
}
