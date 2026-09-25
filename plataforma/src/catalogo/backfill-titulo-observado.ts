/*
 * src/catalogo/backfill-titulo-observado.ts — llenar `external_representations.titulo_observado` de ML con el
 * último payload ya guardado en el inbox, sin pedirle nada al canal.
 *
 * El proyector lo llena al aplicar una versión nueva (aplicar.ts, tituloObservadoDe), pero el barrido completo
 * deduplica los ítems que no cambiaron: esos nunca vuelven a pasar por el proyector y quedan sin título.
 *
 * Candidatas: representaciones vendibles de ML sin modelo propio (model_id NULL, igual que `!vinculo.modelo` en
 * aplicar.ts) y con titulo_observado NULL. Ese NULL es el checkpoint: idempotente y reanudable sin estado extra.
 * El título sale de proyectarItemMl + tituloObservadoDe, la misma extracción que el proyector. El payload se
 * descifra sólo con descifrarSobre y el keyring del proyector. Cada lote escribe en su propia transacción.
 */
import type pg from 'pg';
import { enTransaccion } from '../db/pool.ts';
import { descifrarSobre, type KeyringSobre } from '../seguridad/sobre.ts';
import { tituloObservadoDe } from './aplicar.ts';
import { esRechazo } from './intenciones.ts';
import { proyectarItemMl } from './ml.ts';

export interface ResumenBackfillTitulo {
  candidatos: number;
  llenaria: number;
  llenadas: number;
  sinPayload: number;
  tituloVacio: number;
  rechazados: number;
  errores: Array<{ recurso: string; motivo: string }>;
  muestras: Array<{ recurso: string; titulo: string }>;
}

interface Fila {
  id: string; channel_account_id: string; recurso: string;
  remote_version: string | null; payload_ciphertext: Buffer | null; payload_key_id: string | null;
  payload_nonce: Buffer | null; payload_tag: Buffer | null;
}

export async function backfillTituloObservado(
  pool: pg.Pool, keyring: KeyringSobre, o: { lote: number; dryRun: boolean; muestras?: number },
): Promise<ResumenBackfillTitulo> {
  const r: ResumenBackfillTitulo = { candidatos: 0, llenaria: 0, llenadas: 0, sinPayload: 0, tituloVacio: 0, rechazados: 0, errores: [], muestras: [] };
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const filas = (await pool.query<Fila>(
      `SELECT r.id, r.channel_account_id, r.recurso, m.remote_version,
              m.payload_ciphertext, m.payload_key_id, m.payload_nonce, m.payload_tag
         FROM catalog.external_representations r
         LEFT JOIN LATERAL (
           SELECT remote_version, payload_ciphertext, payload_key_id, payload_nonce, payload_tag
             FROM integrations.inbox_messages i
            WHERE i.channel_account_id = r.channel_account_id AND i.topic = 'ml.items' AND i.resource_id = r.recurso
              AND i.payload_ciphertext IS NOT NULL
            ORDER BY i.remote_version DESC LIMIT 1) m ON true
        WHERE r.canal = 'mercadolibre' AND r.tipo = 'vendible' AND r.model_id IS NULL AND r.titulo_observado IS NULL
          AND r.id > $1
        ORDER BY r.id LIMIT $2`, [cursor, o.lote])).rows;
    if (!filas.length) break;
    cursor = filas[filas.length - 1]!.id;
    r.candidatos += filas.length;

    const escribir: Array<{ id: string; titulo: string }> = [];
    for (const f of filas) {
      if (!f.payload_ciphertext || !f.payload_key_id || !f.payload_nonce || !f.payload_tag || !f.remote_version) { r.sinPayload++; continue; }
      let titulo: string | null;
      try {
        const claro = descifrarSobre({ ciphertext: f.payload_ciphertext, keyId: f.payload_key_id, nonce: f.payload_nonce, tag: f.payload_tag },
          { account: f.channel_account_id, topic: 'ml.items', resource: f.recurso, remoteVersion: f.remote_version }, keyring);
        const p = proyectarItemMl(JSON.parse(claro.toString('utf8')));
        if (esRechazo(p)) { r.rechazados++; continue; }
        titulo = tituloObservadoDe('mercadolibre', null, p.modelo.titulo);
      } catch (e) {
        r.errores.push({ recurso: f.recurso, motivo: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!titulo) { r.tituloVacio++; continue; }
      r.llenaria++;
      if (r.muestras.length < (o.muestras ?? 10)) r.muestras.push({ recurso: f.recurso, titulo });
      escribir.push({ id: f.id, titulo });
    }

    if (!o.dryRun && escribir.length) {
      r.llenadas += await enTransaccion(pool, async (tx) => {
        let n = 0;
        for (const e of escribir) {
          // Se revalida en el UPDATE: si el proyector la llenó o le dio modelo entre la lectura y acá, no se pisa.
          n += (await tx.query(`UPDATE catalog.external_representations SET titulo_observado = $2
             WHERE id = $1 AND titulo_observado IS NULL AND model_id IS NULL`, [e.id, e.titulo])).rowCount ?? 0;
        }
        return n;
      });
    }
  }
  return r;
}
