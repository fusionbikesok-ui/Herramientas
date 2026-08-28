import { describe, it, expect, beforeEach } from 'vitest';
import { enviarNotificacion, tokenValido, tipoNotificacionValido } from '../lib/notificacionesPush.js';

describe('notificacionesPush', () => {
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
      const res = await enviarNotificacion('device-token-123', {
        titulo: 'Test Push',
        cuerpo: 'Contenido del push',
        deepLink: 'incidentes',
      });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
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
});
