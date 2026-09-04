/**
 * Adaptador de MercadoLibre para la saga de UM1.
 *
 * `procesarPasoOperacionIdentidad` no habla con ML: pide un adaptador con cuatro operaciones
 * y verifica cada paso releyendo. Este módulo es ese adaptador y es el ÚNICO lugar del
 * programa que escribe identidad o stock en publicaciones de ML.
 *
 * Reglas que respeta, todas heredadas de código ya probado en este repo:
 *  - stock por endpoint puntual de variación cuando la clave tiene variación, nunca
 *    `PUT /items/{id}` con `variations: [...]`, que revalida la publicación entera y puede
 *    rechazar el cambio por reglas ajenas al stock (ver buildMlStockUpdate en routes/sync.js);
 *  - `SELLER_SKU` se escribe y se limpia como atributo (`value_name`), igual que matcherPush;
 *  - fail-closed: cualquier respuesta que no sea 200 se propaga como error y la saga NO avanza.
 */
import { mlFetch } from './mlClient.js';
import { partirClaveMl } from './mlUtil.js';

function rutas(clave) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId) return null;
  return {
    itemId,
    variationId,
    // El stock de una variación se toca en su endpoint propio.
    stock: variationId ? `/items/${itemId}/variations/${variationId}` : `/items/${itemId}`,
    // El SELLER_SKU vive como atributo, en el item o en la variación.
    sku: variationId ? `/items/${itemId}/variations/${variationId}` : `/items/${itemId}`,
    lectura: variationId
      ? `/items/${itemId}/variations/${variationId}?attributes=id,available_quantity,attributes`
      : `/items/${itemId}?attributes=id,available_quantity,status,attributes`,
  };
}

function skuDeAtributos(attrs) {
  if (!Array.isArray(attrs)) return '';
  const a = attrs.find((x) => x?.id === 'SELLER_SKU');
  return a ? String(a.value_name ?? '').trim() : '';
}

/** Crea el adaptador. `cfg` es la config ML del servidor (clientId/clientSecret/userId). */
export function adaptadorMlIdentidad(db, cfg) {
  const escribir = async (path, body) => {
    const r = await mlFetch(db, cfg, 'put', path, body, { manual: true });
    if (r.status !== 200) {
      const detalle = r.data?.message || r.data?.error || `HTTP ${r.status}`;
      throw new Error(`ML rechazó la escritura (${path}): ${detalle}`);
    }
    return { ok: true, status: r.status };
  };

  return {
    /** Relectura para verificar un paso. Devuelve lo que la saga compara: SKU y stock. */
    async read(clave) {
      const r = rutas(clave);
      if (!r) throw new Error(`clave ML inválida: ${clave}`);
      const resp = await mlFetch(db, cfg, 'get', r.lectura, null, { manual: true });
      if (resp.status !== 200) throw new Error(`ML no respondió la lectura de ${clave}: HTTP ${resp.status}`);
      const d = resp.data || {};
      return {
        clave,
        seller_sku: skuDeAtributos(d.attributes),
        stock: d.available_quantity ?? null,
        // La saga exige observación reciente: se sella con la hora de esta misma lectura.
        observado_en: new Date().toISOString(),
        confiable: true,
      };
    },

    async setStock(clave, cantidad) {
      const r = rutas(clave);
      if (!r) throw new Error(`clave ML inválida: ${clave}`);
      return escribir(r.stock, { available_quantity: Number(cantidad) });
    },

    async clearSku(clave) {
      const r = rutas(clave);
      if (!r) throw new Error(`clave ML inválida: ${clave}`);
      return escribir(r.sku, { attributes: [{ id: 'SELLER_SKU', value_name: null }] });
    },

    async writeSku(clave, sku) {
      const r = rutas(clave);
      if (!r) throw new Error(`clave ML inválida: ${clave}`);
      const valor = String(sku || '').trim();
      if (!valor) throw new Error('SKU objetivo vacío: no se escribe');
      return escribir(r.sku, { attributes: [{ id: 'SELLER_SKU', value_name: valor }] });
    },
  };
}
