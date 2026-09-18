/*
 * src/catalogo/ml.ts — un ítem de ML, tal como lo guardó el inbox, en intenciones de catálogo.
 *
 *   - Ítem con variaciones (modelo viejo) → un modelo `ml_clasico` con clave el id del ítem, una
 *     representación `contenedor` para el ítem y una `vendible` por variación.
 *   - Ítem sin variaciones → un modelo `ml_simple` y una `vendible`.
 *
 * Qué modelo y qué variante terminan usando de verdad lo decide el proyector con las decisiones del
 * matcher: un ítem vinculado a un SKU de Woo cuelga de la variante de ese SKU, no de un modelo propio.
 * Acá sólo se describe lo que ML dice.
 *
 * `user_product_id` NO agrupa una familia, contra lo que decía el diseño: identifica **lo que se vende**.
 * Cada variación del modelo viejo tiene el suyo, y dos publicaciones distintas pueden compartirlo (la misma
 * variante vendida en dos avisos). Verificado el 2026-09-18 sobre las 6.969 filas de la cache del legado.
 * Se guarda como pista por representación; decisión de José: si dos publicaciones con el mismo valor no
 * terminan en la misma variante, se abre un caso `user_product_divergente` y nunca se fusiona sola.
 */
import type { ResultadoProyeccion, SkuObservado } from './intenciones.ts';

type Registro = Record<string, unknown>;
const esRegistro = (x: unknown): x is Registro => typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');

/**
 * El SKU que ML muestra, del atributo SELLER_SKU o de `seller_custom_field` (el campo viejo). Nunca da
 * 'vacio': el multiget no trae SELLER_SKU en las variaciones, así que una ausencia no dice nada.
 */
export function skuMl(registro: Registro): SkuObservado {
  const atributos = Array.isArray(registro.attributes) ? registro.attributes.filter(esRegistro) : [];
  const atributo = atributos.find((a) => a.id === 'SELLER_SKU');
  const valor = (texto(atributo?.value_name) || texto(registro.seller_custom_field)).trim();
  if (!valor) return { estado: 'no_informado' };
  // En ML "canónico" sólo quiere decir que tiene la forma FB-{número}; a qué id de Woo apunta, y si ese
  // id existe, lo resuelve el proyector.
  return /^FB-[0-9]+$/.test(valor) ? { estado: 'canonico', valor } : { estado: 'otro', valor };
}

export function proyectarItemMl(payload: unknown): ResultadoProyeccion {
  if (!esRegistro(payload)) return { rechazo: 'payload de ML que no es un objeto' };
  const id = texto(payload.id);
  if (!/^[A-Z]{3}[0-9]+$/.test(id)) return { rechazo: 'ítem de ML sin id válido' };
  const estado = texto(payload.status) || null;
  const titulo = texto(payload.title);
  // Un ítem cerrado no vuelve: ML no reabre publicaciones cerradas, se crea otra con otro id.
  const archivar = estado === 'closed' ? 'cerrado en ML' : null;
  const upDelItem = texto(payload.user_product_id) || null;

  const variaciones = Array.isArray(payload.variations) ? payload.variations.filter(esRegistro) : [];
  if (variaciones.length === 0) {
    return {
      modelo: { origen: 'ml_simple', claveOrigen: id, titulo },
      representaciones: [{
        recurso: id, variacion: '', tipo: 'vendible', sku: skuMl(payload),
        userProductId: upDelItem, estadoRemoto: estado, idWoo: null,
      }],
      archivar,
    };
  }

  const ids = variaciones.map((v) => texto(v.id));
  if (ids.some((v) => !/^[0-9]+$/.test(v))) return { rechazo: 'ítem de ML con una variación sin id numérico' };
  // Una variación repetida en el mismo ítem violaría la clave natural. No debería pasar, pero si ML lo
  // manda, se rechaza entero en vez de proyectar la mitad.
  if (new Set(ids).size !== ids.length) return { rechazo: 'ítem de ML con variaciones repetidas' };
  return {
    modelo: { origen: 'ml_clasico', claveOrigen: id, titulo },
    representaciones: [
      {
        recurso: id, variacion: '', tipo: 'contenedor', sku: { estado: 'no_informado' },
        userProductId: null, estadoRemoto: estado, idWoo: null,
      },
      ...variaciones.map((v, i) => ({
        recurso: id, variacion: ids[i]!, tipo: 'vendible' as const, sku: skuMl(v),
        userProductId: texto(v.user_product_id) || null, estadoRemoto: estado, idWoo: null,
      })),
    ],
    archivar,
  };
}
