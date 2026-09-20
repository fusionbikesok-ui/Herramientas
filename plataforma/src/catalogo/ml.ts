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
import { agregarAtributo, agregarImagen } from './atributos.ts';
import type {
  AtributoObservado, ComercialObservado, ImagenObservada, RepresentacionObservada, ResultadoProyeccion, SkuObservado,
} from './intenciones.ts';

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

const numero = (x: unknown): number | undefined => {
  const t = texto(x).trim();
  const n = t === '' ? NaN : Number(t);
  return Number.isFinite(n) ? n : undefined;
};

type Extras = Pick<RepresentacionObservada, 'atributos' | 'imagenes' | 'comercial' | 'crudo'>;

/**
 * Lo que ML dice de UNA representación: el ítem (simple o contenedor) o una variación. Los atributos de una
 * variación (`attribute_combinations` y `attributes`) van en la representación de ESA variación y no se
 * heredan del ítem: son los que distinguen una variante de otra (color, talle). Las fotos de una variación
 * son las del ítem cuyo id está en su `picture_ids`. La categoría es del ítem: sale como `categoria_canal` en
 * el ítem simple y en el contenedor. SELLER_SKU no es un atributo del producto sino el SKU, ya proyectado
 * aparte. NO se parte `value_name` por coma, y es una decisión informada: en ML la coma es ambigua. Los
 * separadores de valores van SIN espacio ("Mujer,Hombre", "Ciclismo,Skateboarding,Patinaje") igual que los
 * decimales ("CARBONO 27,2X400MM"), y dígito-coma-dígito es a la vez un decimal (27,2) y dos códigos
 * ("4550170444303,192790444307"): ninguna regla acierta siempre (en Woo el separador lleva espacio y el
 * decimal no, por eso allá sí se parte). Costo medido: ~722 valores multivalor quedan como un string opaco;
 * el crudo permite reproyectar cuando se sepa la regla. Limitación conocida, no un descuido. El GTIN puede
 * traer DOS códigos separados por coma: al ser evidencia y nunca autoridad se guarda entero, pero quien lo
 * lea no debe asumir que es un solo código. El GTIN sale como atributo (evidencia) y también en lo comercial; nunca casa identidades.
 */
function extraerExtrasMl(r: Registro, item: Registro, esVariacion: boolean, conCategoria: boolean): Extras {
  const atributos: AtributoObservado[] = [];
  const combinaciones = Array.isArray(r.attribute_combinations) ? r.attribute_combinations.filter(esRegistro) : [];
  const propios = Array.isArray(r.attributes) ? r.attributes.filter(esRegistro) : [];
  let gtin = '';
  for (const a of [...combinaciones, ...propios]) {
    const id = texto(a.id);
    if (id === 'SELLER_SKU') continue;
    const valor = texto(a.value_name).trim();
    agregarAtributo(atributos, texto(a.name) || id.toLowerCase(), [valor]);
    if (id === 'GTIN' && valor && !gtin) gtin = valor;
  }
  if (conCategoria) agregarAtributo(atributos, 'categoria_canal', [texto(item.category_id).trim()]);

  const fotos = Array.isArray(item.pictures) ? item.pictures.filter(esRegistro) : [];
  const ids = esVariacion && Array.isArray(r.picture_ids) ? r.picture_ids.map(texto) : null;
  const imagenes: ImagenObservada[] = [];
  fotos.forEach((f, i) => {
    if (ids && !ids.includes(texto(f.id))) return;
    agregarImagen(imagenes, texto(f.secure_url) || texto(f.url), i);
  });

  const comercial: ComercialObservado = {};
  const precio = numero(r.price);
  if (precio !== undefined) comercial.precio = precio;
  const moneda = texto(item.currency_id).trim();
  if (moneda) comercial.moneda = moneda;
  const stock = numero(r.available_quantity);
  if (stock !== undefined) comercial.stock = stock;
  if (gtin) comercial.gtin = gtin;

  return {
    ...(atributos.length ? { atributos } : {}),
    ...(imagenes.length ? { imagenes } : {}),
    ...(Object.keys(comercial).length ? { comercial } : {}),
    ...(combinaciones.length || propios.length || Object.keys(comercial).length || imagenes.length ? {
      crudo: {
        atributos: { attributes: r.attributes ?? null, attribute_combinations: r.attribute_combinations ?? null,
          category_id: conCategoria ? item.category_id ?? null : null },
        comercial: { price: r.price ?? null, currency_id: item.currency_id ?? null,
          available_quantity: r.available_quantity ?? null,
          pictures: esVariacion ? { picture_ids: r.picture_ids ?? null } : item.pictures ?? null },
      },
    } : {}),
  };
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
        ...extraerExtrasMl(payload, payload, false, true),
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
        // El contenedor lleva lo del ítem (fotos, categoría, atributos generales); el precio del ítem con
        // variaciones es referencial y cada variación trae el suyo.
        ...extraerExtrasMl({ attributes: payload.attributes, price: undefined }, payload, false, true),
      },
      ...variaciones.map((v, i) => ({
        recurso: id, variacion: ids[i]!, tipo: 'vendible' as const, sku: skuMl(v),
        userProductId: texto(v.user_product_id) || null, estadoRemoto: estado, idWoo: null,
        ...extraerExtrasMl(v, payload, true, false),
      })),
    ],
    archivar,
  };
}
