import { describe, expect, it } from 'vitest';
import {
  validarBackupPublicacion,
  validarConfiguracionPublicacion,
  validarGatePublicacion,
  validarMigracionesPublicacion,
} from '../lib/gestionPedidosPublicacion.js';

describe('preflight de publicación de Gestión de pedidos', () => {
  it('exige secreto fuerte y acceso restringido', () => {
    const base = { DB_PATH: '/data/fusion.sqlite', SESSION_SECRET: 'x'.repeat(40), BASIC_AUTH_USER: 'admin', BASIC_AUTH_PASS: 'pass' };
    expect(validarConfiguracionPublicacion(base).ok).toBe(true);
    expect(validarConfiguracionPublicacion({ ...base, SESSION_SECRET: 'cambiar-por-uno-largo-y-aleatorio' }).ok).toBe(false);
    expect(validarConfiguracionPublicacion({ ...base, BASIC_AUTH_PASS: '' }).ok).toBe(false);
  });

  it('acepta sólo backup íntegro y migraciones completas', () => {
    expect(validarBackupPublicacion({ ok: true, integridad: 'ok', pedidos: 4 }).ok).toBe(true);
    expect(validarBackupPublicacion({ ok: true, integridad: 'not an ok', pedidos: 4 }).ok).toBe(false);
    expect(validarMigracionesPublicacion({ aplicadas: ['095', '096'], requeridas: ['095', '096'] }).ok).toBe(true);
    expect(validarMigracionesPublicacion({ aplicadas: ['095'], requeridas: ['095', '096'] })).toMatchObject({ ok: false, faltantes: ['096'] });
  });

  it('no permite cerrar el gate si falla un control', () => {
    const controles = { configuracion: { ok: true }, backup: { ok: true }, migraciones: { ok: true }, muestra: { ok: false }, permisos: { ok: true }, smoke: { ok: true } };
    expect(validarGatePublicacion(controles)).toMatchObject({ ok: false, faltantes: ['muestra'] });
    expect(validarGatePublicacion({ ...controles, muestra: { ok: true } }).ok).toBe(true);
  });
});
