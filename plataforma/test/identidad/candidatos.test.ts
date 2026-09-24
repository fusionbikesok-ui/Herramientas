import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  candidatosDe, construirWCIndex, ctDesdeApi, extraerAtributosDeAttrsWC, extraerAtributosWC, type ItemMl,
} from '../../src/identidad/candidatos.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/muestra-30.json', import.meta.url), 'utf8'));
const indiceFixture = construirWCIndex(fixture.catalogo); // se arma una sola vez: el catálogo (5272 filas) es el mismo para las 30 entradas.

describe('paridad del matching ML → Woo (muestra-30.json, 30 pares reales)', () => {
  it.each(fixture.casos)('$clave conserva el TOP-3 legado', (...args: any[]) => {
    const caso = args[0];
    const ml: ItemMl = { ...caso.ml, _ct: ctDesdeApi(caso.ml.color, caso.ml.talle) };
    const actual = candidatosDe(ml, fixture.catalogo, indiceFixture);
    // La marca (enmienda 2026-09-24) se deriva de color_ok/talle_ok igual que antes, pero acá además
    // hay que reconstruir el valor normalizado de cada lado para armar 'coincide' vs 'equivalente':
    // mismo criterio que marcarAtributo() en candidatos.ts (los conjuntos ordenados y unidos con
    // espacio, comparados por igualdad textual exacta después de normalizar).
    const marca = (ok: boolean | null, valorMl: string, valorCandidato: string): string => {
      if (ok === null) return 'falta';
      if (ok === false) return 'difiere';
      return valorMl === valorCandidato ? 'coincide' : 'equivalente';
    };
    const esperado = caso.legado_top3.map((x: any, i: number) => {
      const valorMlColor = [...ml._ct!.colores].sort().join(' '), valorMlTalle = [...ml._ct!.talles].sort().join(' ');
      const wItem = indiceFixture.wcItems.find((w) => w.sku === x.wc_sku)!;
      const valorCandColor = [...wItem.colorToks].sort().join(' '), valorCandTalle = [...wItem.talleToks].sort().join(' ');
      return {
        variantId: x.wc_sku,
        rank: i + 1,
        puntaje: x.score,
        explicacion: {
          atributos: [
            { nombre: 'color', marca: marca(x.color_ok, valorMlColor, valorCandColor), valorMl: valorMlColor, valorCandidato: valorCandColor },
            { nombre: 'talle', marca: marca(x.talle_ok, valorMlTalle, valorCandTalle), valorMl: valorMlTalle, valorCandidato: valorCandTalle },
          ],
        },
      };
    });
    expect(actual, `entrada ${caso.clave}`).toEqual(esperado);
  });
});

// La base viva (2026-09-24) ya no tiene ninguna fila con atributos_json nulo (6973 publicaciones
// revisadas), así que la muestra real de 30 no puede cubrir ese caso — se prueba acá a nivel de
// unidad, contra el mismo construirWC portado, en vez de dejarlo sin cubrir.
describe('extraerAtributosDeAttrsWC: ausente/inválido cae al fallback por título (construirWC)', () => {
  it('atributos_json null: construirWC usa extraerAtributosWC(nombre), no revienta', () => {
    const item = { sku: 'FB-9001', nombre: 'Casco Bell Draft — Negro / M', tipo: 'variation', atributos_json: null };
    const { wcItems } = construirWCIndex([item]);
    const porTitulo = extraerAtributosWC(item.nombre);
    expect(wcItems[0]!.colorToks).toEqual(porTitulo.colores);
    expect(wcItems[0]!.talleToks).toEqual(porTitulo.talles);
    expect(extraerAtributosDeAttrsWC(item.atributos_json)).toBeNull();
  });

  it('atributos_json inválido (JSON roto): también cae al fallback por título, no revienta', () => {
    const item = { sku: 'FB-9002', nombre: 'Zapatillas Metha Tigra — Negro/Amarillo / 40', tipo: 'variation', atributos_json: '{roto' };
    const { wcItems } = construirWCIndex([item]);
    const porTitulo = extraerAtributosWC(item.nombre);
    expect(wcItems[0]!.colorToks).toEqual(porTitulo.colores);
    expect(wcItems[0]!.talleToks).toEqual(porTitulo.talles);
  });
});
