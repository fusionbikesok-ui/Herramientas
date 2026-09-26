/*
 * test/identidad/cobertura-e3.test.ts — spec E3 §11: `test:e3` falla si falta un escenario obligatorio.
 * Cada escenario del corte 1 se marca en el título de un `it(` como «[esc:<clave>]». Los del corte 3 (C3) se exigen igual.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const fuentes = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'cobertura-e3.test.ts')
  .map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');

const C1 = [
  'auto-sku-unico', 'empate', 'gtin', 'las-17-bloqueadas', '409-dos-operadores', 'legado-posterior-conflict',
  'idempotencia', 'desorden-y-duplicados', 'flag-apagado', 'calibracion',
];

describe('E3-COV-01 escenarios obligatorios del corte 1', () => {
  it.each(C1)('existe un it con [esc:%s]', (clave) => {
    expect(fuentes, `falta el escenario ${clave}`).toMatch(new RegExp(`\\bit\\(\\s*['"\`]\\[esc:${clave}\\]`));
  });
});

const C3 = ['relectura-cambio', 'relectura-5xx', 'canario-401'];

describe('E3-COV-02 escenarios obligatorios del corte 3 (relectura y canario)', () => {
  it.each(C3)('existe un it con [esc:%s]', (clave) => {
    expect(fuentes, `falta el escenario ${clave}`).toMatch(new RegExp(`\\bit\\(\\s*['"\`]\\[esc:${clave}\\]`));
  });
});
