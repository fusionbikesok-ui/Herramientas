import express from 'express';
import { llamarGemini, parseJsonArrayText } from './gemini.js';
import { CATEGORIAS_FB, armarPromptBatch } from '../lib/categorias.js';
import { parseCategorias } from '../lib/modelos/producto.js';
import { listarCategoriasWoo, crearBorradorWoo, conciliarAltaIncierta } from '../lib/nuevosProductosWoo.js';

export function tituloCase(palabra) {
  if (!palabra) return '';
  return palabra.charAt(0).toUpperCase() + palabra.slice(1).toLowerCase();
}

export function armarTitulo(tipo, marca, modelo, dato) {
  return [tipo, marca, modelo, dato].filter(Boolean).join(' ').trim();
}

/**
 * Devuelve las categorías reales/actuales de WooCommerce leyendo la columna
 * categorias_json de catalogo_cache. Cada fila es un array JSON de categorías
 * PLANAS (un nombre por nivel, ej "BICICLETAS POR MARCA" y "BICICLETAS TREK"
 * por separado — NO rutas "PADRE > HIJO"). Aplana todas las filas y devuelve
 * los valores únicos ordenados alfabéticamente. Es la misma fuente en vivo que
 * usan Cobertura/Matcher/Preparación, refrescada por el sync periódico
 * (refrescarCatalogo en routes/woo.js).
 *
 * Si el catálogo está vacío o el parseo no arroja nada, cae al array estático
 * CATEGORIAS_FB (con un console.warn para distinguir catálogo vacío legítimo de
 * un sync roto).
 */
export function categoriasReales(db) {
  const set = new Set();
  const filas = db.prepare("SELECT categorias_json FROM catalogo_cache WHERE categorias_json IS NOT NULL AND categorias_json <> ''").all();
  for (const fila of filas) {
    for (const cat of parseCategorias(fila.categorias_json)) {
      if (typeof cat === 'string' && cat.trim()) set.add(cat.trim());
    }
  }
  if (set.size === 0) {
    console.warn('[nuevos-productos] catalogo_cache sin categorías; usando fallback CATEGORIAS_FB. Revisar el sync de Woo.');
    return [...CATEGORIAS_FB];
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

export async function analizarProductosNuevosBatch(geminiKey, productos, categoriasDisponibles) {
  const text = await llamarGemini(geminiKey, {
    contents: [{ parts: [{ text: `${armarPromptBatch(categoriasDisponibles)}\n\nProductos:\n${JSON.stringify(productos)}` }] }]
  });
  return parseJsonArrayText(text);
}

export function nuevosProductosRouter(geminiKey, db, wooCfg, deps = {}) {
  const router = express.Router();

  router.get('/operaciones/:operationId', (req,res) => {
    const row=db.prepare('SELECT operation_id,estado,modo,id_woo,id_padre,sku,error,creado_en,actualizado_en FROM recepcion_altas_woo WHERE operation_id=?').get(req.params.operationId);
    if (!row) return res.status(404).json({ok:false,error:'operación no encontrada'});
    res.json({ok:true,operacion:row,bloqueada:row.estado==='incierto'||row.estado==='procesando'});
  });

  // P1.6: recupera una alta 'incierto' leyendo Woo. No hace nada si la operación no existe o no
  // está en 'incierto' (conciliarAltaIncierta ya es idempotente en ese caso).
  router.post('/operaciones/:operationId/conciliar', async (req, res) => {
    try {
      const r = await conciliarAltaIncierta({ db, cfg: wooCfg, operationId: req.params.operationId, fetchWoo: deps.fetchWoo });
      res.json({ ok: true, ...r });
    } catch (e) {
      const status = /no encontrada/.test(e.message) ? 404 : 502;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  router.get('/categorias-woo', async (req,res) => { try { res.json({ok:true,categorias:await listarCategoriasWoo(wooCfg,deps)}); } catch(e) { res.status(502).json({ok:false,error:e.message}); } });
  router.post('/crear-borrador', async (req,res) => { try { const result=await crearBorradorWoo({db,cfg:wooCfg,operationId:req.body?.operation_id,ficha:req.body?.ficha,actor:req.user?.username||'sistema',fetchWoo:deps.fetchWoo}); res.json({ok:true,...result}); } catch(e) { const status=/inexistente/.test(e.message)?404:/bloqueada|operationId|reutilizado/.test(e.message)?409:/inválido|required|atributos|precio|padre/.test(e.message)?400:502; res.status(status).json({ok:false,error:e.message}); } });

  router.get('/categorias', (req, res) => {
    try {
      res.json({ ok: true, categorias: categoriasReales(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/analizar', async (req, res) => {
    try {
      const categorias = categoriasReales(db);
      const fichas = await analizarProductosNuevosBatch(geminiKey, req.body.productos, categorias);
      const conTitulo = fichas.map(f => ({ ...f, titulo: armarTitulo(f.ti, f.m, f.mo, f.da) }));
      res.json({ ok: true, fichas: conTitulo });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
