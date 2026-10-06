/**
 * Adaptador de MercadoLibre para la saga de UM1.
 *
 * `procesarPasoOperacionIdentidad` no habla con ML: pide un adaptador con cuatro operaciones
 * y verifica cada paso releyendo. Este módulo es ese adaptador.
 *
 * NO es el único que escribe identidad en ML, aunque una versión anterior de este comentario
 * lo afirmara. El worker de Guardia (`procesarOperacionesGuardia`, agendado cada 5 minutos en
 * server.js) escribe el mismo `SELLER_SKU` vía `escribirSkuEnMl`, y además puede desvincular y
 * pausar publicaciones. Son dos schedulers que pueden tocar la misma publicación: uno cada
 * minuto y otro cada cinco. La colisión no es teórica —hay 26 operaciones de Guardia en estado
 * `conflicto`, todas frenadas por su control de versión: «el responsable del caso cambió»,
 * «la versión del caso cambió», «caso ya no está pendiente».
 *
 * Retirar ese segundo escritor es parte de UM1.6, y no se puede hacer de una: el botón
 * «vincular» del Matcher (enlazado desde el home) alimenta esas operaciones por
 * `POST /api/guardia-ml/vincular-clave`. Primero hay que migrar ese endpoint a UM1; recién
 * después se puede desagendar el worker de Guardia.
 *
 * El cron legacy de subida de SKUs (`pushSkusPendientes`) ya NO corre: `matcherPush` ni
 * siquiera se importa en server.js. Los comentarios que dicen «corre cada 10 min» están
 * desactualizados.
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
        // La saga exige observación reciente y la lee de `observed_at` (ver confirmarLectura):
        // el nombre es parte del contrato del adaptador, no una preferencia de idioma.
        observed_at: new Date().toISOString(),
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
