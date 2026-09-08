// test/apnsClient.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { enviarApns, HOSTS } from '../lib/apnsClient.js';
import { _resetCacheJwt } from '../lib/apnsJwt.js';

const { privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CFG = { keyId: 'ABCDE12345', teamId: '2GXNRP23GZ', bundleId: 'com.fusionbikes.operaciones', privateKey };

/**
 * Sesión HTTP/2 falsa: guarda lo que se le pidió y responde lo que le digamos.
 * El stream expone `.close()` (como el `ClientHttp2Stream` real) para que la rama de timeout
 * pueda ejercitarse sin lanzar un `TypeError` enmascarado por el `try/catch` de producción.
 * La sesión expone `.on()` real (no un no-op) para poder simular un error de conexión con
 * `sesionEmitter.emit('error', ...)`, que es justamente lo que el doble anterior no permitía
 * probar.
 */
function sesionFalsa({ status = 200, cuerpo = '' } = {}) {
  const registro = { host: null, cabeceras: null, cuerpo: null, cerrada: false, streamCerrado: false };
  const sesionEmitter = new EventEmitter();
  const factory = (host) => {
    registro.host = host;
    sesionEmitter.request = (cabeceras) => {
      registro.cabeceras = cabeceras;
      const stream = new EventEmitter();
      stream.setEncoding = () => {};
      stream.close = () => { registro.streamCerrado = true; };
      stream.end = (datos) => {
        registro.cuerpo = datos;
        setImmediate(() => {
          stream.emit('response', { ':status': status });
          if (cuerpo) stream.emit('data', cuerpo);
          stream.emit('end');
        });
      };
      return stream;
    };
    sesionEmitter.close = () => { registro.cerrada = true; };
    return sesionEmitter;
  };
  return { factory, registro, sesionEmitter };
}

/** Sesión que nunca responde: sirve para ejercitar la rama de `TIMEOUT_MS`. */
function sesionColgada() {
  const registro = { cerrada: false, streamCerrado: false };
  const factory = () => ({
    request() {
      const stream = new EventEmitter();
      stream.setEncoding = () => {};
      stream.close = () => { registro.streamCerrado = true; };
      stream.end = () => { /* Apple nunca contesta */ };
      return stream;
    },
    close() { registro.cerrada = true; },
    on() {},
  });
  return { factory, registro };
}

/** Sesión que emite 'error' a nivel de sesión (DNS/TLS/ECONNREFUSED/GOAWAY) antes de responder. */
function sesionConErrorDeConexion(mensaje) {
  const registro = { cerrada: false };
  const emitter = new EventEmitter();
  const factory = () => {
    emitter.request = () => {
      const stream = new EventEmitter();
      stream.setEncoding = () => {};
      stream.close = () => {};
      stream.end = () => {
        setImmediate(() => emitter.emit('error', new Error(mensaje)));
      };
      return stream;
    };
    emitter.close = () => { registro.cerrada = true; };
    return emitter;
  };
  return { factory, registro };
}

/** Sesión que lanza sincrónicamente al pedir el stream (carrera, o sesión ya destruida). */
function sesionQueTiraAlPedirStream(mensaje) {
  const registro = { cerrada: false };
  const factory = () => ({
    request() { throw new Error(mensaje); },
    close() { registro.cerrada = true; },
    on() {},
  });
  return { factory, registro };
}

describe('lib/apnsClient', () => {
  beforeEach(() => _resetCacheJwt());

  it('manda al host de produccion y arma las cabeceras que Apple exige', async () => {
    const { factory, registro } = sesionFalsa();
    const r = await enviarApns('tok-1', { aps: { alert: { title: 'Hola' } } },
      { entorno: 'production', cfg: CFG, sesionFactory: factory });

    expect(r.ok).toBe(true);
    expect(registro.host).toBe(HOSTS.production);
    expect(registro.cabeceras[':path']).toBe('/3/device/tok-1');
    expect(registro.cabeceras['apns-topic']).toBe('com.fusionbikes.operaciones');
    expect(registro.cabeceras['apns-push-type']).toBe('alert');
    expect(registro.cabeceras.authorization).toMatch(/^bearer /);
  });

  // La razón de ser de la columna `entorno`.
  it('manda al host de sandbox cuando el token es de sandbox', async () => {
    const { factory, registro } = sesionFalsa();
    await enviarApns('tok-2', { aps: {} }, { entorno: 'sandbox', cfg: CFG, sesionFactory: factory });
    expect(registro.host).toBe(HOSTS.sandbox);
  });

  it('devuelve la razon que da Apple ante un 410', async () => {
    const { factory } = sesionFalsa({ status: 410, cuerpo: JSON.stringify({ reason: 'Unregistered' }) });
    const r = await enviarApns('tok-3', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(r).toMatchObject({ ok: false, status: 410, reason: 'Unregistered' });
  });

  it('devuelve BadDeviceToken ante un 400, que es el sintoma de entorno equivocado', async () => {
    const { factory } = sesionFalsa({ status: 400, cuerpo: JSON.stringify({ reason: 'BadDeviceToken' }) });
    const r = await enviarApns('tok-4', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  it('un push silencioso declara apns-push-type background', async () => {
    const { factory, registro } = sesionFalsa();
    await enviarApns('tok-5', { aps: { 'content-available': 1 } },
      { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(registro.cabeceras['apns-push-type']).toBe('background');
    expect(registro.cabeceras['apns-priority']).toBe(5);
  });

  it('cierra la sesion aunque la respuesta sea un error', async () => {
    const { factory, registro } = sesionFalsa({ status: 400, cuerpo: '{"reason":"BadDeviceToken"}' });
    await enviarApns('tok-6', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(registro.cerrada).toBe(true);
  });

  // Hallazgo de la Tarea 2: nada verificaba que la firma del JWT tuviera el formato JOSE
  // r||s de 64 bytes. Si alguien borra `dsaEncoding: 'ieee-p1363'` de apnsJwt.js, esta es la
  // única red que lo atrapa antes de que Apple empiece a rechazar envios en produccion.
  it('la firma del JWT en la cabecera authorization tiene 64 bytes (formato JOSE r||s)', async () => {
    const { factory, registro } = sesionFalsa();
    await enviarApns('tok-7', { aps: { alert: { title: 'Hola' } } },
      { entorno: 'production', cfg: CFG, sesionFactory: factory });

    const jwt = registro.cabeceras.authorization.replace(/^bearer /, '');
    const [, , firmaB64url] = jwt.split('.');
    const firma = Buffer.from(firmaB64url, 'base64url');
    expect(firma.length).toBe(64);
  });

  // Hallazgo del revisor sobre la Tarea 3: nada ejercitaba TIMEOUT_MS, y el doble anterior
  // no tenía `.close()` en el stream, así que un timeout real habría lanzado un TypeError
  // que el propio try/catch de producción se traga en silencio.
  it('corta por timeout si Apple no responde y cierra el stream', async () => {
    vi.useFakeTimers();
    try {
      const { factory, registro } = sesionColgada();
      const promesa = enviarApns('tok-8', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await promesa;
      expect(r).toMatchObject({ ok: false, status: 0, reason: 'Timeout', reintentable: true });
      expect(registro.streamCerrado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Hallazgo crítico del revisor: `http2.connect` es asíncrono, y si la sesión emite 'error'
  // (DNS, TLS, ECONNREFUSED, GOAWAY de Apple) antes de que el stream responda, sin listener a
  // nivel de sesión Node trata eso como excepción no capturada y tira abajo el proceso.
  it('no revienta el proceso si la sesion emite error antes de responder, y resuelve reintentable', async () => {
    const { factory, registro } = sesionConErrorDeConexion('ECONNREFUSED');
    const r = await enviarApns('tok-9', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(r).toMatchObject({ ok: false, status: 0, reason: 'ErrorDeRed', reintentable: true });
    expect(registro.cerrada).toBe(true);
  });

  // Hallazgo del revisor: si `sesion.request()` lanza sincrónico (sesión ya cerrada/destruida
  // por una carrera, o un GOAWAY justo antes), la promesa debe resolver {ok:false,...} y no
  // rechazar, para no romper el contrato Promise<{ok, status, reason}> de `enviarApns`.
  it('resuelve {ok:false} en vez de rechazar si sesion.request() lanza sincronicamente', async () => {
    const { factory, registro } = sesionQueTiraAlPedirStream('Session closed');
    const r = await enviarApns('tok-10', { aps: {} }, { entorno: 'production', cfg: CFG, sesionFactory: factory });
    expect(r).toMatchObject({ ok: false, status: 0, reason: 'ErrorDeRed' });
    expect(registro.cerrada).toBe(true);
  });
});
