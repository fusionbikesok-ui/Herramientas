/**
 * E1 T3 C5 — autenticación del plano de control interno en el legado.
 *
 * Es el mismo contrato que `plataforma/src/seguridad/interna.ts` (la plataforma firma, el legado
 * verifica): firma v1 = HMAC-SHA256 en hex sobre
 * "v1\n{timestamp}\n{nonce}\n{MÉTODO}\n{path}\n{sha256(cuerpo) hex}", encabezados x-fusion-key-id,
 * x-fusion-timestamp, x-fusion-nonce y x-fusion-signature, ventana de 300 s y cualquier clave del
 * keyring (dos claves simultáneas durante una rotación). Un test de la plataforma firma con el módulo
 * TS y verifica con éste, para que los dos lados no puedan divergir en silencio.
 *
 * Nginx es la defensa principal (deny de /internal/ y /herramientas/internal/); esto es la adicional.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';

export const VENTANA_S = 300;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const FIRMA = /^[0-9a-f]{64}$/;
const ID_CLAVE = /^[A-Za-z0-9._-]{1,128}$/;

export function firmarInterno(clave, timestamp, nonce, metodo, ruta, cuerpo) {
  const hash = crypto.createHash('sha256').update(cuerpo).digest('hex');
  return crypto.createHmac('sha256', clave)
    .update(`v1\n${timestamp}\n${nonce}\n${String(metodo).toUpperCase()}\n${ruta}\n${hash}`)
    .digest('hex');
}

/** Mismo formato que el keyring de la plataforma; rechaza un archivo legible por grupo u otros. */
export function cargarKeyringInterno(ruta, io = {}) {
  const leer = io.leer ?? ((r) => fs.readFileSync(r, 'utf8'));
  const modo = io.modo ?? ((r) => fs.statSync(r).mode);
  if ((modo(ruta) & 0o077) !== 0) throw new Error(`el keyring interno ${ruta} es legible por grupo u otros`);
  let crudo;
  try { crudo = JSON.parse(leer(ruta)); } catch { throw new Error('el keyring interno no es JSON válido'); }
  const keys = crudo?.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('keyring interno sin keys');
  const claves = {};
  for (const [id, valor] of Object.entries(keys)) {
    if (!ID_CLAVE.test(id) || typeof valor !== 'string') throw new Error('clave interna inválida');
    const bytes = Buffer.from(valor, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== valor.trim()) throw new Error('clave interna inválida');
    claves[id] = bytes;
  }
  if (!Object.keys(claves).length) throw new Error('keyring interno vacío');
  return claves;
}

export function crearOrigenesInternos(cidrs) {
  const lista = new net.BlockList();
  for (const bruto of String(cidrs || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [red, prefijo] = bruto.split('/');
    const tipo = net.isIP(red || '');
    const bits = Number(prefijo);
    if (!tipo || !Number.isInteger(bits) || bits < 0 || bits > (tipo === 4 ? 32 : 128)) throw new Error(`red interna inválida: ${bruto}`);
    lista.addSubnet(red, bits, tipo === 4 ? 'ipv4' : 'ipv6');
  }
  return lista;
}

function origenPermitido(origenes, direccion) {
  if (!direccion) return false;
  const v4 = direccion.startsWith('::ffff:') ? direccion.slice(7) : direccion;
  const tipo = net.isIP(v4);
  return tipo !== 0 && origenes.check(v4, tipo === 4 ? 'ipv4' : 'ipv6');
}

const uno = (v) => (Array.isArray(v) ? undefined : v);

/**
 * Verifica origen, encabezados, ventana, firma y consume el nonce en SQLite, en ese orden. Devuelve
 * `{ ok: true }` o `{ ok: false, motivo }`; el motivo es para logs, nunca para la respuesta.
 */
export function verificarInterno({ db, claves, origenes, direccion, headers, metodo, ruta, cuerpo, ahoraMs = Date.now() }) {
  if (!origenPermitido(origenes, direccion)) return { ok: false, motivo: 'origen' };
  const keyId = uno(headers['x-fusion-key-id']);
  const timestamp = uno(headers['x-fusion-timestamp']);
  const nonce = uno(headers['x-fusion-nonce']);
  const firma = uno(headers['x-fusion-signature']);
  if (!keyId || !timestamp || !nonce || !firma || !/^\d{1,12}$/.test(timestamp) || !NONCE.test(nonce) || !FIRMA.test(firma)) {
    return { ok: false, motivo: 'encabezados' };
  }
  if (Math.abs(ahoraMs / 1000 - Number(timestamp)) > VENTANA_S) return { ok: false, motivo: 'ventana' };
  const clave = Object.hasOwn(claves, keyId) ? claves[keyId] : undefined;
  if (!clave) return { ok: false, motivo: 'clave' };
  const esperada = Buffer.from(firmarInterno(clave, timestamp, nonce, metodo, ruta, cuerpo), 'hex');
  const recibida = Buffer.from(firma, 'hex');
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return { ok: false, motivo: 'firma' };
  const ahora = new Date(ahoraMs);
  const consumido = db.transaction(() => {
    db.prepare('DELETE FROM internal_nonces WHERE seen_at < ?').run(new Date(ahoraMs - 2 * VENTANA_S * 1000).toISOString());
    return db.prepare('INSERT OR IGNORE INTO internal_nonces (key_id, nonce, seen_at) VALUES (?,?,?)').run(keyId, nonce, ahora.toISOString()).changes === 1;
  })();
  if (!consumido) return { ok: false, motivo: 'replay' };
  return { ok: true };
}
