/**
 * Paso 1 del plan ahorro-llamadas-ml: bajar el cron de cancelaciones de cada 15 min a
 * cada 2 horas, manteniendo el escalonado por minuto (server.js:175-178) para no realinear
 * ráfagas de crons de ML en el mismo minuto (incidente 429 del 2026-08-04).
 *
 * No se importa server.js (levanta un servidor real): se lee el archivo como texto y se
 * verifica la expresión de cron, igual que sugiere el criterio de aceptación del plan.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const lineas = serverSrc.split('\n');

/** Expresión de cron de la línea `cron.schedule('expr', ...)` inmediatamente anterior a `marcador`. */
function expresionCronAntesDe(marcador) {
  const idx = lineas.findIndex(l => l.includes(marcador));
  for (let i = idx; i >= 0; i--) {
    const m = lineas[i].match(/cron\.schedule\('([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

describe('server.js — cron de cancelaciones ML', () => {
  it('procesarCancelacionesMl corre cada 2 horas (no cada 15 min)', () => {
    const expr = expresionCronAntesDe('procesarCancelacionesMl(app._db');
    expect(expr).not.toBeNull();
    // Debe ser una expresión de horas con paso 2 (ej. '6 1-23/2 * * *'), no minutos con paso 15.
    expect(expr).toMatch(/^\d+ \d+-\d+\/2 \* \* \*$/);
  });

  it('el minuto de arranque del cron de cancelaciones no coincide con el de otros crons de ML (escalonado)', () => {
    const minutoCancelaciones = expresionCronAntesDe('procesarCancelacionesMl(app._db').split(' ')[0];
    // Compara contra los minutos iniciales de los demás crons de ML (sync ML→WC, WC→ML,
    // reintentos, reactivación automática): ninguno debe compartir el mismo minuto de arranque.
    const todosLosCronsMl = [...serverSrc.matchAll(/cron\.schedule\('([^']+)'[^\n]*\/\/\s*ML\b/g)].map(x => x[1].split(' ')[0]);
    const repetidos = todosLosCronsMl.filter(min => min === minutoCancelaciones);
    expect(repetidos).toHaveLength(1); // solo se encuentra a sí mismo
  });
});
