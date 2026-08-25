/**
 * Consulta de Precios: busca un producto por SKU o EAN y devuelve su precio web
 * (más título, marca, categoría y foto), leyendo catalogo_cache.
 *
 * El EAN no vive en WooCommerce, así que el puente EAN→SKU se guarda en la tabla
 * ean_sku, que aprende de a uno: cuando aparece un EAN desconocido, el frontend
 * pide el SKU y lo enseña con POST /ean.
 */

import { Router } from 'express';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';
import { precioContado } from '../lib/mlPrecios.js';
import { armarLike } from '../lib/busqueda.js';
import { looksLikeGtin, persistirGtinConfirmado, subirGtinAWoo } from '../lib/gtinWoo.js';

const now = () => new Date().toISOString();

/** ¿El código parece un EAN? Sólo dígitos, largo 8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function pareceEan(codigo) {
  const s = String(codigo || '').trim();
  return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length);
}

/**
 * Fila de catalogo_cache → objeto liviano para la card de resultado.
 * `precio` es el precio de CONTADO/Transferencia (2/3 del de lista, ver precioContado),
 * no el precio de lista guardado en catalogo_cache. Se mantiene el nombre `precio`
 * (en vez de `precio_web` como en routes/precios.js) para no tocar el frontend, que
 * ya lo consume como `p.precio` en varios lugares. La card lo rotula "Contado/Transf.".
 *
 * A PROPÓSITO usa `p.precio` (VIGENTE) y no `regular_price` (LISTA), a diferencia de los
 * demás call sites de precioContado() en el repo (lib/mlPrecios.js, routes/precios.js,
 * routes/sync.js — todos comparan contra publicaciones de ML y deben ignorar la oferta de
 * la web). Decisión explícita del usuario (2026-08-03): Consulta de Precios es el mostrador
 * — el cliente tiene que ver el mismo "Contado/Transf." que ve en la página del producto,
 * oferta incluida. NO "unificar" este call site con los demás.
 */
function productoParaCard(row) {
  const p = productoDesdeFilaCatalogo(row);
  return {
    id_woo: p.id_woo, sku: p.sku, nombre: p.nombre, marca: p.marca, categorias: p.categorias,
    precio: precioContado(p.precio), stock: p.stock, tipo: p.tipo, id_padre: p.id_padre,
    gtin: p.gtin, img: p.img,
  };
}

export function consultaPreciosRouter(db, cfg = {}) {
  const router = Router();

  const porSku = db.prepare("SELECT * FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1");
  const porId = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = ? LIMIT 1');
  const contarPorSku = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku = ? AND sku <> ''");
  const eanRow = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?');
  const guardarEan = db.prepare(`
    INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
  `);

  function guardarMapa(ean, sku, pisarMapa = false) {
    // Fix 3: validar conflicto de mapa antes de escribir
    const existente = eanRow.get(ean);
    if (existente && existente.sku !== sku && !pisarMapa) {
      return { conflicto: true, skuActual: existente.sku };
    }
    guardarEan.run(ean, sku, now());
    return { ok: true };
  }

  function resolverProducto({ sku, idWoo }) {
    if (idWoo != null && idWoo !== '') {
      // Fix 2: validación mejorada de id_woo sin coerción peligrosa
      if (typeof idWoo === 'number') {
        if (!Number.isInteger(idWoo)) return null; // id_woo no es entero
      } else if (typeof idWoo === 'string') {
        // Aceptar solo strings que sean dígitos puros (sin decimales)
        if (!/^[0-9]+$/.test(idWoo.trim())) return null;
      } else {
        // Rechazar boolean, array, object, etc
        return null;
      }
      const fila = porId.get(Number(idWoo));
      if (!fila || !fila.sku) return null; // fila sin sku no es válida
      // Fix 1: validar coherencia sku↔id_woo si vienen ambos
      if (sku && fila.sku !== sku) {
        return { incoherente: true, skuEncontrado: fila.sku };
      }
      return fila;
    }
    const cantidad = contarPorSku.get(sku);
    if (cantidad.n > 1) return { ambiguo: cantidad.n };
    const fila = porSku.get(sku);
    if (fila && !fila.sku) return null; // fila sin sku no es válida
    return fila;
  }

  // Búsqueda unificada: SKU exacto → EAN conocido → ¿parece EAN nuevo? → nada.
  router.get('/buscar', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, found: false });

    const filaSku = porSku.get(q);
    if (filaSku) return res.json({ ok: true, found: true, tipo: 'sku', producto: productoParaCard(filaSku) });

    const ean = eanRow.get(q);
    if (ean) {
      const fila = porSku.get(ean.sku);
      if (fila) return res.json({ ok: true, found: true, tipo: 'ean', producto: productoParaCard(fila) });
      return res.json({ ok: true, found: false, tipo: 'ean', ean: q, skuHuerfano: ean.sku });
    }

    if (pareceEan(q)) return res.json({ ok: true, found: false, needsSku: true, ean: q });
    return res.json({ ok: true, found: false });
  });

  // Enseña un EAN nuevo (o corrige uno mal mapeado). Valida que el SKU exista.
  router.post('/ean', (req, res) => {
    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const idWoo = req.body?.id_woo;
    const pisarMapa = req.body?.pisar_mapa === true;
    if (!ean || !sku) return res.status(400).json({ ok: false, error: 'ean y sku requeridos' });

    // Validar id_woo si viene (Fix 2: rechazar tipos peligrosos)
    if (idWoo != null && idWoo !== '') {
      if (typeof idWoo === 'number') {
        if (!Number.isInteger(idWoo)) {
          return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
        }
      } else if (typeof idWoo === 'string') {
        if (!/^[0-9]+$/.test(idWoo.trim())) {
          return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
        }
      } else {
        // Rechazar boolean, array, object, etc
        return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
      }
    }

    const fila = resolverProducto({ sku, idWoo });
    if (fila?.ambiguo) {
      return res.status(400).json({
        ok: false,
        codigo: 'sku_ambiguo',
        error: `El SKU '${sku}' es ambiguo: hay ${fila.ambiguo} productos. Especificá el id_woo.`,
      });
    }
    // Fix 1: validar incoherencia sku↔id_woo
    if (fila?.incoherente) {
      return res.status(400).json({
        ok: false,
        codigo: 'sku_id_woo_incoherente',
        error: `El id_woo ${idWoo} tiene SKU '${fila.skuEncontrado}', pero pediste '${sku}'. No coinciden.`,
      });
    }
    if (!fila) {
      if (idWoo != null && idWoo !== '') {
        return res.status(400).json({ ok: false, error: `id_woo ${idWoo} no existe o no tiene SKU asignado` });
      }
      return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });
    }
    // Fix 3: manejar conflicto de mapa
    const mapResult = guardarMapa(ean, fila.sku, pisarMapa);
    if (mapResult.conflicto && !pisarMapa) {
      return res.json({
        ok: true,
        producto: productoParaCard(fila),
        codigo: { estado: 'conflicto_mapa', sku_actual: mapResult.skuActual, ean },
      });
    }
    res.json({ ok: true, producto: productoParaCard(fila) });
  });

  // Enseña el EAN y, si es válido, intenta dejarlo también en Woo. La asociación
  // local es fail-open: el trabajo del mostrador no se pierde si Woo rechaza el código.
  router.post('/asociar', async (req, res) => {
    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const idWoo = req.body?.id_woo;
    const pisarCodigo = req.body?.pisar_codigo === true;
    const pisarMapa = req.body?.pisar_mapa === true;
    if (!ean || !sku) return res.status(400).json({ ok: false, error: 'ean y sku requeridos' });

    // Validar id_woo si viene (Fix 2: rechazar tipos peligrosos)
    if (idWoo != null && idWoo !== '') {
      if (typeof idWoo === 'number') {
        if (!Number.isInteger(idWoo)) {
          return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
        }
      } else if (typeof idWoo === 'string') {
        if (!/^[0-9]+$/.test(idWoo.trim())) {
          return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
        }
      } else {
        // Rechazar boolean, array, object, etc
        return res.status(400).json({ ok: false, error: `id_woo debe ser un número entero, recibido: ${idWoo}` });
      }
    }

    const fila = resolverProducto({ sku, idWoo });
    if (fila?.ambiguo) {
      return res.status(400).json({
        ok: false,
        codigo: 'sku_ambiguo',
        error: `El SKU '${sku}' es ambiguo: hay ${fila.ambiguo} productos. Especificá el id_woo.`,
      });
    }
    // Fix 1: validar incoherencia sku↔id_woo
    if (fila?.incoherente) {
      return res.status(400).json({
        ok: false,
        codigo: 'sku_id_woo_incoherente',
        error: `El id_woo ${idWoo} tiene SKU '${fila.skuEncontrado}', pero pediste '${sku}'. No coinciden.`,
      });
    }
    if (!fila) {
      if (idWoo != null && idWoo !== '') {
        return res.status(400).json({ ok: false, error: `id_woo ${idWoo} no existe o no tiene SKU asignado` });
      }
      return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });
    }

    const codigoBase = { gtin: ean };
    if (!looksLikeGtin(ean)) {
      const mapResult = guardarMapa(ean, fila.sku, pisarMapa);
      if (mapResult.conflicto && !pisarMapa) {
        return res.json({
          ok: true,
          producto: productoParaCard(fila),
          codigo: { ...codigoBase, estado: 'conflicto_mapa', sku_actual: mapResult.skuActual },
        });
      }
      return res.json({ ok: true, producto: productoParaCard(fila), codigo: { ...codigoBase, estado: 'no_valido' } });
    }

    const gtinActual = String(fila.gtin || '').trim();
    if (gtinActual && gtinActual !== ean && !pisarCodigo) {
      return res.json({
        ok: true,
        producto: productoParaCard(fila),
        codigo: { ...codigoBase, estado: 'conflicto', gtin_actual: gtinActual },
      });
    }

    if (gtinActual === ean) {
      const mapResult = guardarMapa(ean, fila.sku, pisarMapa);
      if (mapResult.conflicto && !pisarMapa) {
        return res.json({
          ok: true,
          producto: productoParaCard(fila),
          codigo: { ...codigoBase, estado: 'conflicto_mapa', sku_actual: mapResult.skuActual },
        });
      }
      return res.json({ ok: true, producto: productoParaCard(fila), codigo: { ...codigoBase, estado: 'sin_cambio' } });
    }

    const woo = await subirGtinAWoo(cfg, fila, ean);
    if (!woo.ok) {
      const mapResult = guardarMapa(ean, fila.sku, pisarMapa);
      if (mapResult.conflicto && !pisarMapa) {
        return res.json({
          ok: true,
          producto: productoParaCard(fila),
          codigo: { ...codigoBase, estado: 'conflicto_mapa', sku_actual: mapResult.skuActual },
        });
      }
      return res.json({
        ok: true,
        producto: productoParaCard(fila),
        codigo: { ...codigoBase, estado: 'fallo', motivo: woo.motivo || 'woo', error: woo.error },
      });
    }

    persistirGtinConfirmado(db, fila, ean, fila.sku);
    const mapResult = guardarMapa(ean, fila.sku, pisarMapa);
    if (mapResult.conflicto && !pisarMapa) {
      const actualizado = porId.get(fila.id_woo) || fila;
      return res.json({
        ok: true,
        producto: productoParaCard(actualizado),
        codigo: { ...codigoBase, estado: 'conflicto_mapa', sku_actual: mapResult.skuActual },
      });
    }
    const actualizado = porId.get(fila.id_woo) || fila;
    return res.json({ ok: true, producto: productoParaCard(actualizado), codigo: { ...codigoBase, estado: 'subido' } });
  });

  // Sembrado en lote desde el mapa del Contador de inventario. No valida contra el catálogo.
  router.post('/importar', (req, res) => {
    const pares = Array.isArray(req.body?.pares) ? req.body.pares : [];
    const validos = pares
      .map(p => ({ ean: String(p?.ean || '').trim(), sku: String(p?.sku || '').trim() }))
      .filter(p => p.ean && p.sku);
    const ins = db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
    `);
    const tx = db.transaction((filas) => { for (const f of filas) ins.run(f.ean, f.sku, now()); });
    tx(validos);
    res.json({ ok: true, importados: validos.length, recibidos: pares.length });
  });

  // Autocomplete de SKU para enseñar un EAN nuevo.
  router.get('/buscar-sku', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = armarLike(q);
    const rows = db.prepare(`
      SELECT id_woo, sku, nombre, stock, tipo, id_padre FROM catalogo_cache
      WHERE (sku LIKE ? ESCAPE '\\' OR nombre LIKE ? ESCAPE '\\') AND sku <> ''
      ORDER BY nombre ASC LIMIT 20
    `).all(like, like);
    res.json({ ok: true, data: rows });
  });

  return router;
}
