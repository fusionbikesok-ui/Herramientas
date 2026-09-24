/*
 * test/identidad/cobertura-e3.test.ts — spec E3 §11: `test:e3` falla si falta un escenario obligatorio.
 * Cada escenario del corte 1 se marca en el título de un `it(` como «[esc:<clave>]». Los del corte 3 quedan
 * como `it.todo`: la ficha E3 no se acepta mientras quede uno.
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

describe('E3-COV-02 diferidos al corte 3 (relectura y canario)', () => {
  it.todo('relectura con cambio → intervention');
  it.todo('relectura con 5xx → parked');
  it.todo('401 aborta el canario');
});
