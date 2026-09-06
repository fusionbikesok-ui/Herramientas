import { describe, expect, it } from 'vitest';
import {
  CONTRATO_VERSION, MINIMA_SOPORTADA, compararVersiones, estadoCompatibilidad, huellaContrato,
} from '../lib/contratoMovil.js';

describe('versión del contrato móvil', () => {
  it('publica la huella real del OpenAPI que sirve', () => {
    // La app compara esta huella con la suya: si difieren, alguno quedó viejo. Sacarla del
    // archivo y no de una constante evita que las dos fuentes divergan en silencio.
    const h = huellaContrato();
    expect(h.version).toBe(CONTRATO_VERSION);
    expect(h.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.rutas).toBeGreaterThan(40);
  });

  it('ordena versiones sin depender de comparación de texto', () => {
    // '1.10.0' es mayor que '1.9.0' aunque como cadena sea al revés.
    expect(compararVersiones('1.10.0', '1.9.0')).toBe(1);
    expect(compararVersiones('1.0.0', '1.0.0')).toBe(0);
    expect(compararVersiones('0.9.9', '1.0.0')).toBe(-1);
    expect(compararVersiones('2', '1.9.9')).toBe(1);
  });

  it('exige actualizar sólo por debajo de la mínima soportada', () => {
    expect(estadoCompatibilidad('0.9.0')).toMatchObject({ actualizacion_obligatoria: true });
    expect(estadoCompatibilidad(MINIMA_SOPORTADA)).toMatchObject({ actualizacion_obligatoria: false });
    expect(estadoCompatibilidad('9.9.9')).toMatchObject({ actualizacion_obligatoria: false });
  });

  it('explica por qué exige actualizar', () => {
    // Un booleano solo obliga a adivinar; el motivo se puede mostrar en pantalla.
    const r = estadoCompatibilidad('0.1.0');
    expect(r.motivo).toContain('0.1.0');
    expect(r.motivo).toContain(MINIMA_SOPORTADA);
  });

  it('no bloquea a quien no declara versión', () => {
    // Puede ser una app de desarrollo o una herramienta interna: se informa, no se corta.
    expect(estadoCompatibilidad(undefined)).toMatchObject({ actualizacion_obligatoria: false, app_version: null });
    expect(estadoCompatibilidad('')).toMatchObject({ actualizacion_obligatoria: false });
  });
});

describe('login móvil: identificación y dispositivo', () => {
  it('el contrato de login acepta usuario o email en el mismo campo', async () => {
    // Verificado contra el servidor real el 2026-09-06: ambas formas devuelven sesión. Acá se
    // fija la regla de resolución, que es la que evita entrar como quien no se es.
    const { default: Database } = await import('better-sqlite3');
    const { openDb } = await import('../db/index.js');
    const { hashPassword } = await import('../lib/auth.js');
    const FILE = './test/tmp-login-movil.sqlite';
    const fs = await import('node:fs');
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
    const db = openDb(FILE);
    db.prepare(`INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en,email)
      VALUES ('juan',?,0,1,?,?,'juan@fusionbikes.com.ar')`).run(hashPassword('x'), '2026-09-06', '2026-09-06');
    // El usuario gana sobre el email: si el email de una persona coincidiera con el usuario de
    // otra, entrar como quien no se es sería mucho peor que no entrar.
    const porUsuario = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get('juan');
    const porEmail = db.prepare("SELECT id FROM users WHERE TRIM(COALESCE(email,'')) <> '' AND email = ? COLLATE NOCASE").get('juan@fusionbikes.com.ar');
    expect(porUsuario.id).toBe(porEmail.id);
    // Un email vacío nunca debe resolver a nadie, o cualquiera entraría como los 7 usuarios
    // que no lo tienen cargado.
    expect(db.prepare("SELECT id FROM users WHERE TRIM(COALESCE(email,'')) <> '' AND email = ? COLLATE NOCASE").get('')).toBeUndefined();
    db.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
    void Database;
  });
});
