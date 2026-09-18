/*
 * src/catalogo/woo.ts — un producto de Woo, tal como lo guardó el inbox, en intenciones de catálogo.
 *
 * Reglas del §5.2 y §5.3 del diseño:
 *   - simple      → un modelo `woo_simple`, una representación `vendible`.
 *   - variable    → un modelo `woo_padre`, una representación `contenedor`. El padre no se vende.
 *   - variation   → cuelga del modelo del padre (`woo_padre`, clave = parent_id) con una `vendible` cuyo
 *                   recurso es el padre y cuya variación es su propio id. Así la clave natural coincide con
 *                   la forma en que el legado y ML se refieren a una variación.
 *   - grouped / external → rechazados con causa: no se venden en esta tienda.
 *
 * El SKU canónico es FB-{ID_WOO} del producto **que se vende** (el simple o la variación, nunca el padre).
 */
import { skuCanonicoDe, type ResultadoProyeccion, type SkuObservado } from './intenciones.ts';

type Registro = Record<string, unknown>;
const esRegistro = (x: unknown): x is Registro => typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');

/** Lo que Woo tiene cargado como SKU, comparado contra el canónico que le correspondería. */
export function skuWoo(observado: unknown, idWoo: string): SkuObservado {
  const valor = texto(observado).trim();
  if (!valor) return { estado: 'vacio' };
  return valor === skuCanonicoDe(idWoo) ? { estado: 'canonico', valor } : { estado: 'otro', valor };
}

export function proyectarProductoWoo(payload: unknown): ResultadoProyeccion {
  if (!esRegistro(payload)) return { rechazo: 'payload de Woo que no es un objeto' };
  const id = texto(payload.id);
  if (!/^[0-9]+$/.test(id)) return { rechazo: 'producto de Woo sin id numérico' };
  const tipo = texto(payload.type);
  const estado = texto(payload.status) || null;
  const titulo = texto(payload.name);
  // La papelera de Woo es la única baja que el producto mismo informa. Un borrado definitivo no llega
  // como payload: lo detecta la vuelta completa de ids, y el proyector archiva por esa vía.
  const archivar = estado === 'trash' ? 'en la papelera de Woo' : null;

  switch (tipo) {
    case 'simple':
      return {
        modelo: { origen: 'woo_simple', claveOrigen: id, titulo },
        representaciones: [{
          recurso: id, variacion: '', tipo: 'vendible', sku: skuWoo(payload.sku, id),
          userProductId: null, estadoRemoto: estado, idWoo: id,
        }],
        archivar,
      };
    case 'variable':
      return {
        modelo: { origen: 'woo_padre', claveOrigen: id, titulo },
        representaciones: [{
          // El padre no se vende: su SKU, si lo tiene, no identifica nada que se pueda comprar.
          recurso: id, variacion: '', tipo: 'contenedor', sku: { estado: 'no_informado' },
          userProductId: null, estadoRemoto: estado, idWoo: null,
        }],
        archivar,
      };
    case 'variation': {
      const padre = texto(payload.parent_id);
      // Sin padre no hay modelo al cual colgarla. Adivinarlo sería inventar una identidad.
      if (!/^[0-9]+$/.test(padre) || padre === '0') return { rechazo: 'variación de Woo sin parent_id' };
      return {
        // El título real del modelo lo trae el padre; el de la variación ("Cubierta - 29") sólo se usa
        // si el padre todavía no llegó, y el proyector no lo pisa sobre uno existente.
        modelo: { origen: 'woo_padre', claveOrigen: padre, titulo },
        representaciones: [{
          recurso: padre, variacion: id, tipo: 'vendible', sku: skuWoo(payload.sku, id),
          userProductId: null, estadoRemoto: estado, idWoo: id,
        }],
        archivar,
      };
    }
    case 'grouped':
    case 'external':
      return { rechazo: `producto de Woo de tipo ${tipo}: no se vende en esta tienda` };
    default:
      return { rechazo: `producto de Woo de tipo desconocido: ${tipo || 'sin tipo'}` };
  }
}
