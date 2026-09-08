// lib/apnsClient.js
/**
 * Transporte hacia APNs.
 *
 * APNs exige HTTP/2: `fetch` de Node es HTTP/1.1 y no sirve, por eso se usa `node:http2` de
 * la librería estándar en lugar de agregar una dependencia.
 *
 * Este módulo no sabe de la base de datos ni de usuarios: recibe un token y un payload, y
 * devuelve lo que dijo Apple. Quién revoca un token muerto se decide en `lib/pushTokens.js`.
 */
import http2 from 'node:http2';
import { tokenProveedor } from './apnsJwt.js';

export const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

const TIMEOUT_MS = 10_000;

/**
 * `apns-push-type` tiene que coincidir con el payload o iOS descarta la notificación sin
 * avisar. Un push con `content-available` y sin alerta es `background`, y además Apple exige
 * prioridad 5 para esos.
 */
function tipoDePush(payload) {
  const aps = payload?.aps || {};
  const silencioso = aps['content-available'] === 1 && !aps.alert && !aps.sound;
  return silencioso ? { tipo: 'background', prioridad: 5 } : { tipo: 'alert', prioridad: 10 };
}

export async function enviarApns(deviceToken, payload, { entorno = 'production', cfg, sesionFactory } = {}) {
  const host = HOSTS[entorno] || HOSTS.production;
  const conectar = sesionFactory || http2.connect;
  const { tipo, prioridad } = tipoDePush(payload);

  let jwt;
  try {
    jwt = tokenProveedor(cfg);
  } catch (e) {
    return { ok: false, status: 0, reason: 'ConfiguracionInvalida', mensaje: e.message };
  }

  const sesion = conectar(host);
  try {
    return await new Promise((resolve) => {
      const cuerpo = JSON.stringify(payload);
      const stream = sesion.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': tipo,
        'apns-priority': prioridad,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(cuerpo),
      });

      let status = 0;
      let datos = '';
      const temporizador = setTimeout(() => {
        // Un envío colgado no puede frenar la cola: se corta y se trata como reintentable.
        resolve({ ok: false, status: 0, reason: 'Timeout', reintentable: true });
        try { stream.close(); } catch { /* la sesión ya se cierra en el finally */ }
      }, TIMEOUT_MS);

      stream.setEncoding('utf8');
      stream.on('response', (cabeceras) => { status = Number(cabeceras[':status']) || 0; });
      stream.on('data', (trozo) => { datos += trozo; });
      stream.on('error', (e) => {
        clearTimeout(temporizador);
        resolve({ ok: false, status: 0, reason: 'ErrorDeRed', mensaje: e.message, reintentable: true });
      });
      stream.on('end', () => {
        clearTimeout(temporizador);
        if (status === 200) return resolve({ ok: true, status });
        let reason = 'Desconocida';
        try { reason = JSON.parse(datos)?.reason || reason; } catch { /* Apple no siempre manda JSON */ }
        // 429 y 5xx son de Apple, no del token: se reintentan. 400/403/410 no.
        resolve({ ok: false, status, reason, reintentable: status === 429 || status >= 500 });
      });
      stream.end(cuerpo);
    });
  } finally {
    try { sesion.close(); } catch { /* sesión ya cerrada */ }
  }
}
