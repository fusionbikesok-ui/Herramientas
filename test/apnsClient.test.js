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

/** Sesión HTTP/2 falsa: guarda lo que se le pidió y responde lo que le digamos. */
function sesionFalsa({ status = 200, cuerpo = '' } = {}) {
  const registro = { host: null, cabeceras: null, cuerpo: null, cerrada: false };
  const factory = (host) => {
    registro.host = host;
    return {
      request(cabeceras) {
        registro.cabeceras = cabeceras;
        const stream = new EventEmitter();
        stream.setEncoding = () => {};
        stream.end = (datos) => {
          registro.cuerpo = datos;
          setImmediate(() => {
            stream.emit('response', { ':status': status });
            if (cuerpo) stream.emit('data', cuerpo);
            stream.emit('end');
          });
        };
        return stream;
      },
      close() { registro.cerrada = true; },
      on() {},
    };
  };
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
});
