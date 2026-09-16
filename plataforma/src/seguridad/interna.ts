import { BlockList, isIP } from 'node:net';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { KeyringSobre } from './sobre.ts';

/**
 * Autenticación del plano de control interno (E1 T3): la usan la API de señales (C3) y el gateway
 * GET del legado (C5). Nginx no publica estas rutas; esto es la defensa adicional, no la principal.
 *
 * Firma v1 = HMAC-SHA256(clave, "v1\n{timestamp}\n{nonce}\n{método}\n{path}\n{sha256(cuerpo) hex}") en hex.
 * Encabezados: x-fusion-key-id, x-fusion-timestamp (segundos Unix), x-fusion-nonce, x-fusion-signature.
 * Se acepta cualquier clave del keyring, no sólo la activa: eso permite dos claves simultáneas durante
 * una rotación. El emisor firma siempre con `activeKeyId`.
 */
export const VENTANA_S = 300;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const FIRMA = /^[0-9a-f]{64}$/;

export type RechazoInterno = 'origen' | 'encabezados' | 'ventana' | 'clave' | 'firma';
export type Verificacion = { ok: true; keyId: string; nonce: string } | { ok: false; motivo: RechazoInterno };

export function cuerpoFirmado(timestamp: string, nonce: string, metodo: string, path: string, cuerpo: Buffer): string {
  return `v1\n${timestamp}\n${nonce}\n${metodo.toUpperCase()}\n${path}\n${createHash('sha256').update(cuerpo).digest('hex')}`;
}

export function firmar(clave: Buffer, timestamp: string, nonce: string, metodo: string, path: string, cuerpo: Buffer): string {
  return createHmac('sha256', clave).update(cuerpoFirmado(timestamp, nonce, metodo, path, cuerpo)).digest('hex');
}

/** Lista de redes internas permitidas, p. ej. "127.0.0.1/32,172.16.0.0/12". Vacía = nadie. */
export function crearOrigenes(cidrs: string): BlockList {
  const lista = new BlockList();
  for (const bruto of cidrs.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [red, prefijo] = bruto.split('/');
    const tipo = isIP(red ?? '');
    const bits = Number(prefijo);
    if (!tipo || !Number.isInteger(bits) || bits < 0 || bits > (tipo === 4 ? 32 : 128)) throw new Error(`red interna inválida: ${bruto}`);
    lista.addSubnet(red!, bits, tipo === 4 ? 'ipv4' : 'ipv6');
  }
  return lista;
}

export function origenPermitido(origenes: BlockList, direccion: string | undefined): boolean {
  if (!direccion) return false;
  const v4 = direccion.startsWith('::ffff:') ? direccion.slice(7) : direccion;
  const tipo = isIP(v4);
  return tipo !== 0 && origenes.check(v4, tipo === 4 ? 'ipv4' : 'ipv6');
}

const uno = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/** Verifica origen, encabezados, ventana y firma. No consulta nonces: eso es atómico con la escritura. */
export function verificarInterna(opciones: {
  keyring: KeyringSobre; origenes: BlockList; direccion: string | undefined;
  headers: Record<string, string | string[] | undefined>; metodo: string; path: string; cuerpo: Buffer; ahoraMs: number;
}): Verificacion {
  if (!origenPermitido(opciones.origenes, opciones.direccion)) return { ok: false, motivo: 'origen' };
  const keyId = uno(opciones.headers['x-fusion-key-id']);
  const timestamp = uno(opciones.headers['x-fusion-timestamp']);
  const nonce = uno(opciones.headers['x-fusion-nonce']);
  const firma = uno(opciones.headers['x-fusion-signature']);
  if (!keyId || !timestamp || !nonce || !firma || !/^\d{1,12}$/.test(timestamp) || !NONCE.test(nonce) || !FIRMA.test(firma)) {
    return { ok: false, motivo: 'encabezados' };
  }
  if (Math.abs(opciones.ahoraMs / 1000 - Number(timestamp)) > VENTANA_S) return { ok: false, motivo: 'ventana' };
  const clave = Object.hasOwn(opciones.keyring.keys, keyId) ? opciones.keyring.keys[keyId] : undefined;
  if (!clave) return { ok: false, motivo: 'clave' };
  const esperada = Buffer.from(firmar(clave, timestamp, nonce, opciones.metodo, opciones.path, opciones.cuerpo), 'hex');
  const recibida = Buffer.from(firma, 'hex');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return { ok: false, motivo: 'firma' };
  return { ok: true, keyId, nonce };
}
