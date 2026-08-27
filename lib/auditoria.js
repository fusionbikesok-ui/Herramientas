/**
 * Auditoría de calidad de publicación ML.
 *
 * Barrido rotativo con cursor en sync_estado (mismo patrón que reconciliarStockMl).
 * Multiget ML de a 20 ítems con atributos health, pictures, video_id.
 * No escribe stock ni precios: es solo lectura + registro de problemas.
 */

import { mlFetch } from './mlClient.js';
import { reservarCupo } from './mlRateLimiter.js';

const CHUNK = 20;          // ML permite hasta 20 ids por multiget
const LOTE_POR_CORRIDA = 40; // 2 chunks por corrida de cron
const CALL_DELAY_MS = 400;

// ── Tabla ─────────────────────────────────────────────────────────────────────

export function ensureAuditoriaTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS auditoria_publicacion (
      clave       TEXT PRIMARY KEY,   -- item_id|variation_id
      sku         TEXT,
      health      REAL,               -- 0..1, null si ML no lo devuelve
      fotos_ml    INTEGER,            -- cantidad de fotos en ML
      tiene_video INTEGER NOT NULL DEFAULT 0,  -- 1 si ML devuelve video_id no nulo
      estado_clip TEXT NOT NULL DEFAULT 'sin_revisar',
        -- sin_revisar | sin_clip | grabado | subido_ml | subido_wc
      problemas_json TEXT,            -- array JSON de strings con los problemas detectados
      auditado_en TEXT NOT NULL,      -- última vez que se consultó ML
      revisado_en TEXT                -- última vez que un humano tocó estado_clip
    )
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_auditoria_sku ON auditoria_publicacion(sku)
  `).run();
}

// ── Detección de problemas ─────────────────────────────────────────────────────

function detectarProblemas({ health, fotos_ml, tiene_video }) {
  const p = [];
  if (health != null && health < 0.6) p.push('health_bajo');
  if (fotos_ml != null && fotos_ml < 4)  p.push('pocas_fotos');
  if (!tiene_video)                       p.push('sin_video');
  return p;
}

// ── Cron de barrido rotativo ───────────────────────────────────────────────────

export async function barridoAuditoria(db, mlCfg) {
  const universo = db.prepare(`
    SELECT d.clave, d.sku, p.item_id
    FROM sku_matcher_decisiones d
    JOIN ml_publicaciones_cache p ON p.clave = d.clave
    WHERE d.accion IN ('asignar','confirmar') AND p.item_id IS NOT NULL AND p.item_id <> ''
    ORDER BY d.clave
  `).all();

  if (!universo.length) return { auditados: 0 };

  const cursorRow = db.prepare(
    "SELECT valor FROM sync_estado WHERE clave = 'cursor_auditoria'"
  ).get();
  const cursor = cursorRow?.valor ?? '';

  // Retoma desde el primer clave > cursor (igual que reconciliarStockMl)
  let idx = cursor ? universo.findIndex(r => r.clave > cursor) : 0;
  if (idx < 0) idx = 0; // cursor estaba al final → vuelta completa

  const lote = universo.slice(idx, idx + LOTE_POR_CORRIDA);
  if (!lote.length) {
    db.prepare("INSERT OR REPLACE INTO sync_estado (clave, valor) VALUES ('cursor_auditoria', '')")
      .run();
    return { auditados: 0 };
  }

  // Multiget por item_id (no por clave — ML recibe item_ids, no item_id|variation_id)
  // Un mismo item_id puede tener múltiples variaciones; health/fotos/video son por item.
  const itemIds = [...new Set(lote.map(r => r.item_id))];
  const resultsPorItem = new Map(); // item_id → { health, fotos_ml, tiene_video }

  for (let i = 0; i < itemIds.length; i += CHUNK) {
    if (i > 0) await new Promise(r => setTimeout(r, CALL_DELAY_MS));
    const chunk = itemIds.slice(i, i + CHUNK);
    const cupoOk = await reservarCupo(['lectura'], {});
    if (!cupoOk) continue; // presupuesto ML agotado, reintenta en el siguiente chunk
    const resp = await mlFetch(db, mlCfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,health,pictures,video_id`
    );
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue;
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      const b = entry.body;
      resultsPorItem.set(String(b.id), {
        health: typeof b.health === 'number' ? b.health : null,
        fotos_ml: Array.isArray(b.pictures) ? b.pictures.length : null,
        tiene_video: b.video_id ? 1 : 0,
      });
    }
  }

  const upsert = db.prepare(`
    INSERT INTO auditoria_publicacion
      (clave, sku, health, fotos_ml, tiene_video, problemas_json, auditado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET
      sku=excluded.sku, health=excluded.health, fotos_ml=excluded.fotos_ml,
      tiene_video=excluded.tiene_video, problemas_json=excluded.problemas_json,
      auditado_en=excluded.auditado_en
  `);

  const now = new Date().toISOString();
  let auditados = 0;
  const tx = db.transaction(() => {
    for (const row of lote) {
      const datos = resultsPorItem.get(row.item_id);
      if (!datos) continue; // ML no respondió por este ítem
      const problemas = detectarProblemas(datos);
      upsert.run(
        row.clave, row.sku, datos.health, datos.fotos_ml, datos.tiene_video,
        JSON.stringify(problemas), now
      );
      auditados++;
    }
    const ultimaClave = lote[lote.length - 1].clave;
    db.prepare("INSERT OR REPLACE INTO sync_estado (clave, valor) VALUES ('cursor_auditoria', ?)")
      .run(ultimaClave);
  });
  tx();

  return { auditados };
}
