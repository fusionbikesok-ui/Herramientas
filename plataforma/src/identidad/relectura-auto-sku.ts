/*
 * src/identidad/relectura-auto-sku.ts — E3 corte 3 tarea 2: relectura de ML con la política de auto-SKU
 * (spec §6), antes de aplicar un auto-vínculo. La red se lee FUERA de cualquier transacción de Postgres —
 * igual que el resto del código de red del proyecto (cliente-http.ts, cortes anteriores).
 *
 * Reusa el relector existente `crearRelectoresMl(...)['ml.items']` (reconciliacion/relectura.ts): no se crea
 * otro cliente HTTP. Ese relector YA distingue 404 (`sin_baja`) de un `ErrorBarridoReintentable`
 * (408/429/5xx, con `retryAfter` opcional) de un `ErrorCanalTerminal` (401/403/4xx). Acá se decide qué
 * SIGNIFICA cada resultado para el auto-SKU, con reintento propio (3 intentos, backoff exponencial con
 * jitter) porque `Relector.releer` no reintenta solo — cada llamador define su propia política de reintento
 * (ver conReintento en catalogo/ml.ts, que hace lo mismo para el barrido completo).
 */
import { createHash } from 'node:crypto';
import { estructuraItemMl, hashEstructura, type EstructuraMl } from './formato.ts';
import { normalizarSku } from './sku.ts';
import { canonizar } from '../informes/jcs.ts';
import { skuMl } from '../catalogo/ml.ts';
import { ErrorBarridoReintentable } from '../worker/barridos.ts';
import { ErrorCanalTerminal } from '../reconciliacion/cliente-http.ts';
import type { Relector } from '../reconciliacion/relectura.ts';

export type ResultadoRelecturaAutoSku =
  | { tipo: 'ok'; hashPayload: string; estructura: EstructuraMl }
  | { tipo: 'cambio'; que: 'sku' | 'formato'; detalle: object }
  | { tipo: 'no_disponible'; motivo: 'not_found' | 'closed' | 'deleted' }
  | { tipo: 'parked'; motivo: string }
  | { tipo: 'abortar'; status: 401 | 403 };

type Registro = Record<string, unknown>;
const esRegistro = (x: unknown): x is Registro => typeof x === 'object' && x !== null && !Array.isArray(x);

const MAX_INTENTOS = 3;
const BASE_MS = 1000;
const JITTER = 0.2;

interface Dependencias {
  esperar?(ms: number): Promise<void>;
  azar?(): number;
}

/**
 * El SKU declarado de la representación que corresponde a `variacion`: si `variacion` no es `''`, el de la
 * variación con ese id (o `no_informado` si el ítem no la trae más); si es `''`, el del ítem. Reusa `skuMl`
 * (catalogo/ml.ts) — misma regla que ya usa `sku_observado`, no se reimplementa acá.
 */
function skuDeRepresentacion(payload: Registro, variacion: string): ReturnType<typeof skuMl> {
  if (variacion === '') return skuMl(payload);
  const variaciones = Array.isArray(payload.variations) ? payload.variations.filter(esRegistro) : [];
  const v = variaciones.find((x) => String(x.id) === variacion);
  if (!v) return { estado: 'no_informado' };
  return skuMl(v);
}

/** sha256 de canonizar(payload): el payload releído ENTERO (no sólo su EstructuraMl, que es un subconjunto
 *  de campos), para que quede evidencia exacta de qué se releyó (guardado en hash_payload_ml, Tarea 4). */
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonizar(payload), 'utf8').digest('hex');
}

async function esperarConBackoff(dep: Dependencias, intento: number, retryAfterS: number | undefined): Promise<void> {
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const azar = dep.azar ?? Math.random;
  const ms = retryAfterS !== undefined
    ? retryAfterS * 1000
    : Math.round(BASE_MS * 2 ** intento * (1 - JITTER + 2 * JITTER * azar()));
  await esperar(ms);
}

export async function releerParaAutoSku(
  relector: Relector,
  e: { recurso: string; variacion: string; skuCongelado: string; hashFormatoPrevio: string | null },
  dep: Dependencias = {},
): Promise<ResultadoRelecturaAutoSku> {
  let ultimoError: unknown;
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    try {
      const resultado = await relector.releer(e.recurso);

      if (resultado.tipo === 'sin_baja') return { tipo: 'no_disponible', motivo: 'not_found' };
      if (resultado.tipo === 'barrido') return { tipo: 'parked', motivo: 'incompleta' };

      const recurso = resultado.recursos[0];
      // Hallazgo Alto de la segunda opinión de Codex, 2026-09-25: el plan exige 'parked'/'incompleta' si
      // falta id O status, pero sólo se validaba id — un payload sin `status` pasaba con lifecycle 'open'
      // (cicloPorEstado trata ausente como abierto) y se procesaba como si estuviera completo.
      if (!recurso || !esRegistro(recurso.payload) || !recurso.id || typeof recurso.payload.status !== 'string') {
        return { tipo: 'parked', motivo: 'incompleta' };
      }
      if (recurso.lifecycle === 'closed' || recurso.lifecycle === 'deleted') {
        return { tipo: 'no_disponible', motivo: recurso.lifecycle };
      }
      // 'paused' sigue elegible (spec §6): no es closed/deleted, se procesa como cualquier 200 vivo.

      const payload = recurso.payload;
      const sku = skuDeRepresentacion(payload, e.variacion);
      if (sku.estado === 'no_informado') return { tipo: 'parked', motivo: 'incompleta' };
      const skuNormalizado = normalizarSku('valor' in sku ? sku.valor : null);
      const estructura = estructuraItemMl(payload);
      const hashFormato = hashEstructura(estructura);

      const cambioSku = skuNormalizado !== normalizarSku(e.skuCongelado);
      const cambioFormato = e.hashFormatoPrevio !== null && e.hashFormatoPrevio !== hashFormato;
      // Precedencia si cambiaron los dos a la vez (misma que registrarFormato, Tarea 1): 'sku' gana.
      if (cambioSku) return { tipo: 'cambio', que: 'sku', detalle: { skuCongelado: e.skuCongelado, skuObservado: skuNormalizado } };
      if (cambioFormato) return { tipo: 'cambio', que: 'formato', detalle: { hashFormatoPrevio: e.hashFormatoPrevio, hashFormatoObservado: hashFormato } };

      return { tipo: 'ok', hashPayload: hashPayload(payload), estructura };
    } catch (error) {
      ultimoError = error;
      if (error instanceof ErrorCanalTerminal) {
        if (error.status === 401 || error.status === 403) return { tipo: 'abortar', status: error.status };
        return { tipo: 'parked', motivo: `canal_terminal:${error.message}` };
      }
      if (error instanceof ErrorBarridoReintentable) {
        if (intento < MAX_INTENTOS - 1) {
          await esperarConBackoff(dep, intento, error.retryAfter);
          continue;
        }
        return { tipo: 'parked', motivo: `reintentable_agotado:${error.message}` };
      }
      throw error;
    }
  }
  // No debería llegar acá (el loop siempre retorna o lanza), pero TypeScript no lo infiere del catch/continue.
  return { tipo: 'parked', motivo: `agotado:${String(ultimoError)}` };
}
