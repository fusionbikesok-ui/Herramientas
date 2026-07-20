/**
 * Modelo canónico de un producto del catálogo WooCommerce (incluye variaciones).
 * Funciones puras: no tocan DB ni red. El formato persistido no cambia —
 * categorias_json sigue siendo ["NOMBRE",...] y atributos_json [{name,option}].
 */

/**
 * @typedef {Object} AtributoProducto
 * @property {string} name    Nombre del atributo (ej. "Color") — misma clave que persiste atributos_json
 * @property {string} option  Valor (ej. "Rojo")
 */
/**
 * @typedef {Object} Producto  Forma canónica de un producto/variación del catálogo WC.
 * @property {number} id_woo
 * @property {string} nombre           Para variaciones: "Padre — attr1 / attr2"
 * @property {string} sku              '' si no tiene
 * @property {string} tipo             'simple' | 'variable' | 'variation'
 * @property {?number} id_padre        Solo variaciones
 * @property {number} stock
 * @property {string[]} categorias     Nombres de categoría (heredadas del padre en variaciones)
 * @property {AtributoProducto[]} atributos
 * @property {?string} img
 * @property {?number} precio
 * @property {string} marca            Marca (taxonomía brands de WC); '' si no tiene
 */

/**
 * Parsea el campo categorias_json del catálogo (array JSON de nombres) de forma
 * tolerante: acepta ya-array, string JSON o null. Devuelve siempre un array.
 */
export function parseCategorias(categorias) {
  if (Array.isArray(categorias)) return categorias;
  if (typeof categorias === 'string' && categorias.trim()) {
    try {
      const arr = JSON.parse(categorias);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

// atributos_json usa el mismo formato tolerante que categorias_json.
function parseAtributos(atributos) {
  if (Array.isArray(atributos)) return atributos;
  if (typeof atributos === 'string' && atributos.trim()) {
    try {
      const arr = JSON.parse(atributos);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

/** Producto WC crudo (de /products) → Producto canónico. */
export function normalizarProductoWc(raw) {
  const categorias = Array.isArray(raw.categories) && raw.categories.length
    ? raw.categories.map(c => c.name)
    : [];
  const marca = Array.isArray(raw.brands) && raw.brands.length ? (raw.brands[0].name || '') : '';
  // products usan images[] array; variations usan image singular.
  const img = raw.image?.src || (Array.isArray(raw.images) && raw.images[0]?.src) || null;
  // Woo devuelve price/regular_price como string; se persiste para comparar contra el neto ML.
  const precio = raw.price != null && raw.price !== '' ? parseFloat(raw.price)
    : (raw.regular_price ? parseFloat(raw.regular_price) : null);
  return {
    id_woo: raw.id,
    nombre: raw.name,
    sku: raw.sku || '',
    tipo: raw.type,
    id_padre: raw.parent_id || null,
    stock: raw.stock_quantity ?? 0,
    categorias,
    atributos: [],
    img,
    precio: Number.isFinite(precio) ? precio : null,
    marca,
  };
}

/** Variación WC cruda (de /products/{id}/variations) + Producto padre → Producto canónico. */
export function normalizarVariacionWc(rawVar, padre) {
  const atributos = (rawVar.attributes || [])
    .map(a => ({ name: a.name || '', option: a.option || '' }))
    .filter(a => a.option);
  const attrsTexto = atributos.map(a => a.option).join(' / ');
  const nombre = attrsTexto ? `${padre.nombre} — ${attrsTexto}` : padre.nombre;

  const base = normalizarProductoWc({ ...rawVar, name: nombre, categories: undefined });
  return {
    ...base,
    id_padre: padre.id_woo,
    categorias: padre.categorias,
    atributos,
    marca: padre.marca,
  };
}

/** Producto canónico → params del upsert de catalogo_cache. */
export function filaCatalogo(producto, actualizadoEn) {
  return {
    id_woo: producto.id_woo,
    nombre: producto.nombre,
    sku: producto.sku || '',
    tipo: producto.tipo,
    id_padre: producto.id_padre || null,
    stock: producto.stock ?? 0,
    categorias_json: producto.categorias && producto.categorias.length ? JSON.stringify(producto.categorias) : null,
    img: producto.img || null,
    precio: producto.precio ?? null,
    atributos_json: producto.atributos && producto.atributos.length ? JSON.stringify(producto.atributos) : null,
    marca: producto.marca || null,
    actualizado_en: actualizadoEn,
  };
}

/** Fila de catalogo_cache → Producto canónico (parsea los JSON una sola vez). */
export function productoDesdeFilaCatalogo(row) {
  return {
    id_woo: row.id_woo,
    nombre: row.nombre,
    sku: row.sku || '',
    tipo: row.tipo,
    id_padre: row.id_padre ?? null,
    stock: row.stock,
    categorias: parseCategorias(row.categorias_json),
    atributos: parseAtributos(row.atributos_json),
    img: row.img ?? null,
    precio: row.precio ?? null,
    marca: row.marca ?? '',
  };
}
