import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARBOL_FUSIONBIKES, FUERA_DEL_ARBOL, MAPEO_ML, MAPEO_WOO, SIN_EQUIVALENCIA_ML } from '../../src/catalogo/arbol-fusionbikes.ts';

const claves = new Set(ARBOL_FUSIONBIKES.map((n) => n.clave));
const porClave = new Map(ARBOL_FUSIONBIKES.map((n) => [n.clave, n]));
/** El mismo CHECK que tiene `catalog.taxonomy_nodes.clave` en la base. */
const CLAVE_VALIDA = /^[a-z0-9][a-z0-9_-]*$/;

describe('árbol propio de FusionBikes — invariantes de la definición', () => {
  it('E2-ARB-01 las claves son únicas y las acepta el CHECK de la base', () => {
    // Las claves eran por ruta (`bicicletas/trek`) y el CHECK no admite `/`: 59 de 65 nodos no se podían
    // escribir. El test viejo sólo miraba unicidad, así que pasaba verde con una definición que la base
    // rechazaba entera. Esta es la parte de la garantía que vivía en la base y el test no replicaba.
    expect(claves.size).toBe(ARBOL_FUSIONBIKES.length);
    expect(ARBOL_FUSIONBIKES.filter((n) => !CLAVE_VALIDA.test(n.clave)).map((n) => n.clave)).toEqual([]);
  });

  it('E2-ARB-02 todo padre declarado existe como nodo', () => {
    // Un padre sin fila hace que sus hijos desaparezcan de `leerArbol`, que baja desde las raíces, sin que
    // nada proteste. La base ya lo rechaza; esto lo agarra antes de tocar la base.
    expect(ARBOL_FUSIONBIKES.filter((n) => n.padre !== null && !claves.has(n.padre)).map((n) => n.clave))
      .toEqual([]);
  });

  it('E2-ARB-03 el árbol tiene exactamente dos niveles, medidos por la cadena de padres', () => {
    // Antes esto se medía contando las barras de la clave, que no es la estructura: un nodo con padre y clave
    // sin barra pasaba como raíz. Ahora se recorre la cadena real, que es lo que `leerArbol` va a recorrer.
    const profundidad = (clave: string): number => {
      let n = porClave.get(clave); let d = 0;
      while (n && d <= 8) { d++; n = n.padre === null ? undefined : porClave.get(n.padre); }
      return d;
    };
    const niveles = ARBOL_FUSIONBIKES.map((n) => profundidad(n.clave));
    expect(Math.max(...niveles)).toBe(2);
    expect(Math.min(...niveles)).toBe(1);
  });

  it('E2-ARB-04 cada categoría de Woo mapea a un nodo que existe', () => {
    const rotas = Object.entries(MAPEO_WOO).filter(([, clave]) => !claves.has(clave));
    expect(rotas).toEqual([]);
  });

  it('E2-ARB-05 ninguna categoría está mapeada y excluida a la vez', () => {
    // Las dos listas dicen cosas incompatibles sobre la misma categoría: si una cae en las dos, cuál gana
    // depende del orden en que el cargador las lea, y eso no es una decisión, es un azar. La versión anterior
    // de este test comparaba contra la lista equivocada y dejaba pasar tres casos reales (SERVICES, Taller,
    // FANTTIK), que estaban declarados «fuera» y a la vez mapeaban a un nodo por nombre.
    expect(Object.keys(MAPEO_WOO).filter((id) => id in FUERA_DEL_ARBOL)).toEqual([]);
  });

  it('E2-ARB-06 las 82 categorías de Woo están decididas, y cada una una sola vez', () => {
    // El número no es decorativo: son las 82 que la importación del 2026-09-20 dejó vigentes. Si mañana Woo
    // agrega una categoría, este test falla y alguien tiene que decidir dónde va, en vez de que el modelo
    // aparezca sin clasificar y nadie se entere.
    expect(Object.keys(MAPEO_WOO).length + Object.keys(FUERA_DEL_ARBOL).length).toBe(82);
  });

  it('E2-ARB-07 los nodos que ninguna categoría alimenta son los esperados', () => {
    // No es un error: son los nodos nuevos que José agregó y que Woo no tiene. Se fija la lista para que
    // agregar un nodo sin pensar de dónde salen sus productos sea una decisión visible y no un descuido.
    const alimentados = new Set(Object.values(MAPEO_WOO));
    expect(ARBOL_FUSIONBIKES.filter((n) => !alimentados.has(n.clave)).map((n) => n.clave).sort())
      // `direccion` NO está en la lista aunque Woo no tenga esa categoría: la alimentan MANUBRIOS y
      // STEMS/AVANCES, que absorbe. Un nodo nuevo puede quedar alimentado por sus hijas absorbidas.
      .toEqual(['buzos', 'cubre-vaina', 'cuernitos', 'porta-celular', 'rembrandt', 'santini',
        'sillas-traseras']);
  });

  it('E2-ARB-08 cada categoría de ML mapea a un nodo que existe, y sus ids son de ML', () => {
    // Mismo criterio que E2-ARB-04. El formato importa: un id numérico acá sería una categoría de Woo, y el
    // mapeo se aplicaría a la cuenta equivocada sin que la base lo pueda distinguir.
    expect(Object.entries(MAPEO_ML).filter(([, clave]) => !claves.has(clave))).toEqual([]);
    expect(Object.keys(MAPEO_ML).filter((id) => !/^MLA\d+$/.test(id))).toEqual([]);
    expect(Object.keys(MAPEO_ML).length).toBe(29);
  });

  it('E2-ARB-09 ninguna categoría de ML está también excluida o duplicada con Woo', () => {
    // Un objeto literal con una clave repetida se queda con la última en silencio: se cuenta el texto fuente.
    const fuente = readFileSync(new URL('../../src/catalogo/arbol-fusionbikes.ts', import.meta.url), 'utf8');
    const bloque = fuente.slice(fuente.indexOf('export const MAPEO_ML'), fuente.indexOf('export const SIN_EQUIVALENCIA_ML'));
    const ids = [...bloque.matchAll(/^\s+(MLA\d+):/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(Object.keys(MAPEO_ML).length);
    expect(Object.keys(MAPEO_ML).filter((id) => id in FUERA_DEL_ARBOL || id in MAPEO_WOO)).toEqual([]);
  });

  it('E2-ARB-10 ninguna categoría de ML está a la vez mapeada y sin equivalencia, y cada una lleva motivo', () => {
    const fuente = readFileSync(new URL('../../src/catalogo/arbol-fusionbikes.ts', import.meta.url), 'utf8');
    const bloque = fuente.slice(fuente.indexOf('export const SIN_EQUIVALENCIA_ML'));
    const ids = [...bloque.matchAll(/^\s+(MLA\d+):/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(Object.keys(SIN_EQUIVALENCIA_ML).length);
    expect(Object.keys(SIN_EQUIVALENCIA_ML).filter((id) => id in MAPEO_ML)).toEqual([]);
    expect(Object.keys(SIN_EQUIVALENCIA_ML).filter((id) => !/^MLA\d+$/.test(id))).toEqual([]);
    expect(Object.values(SIN_EQUIVALENCIA_ML).filter((m) => m.trim().length < 20)).toEqual([]);
    expect(Object.keys(SIN_EQUIVALENCIA_ML).sort()).toEqual(['MLA458068', 'MLA78908']);
  });
});
