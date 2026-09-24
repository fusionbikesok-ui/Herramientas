/*
 * src/identidad/autoridad.ts — E3 corte 1 tarea 2: qué decisión manda sobre el vínculo de una publicación.
 *
 * Orden de consulta (spec E3 §3):
 *   1. Decisión HUMANA vigente de la bandeja (`catalog.identity_decisions`, origen='humano', efecto='aplicar').
 *   2. Decisión copiada del legado (`catalog.matcher_decisions`), como historia.
 *   3. (Corte 3) sólo con el flag E3_AUTO_SKU o durante el canario: decisión E3 auto_sku.
 *   4. Si no hay ninguna, sku_pendiente.
 *
 * Este corte no tiene auto_sku aplicado (D2): el paso 3 no existe todavía.
 *
 * `decisionVigente` es la ÚNICA función que consulta la autoridad — `vincularMl` (aplicar.ts) y
 * `reconciliarClave` (decisiones.ts) la llaman en vez de tener cada una su propio SELECT sobre
 * matcher_decisions. Enmienda de la revisión de Codex (commit 7055e0ec): las dos rutas, no sólo una.
 *
 * Fallback al legado, EXACTO como hoy (enmienda de la revisión de Codex): la búsqueda del destino por
 * SKU NO filtra variantes archivadas, ni acá ni en el llamador. Es a propósito: cambiar ese
 * comportamiento es una decisión de producto (¿una decisión vieja del legado debería poder revivir una
 * variante archivada?) que este corte no toma — sólo se está centralizando el SELECT que ya existía en
 * dos lugares, no cambiando lo que decide. La validación de "variante no archivada" SÍ se exige para las
 * decisiones HUMANAS nuevas de la bandeja, pero eso es la tarea 3 (decidirCaso), no esta.
 *
 * Con el flag `bandeja` apagado, `decisionVigente` ni siquiera consulta `identity_decisions`: el
 * comportamiento es idéntico al de antes de E3, bit a bit (mismo SELECT sobre matcher_decisions que ya
 * había en aplicar.ts y decisiones.ts).
 */
import type { Consultable } from '../db/pool.ts';

export type Vigente =
  | { fuente: 'humano'; eleccion: 'vincular'; variantId: string; decisionId: string }
  | { fuente: 'humano'; eleccion: 'omitir' | 'mantener_omision' | 'sin_candidato'; decisionId: string }
  | { fuente: 'legado'; accion: 'omitir' }
  | { fuente: 'legado'; accion: 'confirmar' | 'asignar'; sku: string }
  | null;

export async function decisionVigente(
  tx: Consultable, cuenta: string, recurso: string, variacion: string, o: { bandeja: boolean },
): Promise<Vigente> {
  if (o.bandeja) {
    const humana = (await tx.query<{ id: string; eleccion: string; variant_id: string | null }>(
      `SELECT id, eleccion, variant_id FROM catalog.identity_decisions
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
          AND origen = 'humano' AND efecto = 'aplicar' AND superada_en IS NULL`,
      [cuenta, recurso, variacion])).rows[0];
    if (humana) {
      if (humana.eleccion === 'vincular' && humana.variant_id) {
        return { fuente: 'humano', eleccion: 'vincular', variantId: humana.variant_id, decisionId: humana.id };
      }
      if (humana.eleccion !== 'vincular') {
        return { fuente: 'humano', eleccion: humana.eleccion as 'omitir' | 'mantener_omision' | 'sin_candidato', decisionId: humana.id };
      }
    }
  }

  // Fallback al legado: MISMO SELECT que aplicar.ts/decisiones.ts tenían antes de esta tarea, sin
  // ningún filtro nuevo. Ver el comentario de arriba.
  const legado = (await tx.query<{ accion: string; sku: string | null }>(
    `SELECT accion, sku FROM catalog.matcher_decisions
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND vigente_hasta IS NULL`,
    [cuenta, recurso, variacion])).rows[0];
  if (!legado) return null;
  if (legado.accion === 'omitir') return { fuente: 'legado', accion: 'omitir' };
  if ((legado.accion === 'confirmar' || legado.accion === 'asignar') && legado.sku) {
    return { fuente: 'legado', accion: legado.accion, sku: legado.sku };
  }
  return null;
}
