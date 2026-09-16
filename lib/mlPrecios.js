/**
 * Cálculo del "neto que recibe el vendedor" en MercadoLibre y su veredicto contra
 * el precio web, para la herramienta de auditoría de precios y el bloqueo al reactivar.
 *
 *   neto = precio_ML − comisión (sale_fee) − costo de envío a cargo del vendedor
 *
 * - comisión: GET /sites/MLA/listing_prices?price=&category_id=&listing_type_id= → sale_fee_amount
 * - envío del vendedor (solo si envío gratis): GET /users/{userId}/shipping_options/free?item_id=
 *     → coverage.all_country.list_cost (ya con el descuento obligatorio aplicado)
 */

import { mlFetch } from './mlClient.js';

const SITE = 'MLA';

// Vigencia de la caché persistente de comisión/envío (ml_precios_cache, migrations/004_*.sql):
// decisión del usuario 2026-08-05, 7 días. Vencida, se re-consulta a ML y se reescribe.
const TTL_CACHE_PERSISTENTE_MS = 7 * 24 * 60 * 60 * 1000;

function ahoraIso() {
  return new Date().toISOString();
}

/** Lee la caché persistente. Devuelve undefined si no existe o si venció (nunca null: null lo usan los callers para "no hay dato"). */
function leerCachePersistente(db, clave) {
  const row = db.prepare('SELECT valor, actualizado_en FROM ml_precios_cache WHERE clave = ?').get(clave);
  if (!row) return undefined;
  const edadMs = Date.now() - new Date(row.actualizado_en).getTime();
  if (!(edadMs >= 0) || edadMs > TTL_CACHE_PERSISTENTE_MS) return undefined;
  return row.valor;
}

/** Escribe/actualiza la caché persistente. Solo se llama con valores numéricos válidos (nunca ante error de ML: no envenenar la caché). */
function guardarCachePersistente(db, clave, valor) {
  db.prepare(`
    INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `).run(clave, valor, ahoraIso());
}

/**
 * Borra la caché persistente de comisión/envío. Sin argumentos, borra todo; con `prefijo`
 * ('fee:' o 'envio:'), solo esas filas. Para cuando ML cambia comisiones antes del vencimiento.
 *
 * Sin consumidor en el código HTTP (hallazgo del revisor, MENOR 3): es a propósito, pensada
 * para uso manual desde la consola de Node del servidor (import + llamada directa) o desde un
 * script de mantenimiento puntual, no para exponerse como endpoint — invalidar la caché entera
 * dispara de nuevo el volumen de llamadas a ML que este cambio busca evitar.
 */
export function invalidarCachePreciosMl(db, prefijo = null) {
  if (prefijo) {
    db.prepare('DELETE FROM ml_precios_cache WHERE clave LIKE ?').run(`${prefijo}%`);
  } else {
    db.prepare('DELETE FROM ml_precios_cache').run();
  }
}

/**
 * Comisión de venta para un precio/categoría/listing. Devuelve número o null si ML no responde.
 * opts.saltarCachePersistente: true para revalidar SIEMPRE en vivo (paso 5, justo antes del PUT
 * de activación) aunque haya una fila fresca en sqlite — el Map en memoria (`cache`) sigue
 * activo dentro de la misma corrida.
 */
export async function saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, cache = null, opts = {}) {
  if (!(price > 0) || !categoryId || !listingTypeId) return null;
  const key = `${categoryId}|${listingTypeId}|${price}`;
  if (cache && cache.has(key)) return cache.get(key);

  const claveCache = `fee:${price}:${categoryId}:${listingTypeId}`;
  if (!opts.saltarCachePersistente) {
    const persistido = leerCachePersistente(db, claveCache);
    if (persistido !== undefined) {
      if (cache) cache.set(key, persistido);
      return persistido;
    }
  }

  opts.onRemote?.('fee');
  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/sites/${SITE}/listing_prices?price=${price}&category_id=${encodeURIComponent(categoryId)}&listing_type_id=${encodeURIComponent(listingTypeId)}`,
    null, opts
  );
  const fee = resp.status === 200 && typeof resp.data?.sale_fee_amount === 'number'
    ? resp.data.sale_fee_amount
    : null;
  if (cache) cache.set(key, fee);
  // Solo se persiste un valor numérico válido (status 200 con sale_fee_amount numérico) —
  // nunca un error, para no envenenar la caché con un margen falso.
  if (fee != null) guardarCachePersistente(db, claveCache, fee);
  return fee;
}

/**
 * Costo de envío a cargo del vendedor (0 si no hay envío gratis o si ML no da el dato).
 * La clave de caché incluye el PRECIO (el costo depende de él, no solo del item_id) — ver
 * plan ahorro-llamadas-ml, paso 2: indexar solo por item_id sería un bug si se persiste así.
 *
 * `item_price` en la consulta (2026-09-11). Antes la clave de caché incluía el precio pero la
 * llamada NO lo mandaba: ML respondía siempre el costo del precio publicado hoy, así que todas
 * las entradas de un mismo item guardaban el mismo número bajo claves distintas. Para la
 * auditoría daba igual —se pregunta por el precio vigente—, pero rompe el cálculo del precio
 * objetivo, que necesita saber cuánto costaría el envío a un precio que todavía no existe. El
 * endpoint acepta `item_price` y `listing_type_id`; mandarlos es lo que hace que la caché por
 * precio signifique algo.
 */
export async function costoEnvioMl(db, mlCfg, itemId, price, freeShipping, cache = null, opts = {}, listingTypeId = null) {
  if (!freeShipping) return 0;
  // Clave del Map en memoria: incluye el PRECIO, igual que la clave persistida (ver arriba).
  // Antes estaba indexada solo por itemId: `caches` se crea una vez por item y el loop de
  // netoMl recorre variaciones con precio distinto (vv.price), así que la segunda variación
  // recibía en memoria el costo de envío calculado para la primera (hallazgo del revisor,
  // MENOR 1). El costo de envío SÍ depende del precio (ver comentario del JSDoc).
  const key = `${itemId}|${price}`;
  if (cache && cache.has(key)) return cache.get(key);

  const claveCache = `envio:${itemId}:${price}`;
  if (!opts.saltarCachePersistente) {
    const persistido = leerCachePersistente(db, claveCache);
    if (persistido !== undefined) {
      if (cache) cache.set(key, persistido);
      return persistido;
    }
  }

  const params = [
    `item_id=${encodeURIComponent(itemId)}`,
    'verbose=true',
  ];
  if (price > 0) params.push(`item_price=${price}`);
  if (listingTypeId) params.push(`listing_type_id=${encodeURIComponent(listingTypeId)}`);
  opts.onRemote?.('envio');
  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/users/${mlCfg.userId}/shipping_options/free?${params.join('&')}`,
    null, opts
  );
  const confirmado = resp.status === 200 && resp.data?.coverage?.all_country?.list_cost != null;
  // opts.estricto (auditoría como proyección local): sin confirmación de ML devuelve null en vez de
  // 0, para no presentar como neto real uno calculado con un envío que nadie confirmó. Los callers
  // históricos (reactivación, objetivo) conservan el 0 de siempre.
  if (opts.estricto && !confirmado) {
    return null;
  }
  const cost = resp.status === 200
    ? (resp.data?.coverage?.all_country?.list_cost ?? 0)
    : 0;
  if (cache) cache.set(key, cost);
  // Igual criterio que saleFeeMl, con un matiz (hallazgo del revisor, MENOR 2): solo se
  // persiste si ML de verdad trajo `list_cost` — si respondió 200 pero SIN ese campo, `cost`
  // es 0 por el `?? 0` de arriba, pero NO es un 0 confirmado por ML, es "no sabemos". Persistir
  // ese 0 infla el neto hasta por 7 días (TTL_CACHE_PERSISTENTE_MS) y GET /reactivables
  // mostraría "verde" algo que no lo es. Se sigue devolviendo 0 para esta corrida (no bloquea
  // la evaluación), pero sin escribirlo en ml_precios_cache.
  if (resp.status === 200 && resp.data?.coverage?.all_country?.list_cost != null) {
    guardarCachePersistente(db, claveCache, cost);
  }
  return cost;
}

/**
 * Neto del vendedor para una publicación.
 * caches (opcional): { fee: Map, envio: Map } para no repetir llamadas en una corrida.
 * opts.saltarCachePersistente: ver saleFeeMl/costoEnvioMl — revalidación en vivo del paso 5.
 * Devuelve { price, sale_fee, envio, neto }; sale_fee/neto = null si no se pudo obtener la comisión.
 */
export async function netoMl(db, mlCfg, { itemId, price, categoryId, listingTypeId, freeShipping }, caches = {}, opts = {}) {
  const sale_fee = await saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, caches.fee, opts);
  const envio = await costoEnvioMl(db, mlCfg, itemId, price, freeShipping, caches.envio, opts);
  // Con opts.estricto el envío puede ser null (ML no lo confirmó): entonces tampoco hay neto.
  const neto = sale_fee == null || envio == null ? null : +(price - sale_fee - envio).toFixed(2);
  return { price: price ?? null, sale_fee, envio, neto };
}

/**
 * Veredicto del neto contra el precio web.
 *  - sin_precio: falta el precio web o no se pudo calcular el neto (no hay comparación posible)
 *  - bajo: el neto queda > tolUnder por debajo del web (perdés margen) → se bloquea la reactivación
 *  - alto: el neto supera al web por > tolOver (posible sobreprecio)
 *  - ok: dentro de tolerancia
 * deficitPct = (precioWeb − neto) / precioWeb   (>0 = neto por debajo del web)
 */
export function veredictoNeto(neto, precioWeb, { tolUnder = 0.05, tolOver = 0.20 } = {}) {
  if (neto == null || !(precioWeb > 0)) return { estado: 'sin_precio', deficitPct: null };
  const deficitPct = (precioWeb - neto) / precioWeb;
  if (deficitPct > tolUnder) return { estado: 'bajo', deficitPct };
  if (-deficitPct > tolOver) return { estado: 'alto', deficitPct };
  return { estado: 'ok', deficitPct };
}

/**
 * Descuento de contado/transferencia que aplica la web sobre el precio de lista
 * (catalogo_cache.precio = precio de LISTA, el que devuelve la API de WooCommerce en
 * `price`/`regular_price`). Verificado en vivo el 2026-07-20 contra el `price_html` real
 * de 33 productos (simples, variables y variaciones, de $14mil a más de $5M): el precio
 * "Contado/Transf." que muestra la web es siempre exactamente 2/3 del precio de lista,
 * sin una sola excepción — es una regla pareja de todo el catálogo, no por producto.
 *
 * Comparar el neto de ML contra el precio de LISTA (como hacía esta herramienta antes)
 * sobreestima el "déficit" en un 50%: con precio de lista, ~98% del catálogo daba "bajo";
 * contra el precio de contado real, baja a ~25%. El neto de una venta ML es plata en mano
 * (como una venta de contado), así que el precio de contado es la comparación correcta.
 */
export const DESCUENTO_CONTADO = 1 / 3;

/** Precio de contado a partir del precio de lista (o null si no hay precio). */
export function precioContado(precioLista) {
  return precioLista != null ? +(precioLista * (1 - DESCUENTO_CONTADO)).toFixed(2) : null;
}

/**
 * Total de contado de una línea (precio de lista × cantidad, con el descuento de contado),
 * redondeado a 2 decimales UNA SOLA VEZ, sobre el total — no sobre el unitario.
 *
 * `precioContado(precioLista)` ya redondea el unitario a 2 decimales; multiplicar ese
 * resultado redondeado por la cantidad y volver a redondear (`(contado * qty).toFixed(2)`)
 * es un DOBLE redondeo que puede desviar el total real hasta un centavo por unidad extra
 * (ej.: precioLista=1000, contado=666.67 (redondeado), ×3 = 2000.01, cuando el total exacto
 * de 3 unidades a contado es 2000.00). En el registro contable de la tienda ese centavo por
 * venta multi-unidad importa — por eso este helper NO reusa precioContado() para el cálculo
 * de la línea, calcula sobre el precio de lista sin redondear y recién redondea el total.
 *
 * Devuelve `null` si no hay precio de lista (mismo criterio fail-open que precioContado()).
 */
export function totalContado(precioLista, cantidad) {
  return precioLista != null ? +(precioLista * (1 - DESCUENTO_CONTADO) * cantidad).toFixed(2) : null;
}

/**
 * Precio de contado del SKU mapeado a una clave (o null si no hay mapeo/precio de LISTA),
 * a partir de `catalogo_cache.regular_price` (precio de LISTA), NUNCA de `precio` (vigente,
 * que ya trae el sale_price si el producto está en oferta y acumularía dos descuentos).
 *
 * Alimenta el bloqueo de reactivación por precio (chequearNetoReactivar/
 * evaluarPreciosReactivables en routes/sync.js): decisión del usuario (2026-08-03), la
 * oferta de la web NO baja la vara que una publicación de ML tiene que superar.
 *
 * Fail-closed a propósito: si `regular_price` es NULL (SKU sin mapeo, o catálogo aún sin
 * ese campo poblado), devuelve null y la reactivación queda BLOQUEADA. Prohibido agregar
 * un fallback `regular_price ?? precio` — es exactamente el bug que el revisor encontró en
 * el cambio anterior (descuento sobre descuento, en silencio).
 */
export function precioWebClave(db, clave) {
  const row = db.prepare(`
    SELECT c.regular_price
    FROM sku_matcher_decisiones d
    JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE d.clave = ? AND d.accion IN ('asignar','confirmar')
    LIMIT 1
  `).get(clave);
  return row && row.regular_price != null ? precioContado(row.regular_price) : null;
}

/**
 * Precio ML sugerido para que el neto iguale el precio web, a partir del % de comisión
 * implícito en la última auditoría (sale_fee / precio_ml). El envío no depende del precio
 * (se calcula por peso/dimensiones), así que no hace falta iterar contra ML para esta cuenta.
 * Es un punto de partida editable, no exacto: cerca del corte de costo fijo por publicación
 * barata la comisión real no escala de forma perfectamente proporcional al precio.
 */
/**
 * El precio de ML que deja el neto igual a `contado`.
 *
 * Resuelve por PUNTO FIJO, preguntándole a ML la comisión y el envío **del precio candidato**:
 *
 *     P = contado + comisión(P) + envío(P)
 *
 * Por qué no se despeja con una fórmula: la comisión de ML es porcentaje MÁS un costo fijo, y
 * ni el porcentaje ni el tramo del fijo son los mismos para todos los productos — dependen de
 * la categoría y del tipo de publicación. Medido sobre las 1.431 filas de `ml_precio_auditoria`,
 * dentro del tramo de más de $100.000 las tasas efectivas van de 11,48% a 28,64%. Cualquier
 * porcentaje escrito acá sería falso para media tienda.
 *
 * Y por qué no se extrapola la tasa efectiva de hoy (lo que hace `precioSugerido`): esa tasa ya
 * incluye el costo fijo, así que estirarla a un precio mayor multiplica el fijo. Caso real
 * FB-21170 ($12.000, comisión $2.904,65 = 13,79% + $1.250): para un objetivo de $12.000 de neto
 * la fórmula vieja da $15.833 —que deja $12.400— y el punto fijo da $15.370, que deja $12.000.
 *
 * La iteración converge porque la comisión crece más despacio que el precio (es contractiva);
 * el tope de vueltas está por las dudas, no porque se espere llegar a él.
 *
 * El redondeo final es SIEMPRE hacia arriba a los $100 (decisión del usuario, 2026-09-11): el
 * neto nunca puede quedar por debajo del objetivo por un problema de redondeo.
 *
 * Devuelve `precio: null` con un `motivo` legible cuando no se puede calcular. Nunca inventa un
 * número: un precio inventado se publica y se vende.
 */
const PASO_REDONDEO = 100;
// Vueltas máximas. No es un número mágico: con una comisión del 30% cada vuelta reduce el error
// a un tercio, así que 5 alcanzaban para tasas bajas y NO para las altas — medido contra
// publicaciones reales, seis de diez quedaban a menos de $20 del objetivo y se reportaban como
// imposibles. Con 12 sobra para cualquier tasa por debajo del 60%.
const MAX_VUELTAS = 12;

export async function precioObjetivoMl(
  db, mlCfg,
  { itemId, categoryId, listingTypeId, freeShipping, contado, envioActual = null },
  caches = {}, opts = {},
) {
  const vacio = (motivo, extra = {}) => ({
    precio: null, comision: null, envio: null, neto: null,
    vueltas: 0, convergio: false, cruza_umbral_envio: false, motivo, ...extra,
  });
  if (!(contado > 0)) return vacio('Falta el precio de contado: no hay objetivo contra el cual calcular.');

  const redondear = (v) => Math.ceil(v / PASO_REDONDEO) * PASO_REDONDEO;
  // Arranque: el contado más 20%. Sólo es la semilla — las vueltas siguientes usan los números
  // reales de ML, así que de dónde arranca no cambia el resultado, sólo cuántas vueltas toma.
  let precio = redondear(contado * 1.2);
  let comision = null;
  let envio = 0;
  let neto = null;
  let vueltas = 0;

  // Dos fases, y las dos hacen falta.
  //
  // FASE 1 — punto fijo: P ← contado + comisión(P) + envío(P), hasta que el número se estabilice.
  // Converge desde arriba o desde abajo, así que la semilla no condiciona el resultado. Esto es
  // lo que evita pasarse: cortar apenas el neto supera el objetivo dejaba precios hasta $40.000
  // por encima de lo necesario (medido sobre publicaciones reales), y un precio de más no es
  // gratis: es una venta que no ocurre.
  //
  // FASE 2 — cubrir el objetivo: con el precio estable, si por el redondeo el neto quedó unos
  // pesos corto, se sube de a un paso hasta cubrirlo. Son uno o dos pasos; el objetivo es que
  // el neto nunca quede por debajo del contado, ni por $20.
  while (vueltas < MAX_VUELTAS) {
    vueltas += 1;
    comision = await saleFeeMl(db, mlCfg, precio, categoryId, listingTypeId, caches.fee, opts);
    if (comision == null) return vacio('ML no devolvió la comisión para ese precio.', { vueltas });
    envio = await costoEnvioMl(db, mlCfg, itemId, precio, freeShipping, caches.envio, opts, listingTypeId);

    const siguiente = redondear(contado + comision + (envio || 0));
    if (siguiente === precio) break;   // punto fijo alcanzado
    // Una comisión que crece más rápido que el precio no tiene solución.
    if (siguiente > contado * 10) {
      return vacio('La comisión de ML no deja un precio posible para ese neto.', { vueltas, comision, envio: envio || 0 });
    }
    precio = siguiente;
  }

  while (vueltas < MAX_VUELTAS) {
    comision = await saleFeeMl(db, mlCfg, precio, categoryId, listingTypeId, caches.fee, opts);
    if (comision == null) return vacio('ML no devolvió la comisión para ese precio.', { vueltas });
    envio = await costoEnvioMl(db, mlCfg, itemId, precio, freeShipping, caches.envio, opts, listingTypeId);
    neto = +(precio - comision - (envio || 0)).toFixed(2);
    if (neto >= contado) break;
    vueltas += 1;
    precio += PASO_REDONDEO;
  }

  if (!(neto >= contado)) {
    return vacio(`No se alcanzó el objetivo en ${vueltas} vueltas (faltan $${(contado - neto).toFixed(2)}).`,
      { vueltas, comision, envio: envio || 0, neto });
  }

  return {
    precio,
    comision,
    envio: envio || 0,
    neto,
    vueltas,
    convergio: true,
    // El envío del precio nuevo difiere del de hoy: cambia la ecuación del producto y hay que
    // mostrarlo. Es el caso de las publicaciones con envío $0 que cruzan el umbral al subir.
    cruza_umbral_envio: envioActual != null && Math.round(envio || 0) !== Math.round(envioActual),
    motivo: null,
  };
}

/**
 * OBSOLETA (2026-09-11). Extrapola la tasa efectiva actual como si la comisión fuera
 * proporcional, y no lo es: es porcentaje + costo fijo, así que el fijo se multiplica y el
 * precio queda por encima del necesario (3% en el caso medido de FB-21170). Se conserva sólo
 * hasta que el último llamador migre a `precioObjetivoMl`.
 */
export function precioSugerido(precioMl, saleFee, envio, precioWeb) {
  if (!(precioMl > 0) || saleFee == null || !(precioWeb > 0)) return null;
  const pct = saleFee / precioMl;
  if (!(pct < 1)) return null;
  return Math.ceil((precioWeb + (envio || 0)) / (1 - pct));
}

/** Upsert de una fila auditada en ml_precio_auditoria. Comparte statement el scan completo y el refresco puntual tras corregir un precio. */
export function upsertAuditoria(db, fila) {
  db.prepare(`
    INSERT INTO ml_precio_auditoria
      (clave, item_id, titulo, sku, precio_ml, sale_fee, envio, neto, precio_web, deficit_pct, estado, actualizado_en)
    VALUES (@clave, @item_id, @titulo, @sku, @precio_ml, @sale_fee, @envio, @neto, @precio_web, @deficit_pct, @estado, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, titulo=excluded.titulo, sku=excluded.sku, precio_ml=excluded.precio_ml,
      sale_fee=excluded.sale_fee, envio=excluded.envio, neto=excluded.neto, precio_web=excluded.precio_web,
      deficit_pct=excluded.deficit_pct, estado=excluded.estado, actualizado_en=excluded.actualizado_en
  `).run(fila);
}
