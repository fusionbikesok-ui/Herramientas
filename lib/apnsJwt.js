/**
 * JWT de proveedor para APNs.
 *
 * Apple pone dos límites opuestos y hay que quedar en el medio: un token de más de una hora
 * se rechaza con `403 ExpiredProviderToken`, pero regenerarlo demasiado seguido devuelve
 * `429 TooManyProviderTokenUpdates`. Por eso se cachea y se renueva cada 20 minutos, que es
 * el mínimo que Apple tolera y deja 40 de margen antes del vencimiento.
 *
 * Mismo patrón que el caché de token de `lib/mlClient.js`.
 */
import crypto from 'node:crypto';

const VENTANA_REFRESCO_MS = 20 * 60 * 1000;

let cache = null;

/** Sólo para tests: el caché es de módulo y sobreviviría entre casos. */
export function _resetCacheJwt() { cache = null; }

const base64url = (valor) => Buffer.from(valor).toString('base64url');

export function tokenProveedor(cfg, ahora = Date.now()) {
  const { keyId, teamId, privateKey } = cfg || {};
  if (!keyId || !teamId || !privateKey) {
    throw new Error('Falta configuración de APNs: APNS_KEY_ID, APNS_TEAM_ID y APNS_PRIVATE_KEY son obligatorios');
  }
  const huella = `${keyId}:${teamId}`;
  if (cache && cache.huella === huella && ahora - cache.generadoEn < VENTANA_REFRESCO_MS) {
    return cache.token;
  }

  const iat = Math.floor(ahora / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat }));
  // `dsaEncoding: 'ieee-p1363'` es la línea que más tiempo cuesta si falta: pide la firma en
  // formato r||s de 64 bytes, que es el que exige JOSE. El default de Node es DER, y con DER
  // Apple rechaza el token sin decir por qué.
  const firma = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const token = `${header}.${payload}.${firma}`;
  cache = { huella, token, generadoEn: ahora };
  return token;
}
