import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { enviarNotificacion, tokenValido, tipoNotificacionValido, validarConfiguracionPush } from '../lib/notificacionesPush.js';

describe('notificacionesPush', () => {
  const originalProvider = process.env.PUSH_PROVIDER;
  const originalTimeout = process.env.PUSH_HTTP_TIMEOUT_MS;
  const originalFirebase = {
    json: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    project: process.env.FIREBASE_PROJECT_ID,
    email: process.env.FIREBASE_CLIENT_EMAIL,
    key: process.env.FIREBASE_PRIVATE_KEY,
  };
  afterEach(() => {
    if (originalProvider == null) delete process.env.PUSH_PROVIDER;
    else process.env.PUSH_PROVIDER = originalProvider;
    if (originalTimeout == null) delete process.env.PUSH_HTTP_TIMEOUT_MS;
    else process.env.PUSH_HTTP_TIMEOUT_MS = originalTimeout;
    for (const [name, value] of Object.entries({
      FIREBASE_SERVICE_ACCOUNT_JSON: originalFirebase.json,
      FIREBASE_PROJECT_ID: originalFirebase.project,
      FIREBASE_CLIENT_EMAIL: originalFirebase.email,
      FIREBASE_PRIVATE_KEY: originalFirebase.key,
    })) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  describe('enviarNotificacion', () => {
    it('debería fallar con token vacío', async () => {
      const res = await enviarNotificacion('', { titulo: 'Test' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/vacío/);
    });

    it('debería fallar con payload vacío', async () => {
      const res = await enviarNotificacion('valid-token', null);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/vacío/);
    });

    it('debería tener éxito con provider mock', async () => {
      delete process.env.PUSH_PROVIDER;
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const res = await enviarNotificacion('device-token-123', {
        titulo: 'Test Push',
        cuerpo: 'Contenido del push',
        deep_link: 'incidentes',
      });
      expect(res.ok).toBe(true);
      expect(res.simulated).toBe(true);
      expect(res.provider).toBe('mock');
      expect(res.error).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it('FCM declarado sin credenciales falla explícitamente, no simula ni queda como TODO', async () => {
      process.env.PUSH_PROVIDER = 'fcm';
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.FIREBASE_PROJECT_ID;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;
      const res = await enviarNotificacion('device-token-123', { titulo: 'Test' });
      expect(res).toEqual({ ok: false, error: 'FCM no configurado' });
      expect(res.simulated).toBeUndefined();
    });

    it('OAuth aborta al vencer el timeout y devuelve un error reintentable', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.PUSH_PROVIDER = 'fcm';
      process.env.PUSH_HTTP_TIMEOUT_MS = '10';
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        project_id: 'fusion-oauth-timeout',
        client_email: 'oauth-timeout@push.example.test',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      });
      const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await enviarNotificacion('device-token-123', { titulo: 'Test' });

      expect(res).toMatchObject({ ok: false, reintentable: true });
      expect(res.error).toMatch(/OAuth FCM agotó el tiempo de espera/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it.each([
      [400, false, 'credenciales'],
      [403, false, 'permisos'],
      [500, true, 'servidor'],
    ])('OAuth HTTP %s clasifica el error de forma %s', async (status, reintentable) => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.PUSH_PROVIDER = 'fcm';
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        project_id: `fusion-oauth-${status}`,
        client_email: `oauth-${status}@push.example.test`,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await enviarNotificacion('device-token-123', { titulo: 'Test' });

      expect(res).toMatchObject({ ok: false, reintentable });
      expect(res.error).toContain(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('FCM aborta al vencer el timeout y devuelve un error reintentable', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.PUSH_PROVIDER = 'fcm';
      process.env.PUSH_HTTP_TIMEOUT_MS = '10';
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        project_id: 'fusion-fcm-timeout',
        client_email: 'fcm-timeout@push.example.test',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'oauth-timeout-test', expires_in: 3600 }) })
        .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await enviarNotificacion('device-token-123', { titulo: 'Test' });

      expect(res).toMatchObject({ ok: false, reintentable: true });
      expect(res.error).toMatch(/FCM agotó el tiempo de espera/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    });

    it('FCM usa deep_link, el mismo nombre del contrato OpenAPI', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.PUSH_PROVIDER = 'fcm';
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        project_id: 'fusion-test', client_email: 'push@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'oauth-token', expires_in: 3600 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'messages/1' }) });
      vi.stubGlobal('fetch', fetchMock);
      const res = await enviarNotificacion('device-token-123', {
        titulo: 'Test', cuerpo: 'Contenido', deep_link: 'incidentes',
      });
      expect(res.ok).toBe(true);
      const fcmBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(fcmBody.message.data.deep_link).toBe('incidentes');
      expect(fcmBody.message.data.deepLink).toBeUndefined();
    });

    it('nunca debería lanzar excepciones (fail-open)', async () => {
      // Envío válido debería siempre devolver un objeto, nunca throw
      const res1 = await enviarNotificacion('token', { titulo: 'Test' });
      expect(typeof res1).toBe('object');
      expect(res1).toHaveProperty('ok');

      // Envío inválido también debería devolver un objeto
      const res2 = await enviarNotificacion(null, null);
      expect(typeof res2).toBe('object');
      expect(res2).toHaveProperty('ok');
      expect(res2.ok).toBe(false);
    });
  });

  it('rechaza mock en producción y no permite fallback silencioso', () => {
    expect(() => validarConfiguracionPush({ NODE_ENV: 'production', PUSH_PROVIDER: 'mock' }))
      .toThrow(/PUSH_PROVIDER=fcm/);
    expect(validarConfiguracionPush({ NODE_ENV: 'development' })).toBe('mock');
  });

  it('exige credenciales FCM completas y con formato válido en producción', () => {
    expect(() => validarConfiguracionPush({
      NODE_ENV: 'production', PUSH_PROVIDER: 'fcm', FIREBASE_PROJECT_ID: 'fusion-test',
    })).toThrow(/projectId, clientEmail y private key/);
    expect(() => validarConfiguracionPush({
      NODE_ENV: 'production', PUSH_PROVIDER: 'fcm',
      FIREBASE_PROJECT_ID: 'fusion-test', FIREBASE_CLIENT_EMAIL: 'no-es-email',
      FIREBASE_PRIVATE_KEY: 'not-a-pem',
    })).toThrow(/projectId, clientEmail y private key/);

    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(validarConfiguracionPush({
      NODE_ENV: 'production', PUSH_PROVIDER: 'fcm',
      FIREBASE_PROJECT_ID: 'fusion-test', FIREBASE_CLIENT_EMAIL: 'push@example.test',
      FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    })).toBe('fcm');
  });

  describe('tokenValido', () => {
    it('debería aceptar tokens no vacíos', () => {
      expect(tokenValido('device-token-123')).toBe(true);
      expect(tokenValido('xyz')).toBe(true);
    });

    it('debería rechazar tokens vacíos', () => {
      expect(tokenValido('')).toBe(false);
      expect(tokenValido('   ')).toBe(false);
    });

    it('debería rechazar tipos no-string', () => {
      expect(tokenValido(null)).toBe(false);
      expect(tokenValido(undefined)).toBe(false);
      expect(tokenValido(123)).toBe(false);
    });
  });

  describe('tipoNotificacionValido', () => {
    it('debería aceptar tipos válidos', () => {
      expect(tipoNotificacionValido('nuevo')).toBe(true);
      expect(tipoNotificacionValido('reaviso')).toBe(true);
      expect(tipoNotificacionValido('resuelto')).toBe(true);
    });

    it('debería rechazar tipos inválidos', () => {
      expect(tipoNotificacionValido('otro')).toBe(false);
      expect(tipoNotificacionValido('')).toBe(false);
      expect(tipoNotificacionValido(null)).toBe(false);
    });
  });

  describe('proveedor apns', () => {
    const ENV_BASE = {
      PUSH_PROVIDER: 'apns',
      APNS_KEY_ID: 'ABCDE12345',
      APNS_TEAM_ID: '2GXNRP23GZ',
      APNS_BUNDLE_ID: 'com.fusionbikes.operaciones',
      APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    };

    it('acepta apns como proveedor valido', () => {
      expect(validarConfiguracionPush({ ...ENV_BASE })).toBe('apns');
    });

    // En produccion mock devolvia ok:true sin enviar nada, y por eso el backend se veia sano
    // mientras no llegaba ninguna push. Esa puerta queda cerrada para apns tambien.
    it('en produccion rechaza mock', () => {
      expect(() => validarConfiguracionPush({ NODE_ENV: 'production', PUSH_PROVIDER: 'mock' }))
        .toThrow(/mock no está permitido/);
    });

    it('en produccion exige la configuracion completa de apns', () => {
      expect(() => validarConfiguracionPush({ NODE_ENV: 'production', PUSH_PROVIDER: 'apns' }))
        .toThrow(/APNS/i);
    });
  });
});
