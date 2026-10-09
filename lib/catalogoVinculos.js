/**
 * Fase D, pantalla "Catálogo y vínculos": lecturas que la API arma sobre Identidad.
 * Solo lectura; las escrituras viven en lib/identidadProductos.js.
 */

import { atributosDeTexto, contradiccionDeClave } from './contradiccionTitulo.js';
import { claveGtin } from './gtin.js';

const DIA_MS = 86400000;
const ESTADOS_CERRADOS = ['resuelto', 'verificado', 'exceptuado'];

/**
 * Plata en juego de cada caso abierto: unidades vendidas en ML en los últimos 30 días POR ESA PUBLICACIÓN
 * (`ml_key`, no por SKU) × stock actual del producto Woo. Sin producto Woo o sin stock conocido la plata es 0
 * y el orden cae a la antigüedad del caso.
 * Devuelve un Map(ml_key → fila) ya ordenado: plata desc y, con empate, `primera_deteccion_en` asc.
 */
export function plataEnJuego(db, { ahora = new Date(), dias = 30 } = {}) {
  const desde = new Date(ahora.getTime() - dias * DIA_MS).toISOString();
  const casos = db.prepare(`SELECT c.id AS caso_id, c.ml_key, c.primera_deteccion_en,
      COALESCE(
        (SELECT cc.stock FROM productos_fusion p JOIN catalogo_cache cc ON cc.id_woo=p.primary_woo_id WHERE p.id=c.producto_id),
        (SELECT cc.stock FROM sku_matcher_decisiones d JOIN catalogo_cache cc ON cc.sku=d.sku AND cc.sku<>''
           WHERE d.clave=c.ml_key AND d.accion IN ('asignar','confirmar') LIMIT 1)
      ) AS stock_woo
    FROM identidad_casos c
    WHERE c.direccion='ml_fusion' AND c.estado NOT IN (${ESTADOS_CERRADOS.map(() => '?').join(',')})`).all(...ESTADOS_CERRADOS);
  const ventas = new Map(db.prepare(`SELECT i.ml_key, COALESCE(SUM(i.cantidad),0) AS unidades
    FROM gestion_pedido_items i JOIN gestion_pedidos p ON p.id=i.pedido_id
    WHERE p.fuente='mercadolibre' AND p.estado_comercial<>'cancelado' AND i.ml_key IS NOT NULL
      AND COALESCE(p.creado_fuente_en,p.importado_en)>=?
    GROUP BY i.ml_key`).all(desde).map((r) => [r.ml_key, r.unidades]));
  const filas = casos.map((c) => {
    const unidades = ventas.get(c.ml_key) ?? 0;
    const stock = c.stock_woo == null ? null : Number(c.stock_woo);
    return { caso_id: c.caso_id, ml_key: c.ml_key, unidades_30d: unidades, stock_woo: stock,
      plata: stock == null ? 0 : unidades * Math.max(stock, 0), primera_deteccion_en: c.primera_deteccion_en };
  });
  filas.sort((a, b) => b.plata - a.plata || String(a.primera_deteccion_en).localeCompare(String(b.primera_deteccion_en)));
  return new Map(filas.map((f) => [f.ml_key, f]));
}

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const SEMAFORO_TEXTO = { verde: 'Coincide', rojo: 'Difiere', ambar: 'Falta', gris: 'No aplica' };

function filaMatriz(campo, etiqueta, ml, candidato, semaforo, texto = SEMAFORO_TEXTO[semaforo]) {
  return { campo, etiqueta, ml: ml ?? null, candidato: candidato ?? null, semaforo, texto };
}

/** Compara dos listas de valores ya normalizados. Vacías de ambos lados = no aplica. */
function compararListas(ml, cand, rojo) {
  if (!ml.length && !cand.length) return 'gris';
  if (!ml.length || !cand.length) return 'ambar';
  if (rojo) return 'rojo';
  return ml.some((v) => cand.includes(v)) && ml.length === cand.length ? 'verde' : 'ambar';
}

/**
 * Matriz de atributos de una publicación contra el producto Woo candidato (por SKU).
 * Semáforo (siempre con texto): rojo = veto (mismo criterio que `contradiccionDeClave`, así coincide con lo
 * que bloquea el backend), ámbar = falta un dato o difiere solo en el formato, verde = coincide, gris = no aplica.
 * El GTIN se compara aparte (`claveGtin`) y, si difiere, es ámbar y marca `leve`: no es veto.
 */
export function matrizAtributos(db, clave, sku) {
  const pub = db.prepare('SELECT titulo,color,talle,variations_texto,seller_sku,gtin FROM ml_publicaciones_cache WHERE clave=?').get(clave);
  const woo = db.prepare('SELECT nombre,sku,gtin FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC LIMIT 1').get(sku);
  if (!pub || !woo) return { veto: false, leve: false, motivos: [], filas: [] };
  const { contradice, motivos } = contradiccionDeClave(db, clave, sku);
  const rojoDe = (campo) => motivos.some((m) => m.campo === campo);
  const textoMl = `${pub.titulo ?? ''} ${pub.variations_texto ?? ''}`;
  const ml = atributosDeTexto(textoMl, { talle: pub.talle, color: pub.color });
  const cand = atributosDeTexto(woo.nombre ?? '');
  const filas = [];

  filas.push(filaMatriz('titulo', 'Título', pub.titulo, woo.nombre,
    norm(pub.titulo) === norm(woo.nombre) ? 'verde' : 'ambar', norm(pub.titulo) === norm(woo.nombre) ? 'Coincide' : 'Falta'));
  const skuMl = norm(pub.seller_sku); const skuCand = norm(woo.sku);
  filas.push(filaMatriz('sku', 'SKU', pub.seller_sku, woo.sku, !skuMl ? 'ambar' : skuMl === skuCand ? 'verde' : 'rojo',
    !skuMl ? 'Falta' : skuMl === skuCand ? 'Coincide' : 'Difiere'));

  const gMl = claveGtin(pub.gtin); const gCand = claveGtin(woo.gtin);
  const gSem = !gMl && !gCand ? 'gris' : !gMl || !gCand ? 'ambar' : gMl === gCand ? 'verde' : 'ambar';
  filas.push(filaMatriz('gtin', 'GTIN', pub.gtin, woo.gtin, gSem, gSem === 'ambar' && gMl && gCand ? 'Difiere' : SEMAFORO_TEXTO[gSem]));

  const lista = (campo, etiqueta, mlVals, candVals) => {
    const a = mlVals.map(String).map(norm); const b = candVals.map(String).map(norm);
    const sem = compararListas(a, b, rojoDe(campo));
    filas.push(filaMatriz(campo, etiqueta, mlVals.join('/') || null, candVals.join('/') || null, sem));
  };
  lista('color', 'Color', ml.colores, cand.colores);
  lista('talle', 'Talle', ml.talles, cand.talles);
  lista('rodado', 'Rodado', ml.rodados, cand.rodados);
  lista('transmision', 'Transmisión', ml.transmision ? [ml.transmision] : [], cand.transmision ? [cand.transmision] : []);
  lista('velocidades', 'Velocidades', ml.velocidades, cand.velocidades);

  const leve = filas.some((f) => f.campo === 'gtin' && f.semaforo === 'ambar' && f.texto === 'Difiere');
  return { veto: contradice, leve, motivos, filas };
}
