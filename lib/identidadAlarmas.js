// Alarma de la saga de identidad: operaciones encoladas que nadie ejecuta.
//
// El worker solo procesa las claves del canario (identidad_config.canario_ml_key, hasta 2) y de a
// `lote_max`. Una operación `pendiente` sobre otra clave no falla ni se reintenta: espera para
// siempre y nadie se entera. En producción 19 quedaron así desde el 12/09 (más de tres semanas).
// "Sin ejecutar" = `pendiente`, 0 intentos y ningún paso registrado. Una `shadow` no cuenta: está
// así a propósito (las escrituras remotas estaban deshabilitadas).

export const UMBRAL_ENCOLADAS_MS = 2 * 60 * 60 * 1000;

export function encoladasSinEjecutar(db, { ahora = new Date(), umbralMs = UMBRAL_ENCOLADAS_MS } = {}) {
  const limite = new Date(ahora.getTime() - umbralMs).toISOString();
  const filas = db.prepare(`SELECT o.id, o.ml_key, o.iniciada_en FROM identidad_operaciones o
    WHERE o.estado='pendiente' AND o.intentos=0 AND o.iniciada_en<=?
      AND NOT EXISTS (SELECT 1 FROM identidad_operacion_pasos p WHERE p.operacion_id=o.id)
    ORDER BY o.iniciada_en`).all(limite);
  const cfg = db.prepare('SELECT canario_ml_key FROM identidad_config WHERE id=1').get();
  const canarios = new Set(String(cfg?.canario_ml_key || '').split(',').map((k) => k.trim()).filter(Boolean));
  // Segundo contador: operaciones colgadas en `procesando` con el claim vencido (el worker murió o el
  // paso se trabó a mitad). No entran en `n`: ya tuvieron un intento.
  const procesandoVencidas = db.prepare(`SELECT COUNT(*) n FROM identidad_operaciones WHERE estado='procesando' AND claim_hasta IS NOT NULL AND claim_hasta<?`).get(ahora.toISOString()).n;
  return {
    n: filas.length,
    procesando_vencidas: procesandoVencidas,
    mas_vieja_horas: filas.length ? Math.floor((ahora.getTime() - Date.parse(filas[0].iniciada_en)) / 3600000) : 0,
    ids: filas.slice(0, 10).map((f) => f.id),
    // Fuera del canario: el worker NO las va a tomar nunca; hay que cancelarlas o ampliar el canario.
    fuera_de_canario: canarios.size ? filas.filter((f) => !canarios.has(f.ml_key)).length : 0,
  };
}
