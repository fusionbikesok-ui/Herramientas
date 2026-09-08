/**
 * Ciclo de vida de los tokens de push.
 *
 * Apple avisa cuándo un token dejó de servir, y hay que hacerle caso: si no se revoca, la
 * tabla se llena de muertos y cada envío desperdicia una request contra el límite de Apple.
 *
 * La distinción que importa: `410 Unregistered` y `400 BadDeviceToken` son del TOKEN, y son
 * definitivos. `429` y los `5xx` son de Apple y son pasajeros — revocarlos perdería
 * dispositivos sanos por una caída ajena.
 */

/** Motivos por los que el token no vuelve a servir nunca. */
export const MOTIVOS_TERMINALES = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

export function revocarPorRespuesta(db, deviceToken, respuesta) {
  if (!respuesta || respuesta.ok) return false;
  if (!MOTIVOS_TERMINALES.has(respuesta.reason)) return false;
  const ts = new Date().toISOString();
  const r = db.prepare('UPDATE device_tokens SET revocado_en = ?, actualizado_en = ? WHERE token = ? AND revocado_en IS NULL')
    .run(ts, ts, deviceToken);
  if (r.changes) {
    // Sin token ni payload: sólo el motivo, que es lo que sirve para diagnosticar.
    console.warn(`[push] token revocado por APNs (${respuesta.reason})`);
  }
  return r.changes > 0;
}
