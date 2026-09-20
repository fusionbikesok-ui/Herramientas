import { describe, expect, it } from 'vitest';
import { ABSORBIDAS, ARBOL_FUSIONBIKES, FUERA_DEL_ARBOL } from '../../src/catalogo/arbol-fusionbikes.ts';

const claves = new Set(ARBOL_FUSIONBIKES.map((n) => n.clave));

describe('árbol propio de FusionBikes — invariantes de la definición', () => {
  it('E2-ARB-01 las claves son únicas', () => {
    // Dos nodos se llaman `INFLADORES` (uno bajo INFLADORES Y HERRAMIENTAS, otro bajo FANTTIK). El esquema
    // exige clave única por empresa, así que la clave va por ruta y no por nombre: si alguien la cambia a
    // nombre normalizado, el segundo nodo pisa al primero y un rubro entero desaparece del menú.
    expect(claves.size).toBe(ARBOL_FUSIONBIKES.length);
  });

  it('E2-ARB-02 todo padre declarado existe como nodo', () => {
    // Un padre sin fila hace que sus hijos desaparezcan de `leerArbol`, que baja desde las raíces, sin que
    // nada proteste. La base ya lo rechaza; esto lo agarra antes de tocar la base.
    const huerfanos = ARBOL_FUSIONBIKES.filter((n) => n.padre !== null && !claves.has(n.padre));
    expect(huerfanos.map((n) => n.clave)).toEqual([]);
  });

  it('E2-ARB-03 el árbol tiene exactamente dos niveles', () => {
    // D7: el menú de la home despliega el nivel 1 y muestra el nivel 2; lo de abajo es faceta. Un tercer
    // nivel acá significa que algo que debía ser atributo volvió a entrar como nodo.
    const profundidades = new Set(ARBOL_FUSIONBIKES.map((n) => n.clave.split('/').length));
    expect([...profundidades].sort()).toEqual([1, 2]);
  });

  it('E2-ARB-04 cada categoría absorbida apunta a un nodo que existe', () => {
    const rotas = Object.entries(ABSORBIDAS).filter(([, clave]) => !claves.has(clave));
    expect(rotas).toEqual([]);
  });

  it('E2-ARB-05 ninguna categoría está absorbida y fuera del árbol a la vez', () => {
    // Las dos listas dicen cosas incompatibles sobre la misma categoría: si una cae en las dos, cuál gana
    // depende del orden en que el cargador las lea, y eso no es una decisión, es un azar.
    const ambas = Object.keys(ABSORBIDAS).filter((id) => id in FUERA_DEL_ARBOL);
    expect(ambas).toEqual([]);
  });
});
