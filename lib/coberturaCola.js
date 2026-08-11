/**
 * Cobertura accionable: cola de trabajo del matcher inverso (WC → ML).
 *
 * Separa "es un faltante de cobertura" (lib/cobertura.js#esFaltante, que mira ML EN VIVO)
 * de "está pendiente en la cola de trabajo" (acá): un producto deja de estar en la cola en
 * cuanto el usuario toma una decisión (confirmar/descartar/publicar), aunque el push a ML
 * todavía no se haya efectivizado — si esperáramos a que ML confirme el SKU, la tarjeta ya
 * decidida seguiría apareciendo en la cola mientras el cron de pushSkusPendientes hace lo
 * suyo, y el usuario la volvería a ver.
 */

import { esFaltante, esNoVendible } from './cobertura.js';
import { construirWC, construirML, candidatosParaWC, diffTokens, toks, tsr, confianzaDesdeScore } from './matcherEngine.js';

/** Set de SKUs con una decisión "confirmar" viva (vinculado, pushed o no todavía). */
function skusConfirmados(db) {
  const rows = db.prepare(
    "SELECT sku FROM sku_matcher_decisiones WHERE accion = 'confirmar' AND sku IS NOT NULL AND sku != ''"
  ).all();
  return new Set(rows.map((r) => r.sku));
}

/** Set de id_woo mandados a "hay que publicarlo" (sin importar tachado: ya salió de la cola). */
function idsHayQuePublicar(db) {
  return new Set(db.prepare('SELECT id_woo FROM cobertura_hay_que_publicar').all().map((r) => r.id_woo));
}

function idsSalteados(db) {
  const rows = db.prepare('SELECT id_woo, creado_en FROM cobertura_salteados').all();
  return new Map(rows.map((r) => [r.id_woo, r.creado_en]));
}

/**
 * Universo completo de la cola: faltantes (regla canónica de lib/cobertura.js) que además
 * no tienen decisión de vínculo ni fueron mandados a "hay que publicarlo". Incluye los
 * salteados (no son terminales) con su marca de salteo para poder ordenarlos al final.
 */
export function calcularUniversoPendiente(db) {
  const wcProductos = db.prepare('SELECT * FROM catalogo_cache').all();
  const skusEnML = new Set(
    db.prepare("SELECT DISTINCT seller_sku FROM ml_publicaciones_cache WHERE seller_sku IS NOT NULL AND seller_sku != ''").all()
      .map((r) => r.seller_sku)
  );
  const excluidos = new Set(db.prepare('SELECT id_woo FROM cobertura_exclusiones').all().map((r) => r.id_woo));
  const confirmados = skusConfirmados(db);
  const yaAPublicar = idsHayQuePublicar(db);
  const salteados = idsSalteados(db);

  return wcProductos
    .filter((p) => esFaltante(p, skusEnML, excluidos))
    .filter((p) => !confirmados.has(String(p.sku || '').trim()))
    .filter((p) => !yaAPublicar.has(p.id_woo))
    .map((p) => ({ ...p, salteado_en: salteados.get(p.id_woo) || null }));
}

/** Marcas con conteo y valor inmovilizado (precio * stock), para la pantalla de entrada. */
export function resumenMarcas(db) {
  const universo = calcularUniversoPendiente(db);
  const porMarca = new Map();
  let totalValor = 0;
  for (const p of universo) {
    const marca = (p.marca && String(p.marca).trim()) || '(sin marca)';
    const valor = Number(p.precio || 0) * Number(p.stock || 0);
    totalValor += valor;
    if (!porMarca.has(marca)) porMarca.set(marca, { marca, conteo: 0, valor: 0 });
    const entry = porMarca.get(marca);
    entry.conteo += 1;
    entry.valor += valor;
  }
  const marcas = [...porMarca.values()].sort((a, b) => b.conteo - a.conteo);
  return { marcas, total_pendientes: universo.length, total_valor: totalValor };
}

/** Inicio del día (hora local del server) en ISO, para las señales de progreso "hoy". */
function inicioHoyISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Progreso de sesión: resueltos hoy (confirmar+descartar+publicar) y valor desinmovilizado hoy.
 * `origen = 'cobertura'` filtra las decisiones que escribió ESTA herramienta — sin este
 * filtro, confirmar un vínculo desde el Matcher ML→WC (routes/matcher.js, misma tabla) también
 * infla "resueltos hoy" acá, contando trabajo de otra herramienta (hallazgo del revisor).
 */
export function progresoHoy(db) {
  const desde = inicioHoyISO();
  const confirmadosHoy = db.prepare(
    "SELECT sku FROM sku_matcher_decisiones WHERE accion = 'confirmar' AND origen = 'cobertura' AND actualizado_en >= ?"
  ).all(desde);
  const descartadosHoy = db.prepare('SELECT COUNT(*) n FROM cobertura_exclusiones WHERE creado_en >= ?').get(desde).n;
  const aPublicarHoy = db.prepare('SELECT COUNT(*) n FROM cobertura_hay_que_publicar WHERE creado_en >= ?').get(desde).n;

  let valorDesinmovilizado = 0;
  if (confirmadosHoy.length) {
    const skus = confirmadosHoy.map((r) => r.sku);
    const placeholders = skus.map(() => '?').join(',');
    const filas = db.prepare(`SELECT sku, precio, stock FROM catalogo_cache WHERE sku IN (${placeholders})`).all(...skus);
    for (const f of filas) valorDesinmovilizado += Number(f.precio || 0) * Number(f.stock || 0);
  }

  return {
    resueltos_hoy: confirmadosHoy.length + descartadosHoy + aPublicarHoy,
    valor_desinmovilizado_hoy: valorDesinmovilizado,
  };
}

/** "Seguir donde quedé": marca de la última sesión, con su progreso actual. */
export function seguirDondeQuede(db) {
  const sesion = db.prepare('SELECT marca_actual FROM cobertura_sesion WHERE id = 1').get();
  if (!sesion || !sesion.marca_actual) return null;
  const universo = calcularUniversoPendiente(db);
  const marca = sesion.marca_actual;
  const pendientesMarca = universo.filter((p) => ((p.marca && String(p.marca).trim()) || '(sin marca)') === marca);
  if (!pendientesMarca.length) return null; // ya no queda nada de esa marca: no ofrecer retomar
  return { marca, pendientes: pendientesMarca.length };
}

/** Registra/actualiza la marca en trabajo (para "seguir donde quedé"). */
export function tocarSesion(db, marca) {
  db.prepare(`
    INSERT INTO cobertura_sesion (id, marca_actual, actualizado_en) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET marca_actual = excluded.marca_actual, actualizado_en = excluded.actualizado_en
  `).run(marca, new Date().toISOString());
}

/**
 * Cola de una marca, paginada. Orden: primero los NO salteados (stock desc = prioridad
 * "stock alto"), y recién después los salteados (vuelven al final de la MISMA tanda, no
 * desaparecen — ver plan de flujo §5).
 */
export function productosDeMarca(db, marca, { limit = 20, offset = 0 } = {}) {
  const universo = calcularUniversoPendiente(db)
    .filter((p) => ((p.marca && String(p.marca).trim()) || '(sin marca)') === marca);
  universo.sort((a, b) => {
    const sa = a.salteado_en ? 1 : 0, sb = b.salteado_en ? 1 : 0;
    if (sa !== sb) return sa - sb; // no-salteados primero
    if (sa === 1) return String(a.salteado_en).localeCompare(String(b.salteado_en)); // salteado más viejo primero
    return Number(b.stock || 0) - Number(a.stock || 0);
  });
  return { total: universo.length, items: universo.slice(offset, offset + limit) };
}

/**
 * Universo ML del matcher inverso: publicaciones sin seller_sku Y sin ninguna decisión viva
 * en sku_matcher_decisiones (sea cual sea su accion). BLOQUEANTE corregido (revisor):
 * antes solo miraba seller_sku, así que dos huecos reales:
 *  1) Las 2362 decisiones en 'omitir' (excluidas explícitamente por el plan, §Preguntas
 *     resueltas 1) volvían a aparecer como candidatas.
 *  2) Una publicación YA confirmada para el SKU A pero con el push todavía pendiente sigue
 *     con seller_sku NULL en caché (el PUT a ML no se efectivizó todavía) — sin este filtro
 *     se ofrecía como candidato para un producto B distinto. Confirmar B pisaba en silencio
 *     la decisión de A (mismo clave, ON CONFLICT), y A "perdía" su vínculo sin aviso.
 * Cualquier clave con una fila en sku_matcher_decisiones (confirmar/asignar/omitir) queda
 * fuera del universo — es del Matcher ML→WC, o ya tiene destino, o fue descartada a mano.
 */
export function construirIndiceMlSinSku(db) {
  const rows = db.prepare(`
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, p.color, p.talle, p.thumbnail, p.precio,
           p.available_quantity, p.status
    FROM ml_publicaciones_cache p
    WHERE (p.seller_sku IS NULL OR p.seller_sku = '')
      AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)
  `).all();
  return construirML(rows.map((r) => ({
    clave: r.clave, item_id: r.item_id, variation_id: r.variation_id, titulo: r.titulo,
    color: r.color, talle: r.talle, thumbnail: r.thumbnail, precio: r.precio,
    available_quantity: r.available_quantity, status: r.status,
  })));
}

/** Arma el ítem WC (motor) para un producto de catalogo_cache. */
export function itemWcDeProducto(prod) {
  const { wcItems } = construirWC([{
    sku: prod.sku, nombre: prod.nombre, tipo: prod.tipo, atributos_json: prod.atributos_json, img: prod.img,
  }]);
  return wcItems[0] || null;
}

/** Candidatos (motor) + diff estructurado para un producto de la cola, contra el índice ML dado. */
export function candidatosDeProducto(prod, mlIndex) {
  const wc = itemWcDeProducto(prod);
  if (!wc) return { candidatos: [], sin_candidato: true };
  return candidatosParaWC(wc, mlIndex, prod.marca || '');
}

/** Búsqueda manual: texto libre sobre las publicaciones ML sin SKU, con el mismo diff estructurado. */
export function buscarMlManual(prod, mlIndex, query, limit = 20) {
  const wc = itemWcDeProducto(prod);
  const q = String(query || '').trim().toLowerCase();
  if (!wc || !q) return [];
  const tksWc = toks(wc.baseNorm);
  return mlIndex.mlItems
    .filter((m) => m.titulo.toLowerCase().includes(q))
    .slice(0, limit)
    .map((m) => {
      const diff = diffTokens(tksWc, m.tokens, mlIndex.df, mlIndex.corpusSize, prod.marca || '');
      // `confianza` se calcula ACÁ, con la misma función del motor que usan los candidatos
      // sugeridos, y no en el front. Antes este endpoint devolvía solo el diff y la interfaz
      // derivaba el nivel por su cuenta con una regla simplificada: una segunda fuente de
      // verdad que ya había quedado desactualizada (no conocía el conflicto de marca, que
      // fuerza 'baja'). Y la búsqueda manual es justamente el camino que se usa cuando NO se
      // confía en las sugerencias, o sea el de mayor riesgo de vínculo equivocado.
      const confianza = confianzaDesdeScore(tsr(wc.baseNorm, m.baseNorm), diff.hay_contradiccion, diff.conflicto_marca);
      return {
        ml_clave: m.clave, ml_item_id: m.item_id, ml_variation_id: m.variation_id, ml_titulo: m.titulo,
        ml_img: m.thumbnail, ml_precio: m.precio, ml_stock: m.stock, ml_status: m.status, diff, confianza,
      };
    });
}

/**
 * Lista "sin stock" (aparte de la cola principal, por si reponen): mismo criterio que
 * esFaltante pero invertido en el filtro de stock. Función compartida entre GET /sin-stock
 * y el conteo de GET /resumen — antes vivían duplicados con criterios distintos (incoherencia
 * señalada por el revisor: la tarjeta de entrada mostraba un número que la lista real nunca
 * alcanzaba, porque el conteo no descontaba cubiertos en ML / excluidos / no-vendibles).
 */
export function calcularSinStock(db) {
  const skusEnML = new Set(
    db.prepare("SELECT DISTINCT seller_sku FROM ml_publicaciones_cache WHERE seller_sku IS NOT NULL AND seller_sku != ''").all()
      .map((r) => r.seller_sku)
  );
  const excluidos = new Set(db.prepare('SELECT id_woo FROM cobertura_exclusiones').all().map((e) => e.id_woo));
  return db.prepare('SELECT * FROM catalogo_cache').all().filter((p) => {
    const sku = String(p.sku || '').trim();
    if (!sku || p.tipo === 'variable') return false;
    if (Number(p.stock) > 0) return false; // esto es justamente lo opuesto a esFaltante
    if (skusEnML.has(sku)) return false; // ya cubierto, no importa el stock
    if (excluidos.has(p.id_woo)) return false;
    if (esNoVendible({ categorias_json: p.categorias_json })) return false;
    return true;
  });
}

export { esNoVendible };
