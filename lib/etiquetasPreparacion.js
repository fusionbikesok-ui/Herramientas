/**
 * Etiquetas en Preparación (spec 2026-10-15-etiquetas-preparacion-design.md, v8–v23). Esquema idempotente de la migración 133 y sus backfills.
 *
 * Las tablas de preparación las crea `ensureTables` (routes/preparacion.js), no db/index.js, así que el esquema vive acá y lo llaman los dos:
 * la migración (bases de producción, con backfill una sola vez) y `ensureTables` (bases nuevas, sin nada que rellenar).
 */

import { TIPO_FOTO_ETIQUETA } from './preparacion.js';

const COLUMNAS_PREPARACIONES = [
  'etiqueta_cargada_en TEXT',        // cuándo quedó cargada la etiqueta (foto 'listo', histórico inferido o resolución «sin foto»)
  'etiqueta_origen TEXT',            // foto | historico_inferido | sin_foto
  'envio_confirmado_en TEXT',        // web: paso 2 de Seguimientos OK · ML: despacho (trigger de despacho_controles)
  'envio_descartado_en TEXT',        // resolución manual con motivo («Descartar con motivo»)
  'envio_descartado_motivo TEXT',
  'envio_descartado_por TEXT',
];

// Cuerpo común de los dos triggers: SOLO preparaciones ML se fechan por despacho (v21); web toma su fecha del paso 2.
const CUERPO_TRIGGER = `UPDATE preparaciones SET envio_confirmado_en = COALESCE(envio_confirmado_en, NEW.confirmado_en)
  WHERE canal='ml' AND (clave = NEW.grupo_clave OR pack_id = NEW.grupo_clave);`;

const yaAsegurado = new WeakSet();

const existeTabla = (db, nombre) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre);

/** Columnas, índices y triggers. Idempotente; no hace nada si `preparaciones` todavía no existe (base nueva, antes de ensureTables). */
export function asegurarEsquemaEtiquetas(db) {
  if (yaAsegurado.has(db)) return;
  if (!existeTabla(db, 'preparaciones')) return;
  const existentes = new Set(db.prepare('PRAGMA table_info(preparaciones)').all().map((c) => c.name));
  for (const def of COLUMNAS_PREPARACIONES) {
    if (!existentes.has(def.split(' ')[0])) db.exec(`ALTER TABLE preparaciones ADD COLUMN ${def}`);
  }
  if (!existentes.has('pack_id')) db.exec('ALTER TABLE preparaciones ADD COLUMN pack_id TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prep_falta_etiqueta ON preparaciones(estado, etiqueta_cargada_en, completado_en)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prep_falta_seguimiento ON preparaciones(canal, estado, envio_confirmado_en, envio_descartado_en)`);
  if (existeTabla(db, 'despacho_controles')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_envio_ml_ins AFTER INSERT ON despacho_controles WHEN NEW.confirmado_en IS NOT NULL BEGIN ${CUERPO_TRIGGER} END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_envio_ml_upd AFTER UPDATE OF confirmado_en ON despacho_controles WHEN NEW.confirmado_en IS NOT NULL BEGIN ${CUERPO_TRIGGER} END;`);
  }
  yaAsegurado.add(db);
}

/**
 * Backfills de una sola vez (v8.4, v10.2/10.3, v11.1, v20.2), todos acotados por canal (v21). Solo se completan columnas en NULL: nunca pisa.
 * Marca todo lo inferido como `historico_inferido` y deja un evento por preparación tocada, para poder distinguirlo de lo real.
 */
export function backfillEtiquetas133(db) {
  if (!['preparaciones', 'preparacion_fotos', 'preparacion_eventos'].every((t) => existeTabla(db, t))) return { web: 0, ml: 0, etiquetas: 0 };
  const ts = new Date().toISOString();
  const resultado = { web: 0, ml: 0, etiquetas: 0 };
  db.transaction(() => {
    // v8.4 — web: completada con tracking, paso 2 no pendiente y sin abandono → confirmada a la fecha de cierre (histórico inferido).
    resultado.web = db.prepare(`UPDATE preparaciones SET envio_confirmado_en = completado_en
      WHERE canal='web' AND estado='completada' AND envio_confirmado_en IS NULL AND completado_en IS NOT NULL
        AND tracking IS NOT NULL AND TRIM(tracking) <> '' AND woo_paso2_pendiente = 0
        AND NOT EXISTS (SELECT 1 FROM preparacion_eventos e WHERE e.preparacion_id = preparaciones.id AND e.tipo = 'tracking_abandonado')`).run().changes;

    // v20.2/v21 — ML por despacho individual o regularización: control confirmado → la más temprana de las fuentes.
    if (existeTabla(db, 'despacho_controles')) {
      resultado.ml += db.prepare(`UPDATE preparaciones SET envio_confirmado_en = (
          SELECT MIN(d.confirmado_en) FROM despacho_controles d
          WHERE d.confirmado_en IS NOT NULL AND (preparaciones.clave = d.grupo_clave OR preparaciones.pack_id = d.grupo_clave))
        WHERE canal='ml' AND EXISTS (
          SELECT 1 FROM despacho_controles d
          WHERE d.confirmado_en IS NOT NULL AND (preparaciones.clave = d.grupo_clave OR preparaciones.pack_id = d.grupo_clave)
            AND (preparaciones.envio_confirmado_en IS NULL OR preparaciones.envio_confirmado_en > d.confirmado_en))`).run().changes;
    }
    // v10.2/v11.1 — ML por salida de lote: solo miembros `confirmado` de lotes con salida confirmada.
    if (existeTabla(db, 'despacho_lote_items') && existeTabla(db, 'despacho_lotes') && existeTabla(db, 'despacho_controles')) {
      const subSalida = `SELECT MIN(l.salida_confirmada_en) FROM despacho_lote_items li
          JOIN despacho_lotes l ON l.id = li.lote_id
          JOIN despacho_controles d ON d.id = li.control_id
          WHERE li.estado = 'confirmado' AND l.salida_confirmada_en IS NOT NULL
            AND (preparaciones.clave = d.grupo_clave OR preparaciones.pack_id = d.grupo_clave)`;
      resultado.ml += db.prepare(`UPDATE preparaciones SET envio_confirmado_en = (${subSalida})
        WHERE canal='ml' AND (${subSalida}) IS NOT NULL
          AND (envio_confirmado_en IS NULL OR envio_confirmado_en > (${subSalida}))`).run().changes;
    }

    // v9.1/v10.3/v11.3 — etiqueta histórica: foto paquete_cerrado/paquete_etiquetado → su fecha; sin ninguna → fecha de cierre.
    resultado.etiquetas = db.prepare(`UPDATE preparaciones SET
        etiqueta_cargada_en = COALESCE(
          (SELECT MIN(f.creado_en) FROM preparacion_fotos f WHERE f.preparacion_id = preparaciones.id AND f.tipo IN ('paquete_cerrado','paquete_etiquetado')),
          completado_en, creado_en),
        etiqueta_origen = 'historico_inferido'
      WHERE estado IN ('completada','anulado_en_woo') AND etiqueta_cargada_en IS NULL`).run().changes;

    db.prepare(`INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
      SELECT id, NULL, 'migracion_133_historico', NULL, ?, ? FROM preparaciones
      WHERE etiqueta_origen = 'historico_inferido'`).run(JSON.stringify({ nota: 'etiqueta y/o envío inferidos de datos históricos (migración 133)' }), ts);
  })();
  return resultado;
}

/**
 * La foto con etiqueta llegó a `listo` (llamar DENTRO de la transacción que la marca así, v13.3): la etiqueta queda cargada con origen `foto` y las
 * fotos de etiqueta anteriores pasan a «no vigentes» (soft-delete, sin borrar archivos; la purga las retira a los 30 días). Nunca mueve la marca hacia atrás.
 */
export function marcarEtiquetaCargadaPorFoto(db, { fotoId, preparacionId }, ts = new Date().toISOString()) {
  db.prepare(`UPDATE preparaciones SET etiqueta_cargada_en = CASE WHEN etiqueta_cargada_en > ? THEN etiqueta_cargada_en ELSE ? END, etiqueta_origen = 'foto' WHERE id = ?`).run(ts, ts, preparacionId);
  db.prepare(`UPDATE preparacion_fotos SET borrado_en = ? WHERE preparacion_id = ? AND tipo = ? AND id < ? AND borrado_en IS NULL`).run(ts, preparacionId, TIPO_FOTO_ETIQUETA, fotoId);
}

/** Se borró una foto de etiqueta con la preparación abierta (v12.3): si no queda ninguna `listo` vigente, la marca vuelve a NULL. */
export function recalcularEtiquetaCargada(db, preparacionId) {
  const queda = db.prepare(`SELECT 1 FROM preparacion_fotos WHERE preparacion_id = ? AND tipo = ? AND borrado_en IS NULL AND estado_proceso = 'listo' LIMIT 1`).get(preparacionId, TIPO_FOTO_ETIQUETA);
  if (!queda) db.prepare(`UPDATE preparaciones SET etiqueta_cargada_en = NULL, etiqueta_origen = NULL WHERE id = ? AND etiqueta_origen = 'foto'`).run(preparacionId);
}
