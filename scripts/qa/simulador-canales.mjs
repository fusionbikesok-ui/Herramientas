// Simulador de MercadoLibre y WooCommerce para el entorno QA bajo demanda.
// Contrato vigente: E0/E1. Procedencia: archive/plans-legacy-2026-09-13/2026-09-13-qa-bajo-demanda.md.
//
// Uso: SIM_DB=<snapshot anonimizado> [SIM_CERT=cert.pem SIM_KEY=key.pem] [SIM_PORT=8443] \
//      node scripts/qa/simulador-canales.mjs
//
// - Lee publicaciones y productos del snapshot (sólo lectura) y responde con esa forma.
// - Las escrituras (PUT/POST) nunca salen de acá: se responden con éxito y quedan registradas.
// - Control de pruebas:
//     GET  /__qa/llamadas         últimas llamadas recibidas
//     POST /__qa/fallas           {"ruta": "regex", "status": 429, "veces": 3}  inyecta fallas
//     DELETE /__qa/fallas         limpia fallas y registro
// - HTTPS si recibe certificado (el cliente Woo de la app exige https); si no, HTTP.
import http from 'http';
import https from 'https';
import fs from 'fs';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';

const MAX_LLAMADAS = 500;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function leerCuerpo(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch { resolve(s); } });
  });
}

function parse(v, porDefecto) {
  try { return v ? JSON.parse(v) : porDefecto; } catch { return porDefecto; }
}

export function crearDatos(db) {
  const filas = db.prepare('SELECT * FROM ml_publicaciones_cache ORDER BY item_id, variation_id').all();
  const items = new Map();
  for (const f of filas) {
    let it = items.get(f.item_id);
    if (!it) {
      it = {
        id: f.item_id, title: f.titulo, status: f.status || 'active',
        sub_status: parse(f.sub_status, f.sub_status ? [f.sub_status] : []),
        price: f.precio ?? 0, available_quantity: 0, seller_custom_field: f.seller_custom_field ?? null,
        permalink: f.permalink, thumbnail: f.thumbnail, secure_thumbnail: f.thumbnail,
        catalog_listing: !!f.catalogo, catalog_product_id: f.catalog_product_id ?? null,
        user_product_id: f.user_product_id ?? null, channels: parse(f.canales_json, ['marketplace']),
        attributes: f.es_variante ? [] : parse(f.atributos_json, []), variations: [],
      };
      items.set(f.item_id, it);
    }
    if (f.es_variante && f.variation_id) {
      const combinaciones = [];
      if (f.color) combinaciones.push({ id: 'COLOR', name: 'Color', value_name: f.color });
      if (f.talle) combinaciones.push({ id: 'SIZE', name: 'Talle', value_name: f.talle });
      it.variations.push({
        id: Number(f.variation_id) || f.variation_id, price: f.precio ?? it.price,
        available_quantity: f.available_quantity ?? 0, seller_custom_field: f.seller_custom_field ?? null,
        attribute_combinations: combinaciones, attributes: parse(f.atributos_json, []),
        user_product_id: f.user_product_id ?? null,
      });
    } else {
      it.available_quantity = f.available_quantity ?? 0;
    }
  }
  for (const it of items.values()) {
    if (it.variations.length) it.available_quantity = it.variations.reduce((s, v) => s + (v.available_quantity || 0), 0);
  }

  const productos = db.prepare('SELECT * FROM catalogo_cache').all();
  const porId = new Map();
  const hijos = new Map();
  for (const p of productos) {
    const prod = {
      id: p.id_woo, name: p.nombre, sku: p.sku || '', type: p.tipo || 'simple', parent_id: p.id_padre || 0,
      stock_quantity: p.stock, manage_stock: p.no_contable ? false : true,
      stock_status: (p.stock ?? 0) > 0 ? 'instock' : 'outofstock',
      price: String(p.precio ?? ''), regular_price: String(p.regular_price ?? p.precio ?? ''), sale_price: '',
      categories: parse(p.categorias_json, []), attributes: parse(p.atributos_json, []),
      images: p.img ? [{ src: p.img }] : [], global_unique_id: p.gtin || '',
      date_modified_gmt: p.actualizado_en,
    };
    porId.set(prod.id, prod);
    if (prod.parent_id) {
      if (!hijos.has(prod.parent_id)) hijos.set(prod.parent_id, []);
      hijos.get(prod.parent_id).push(prod);
    }
  }
  return { items, productos: porId, variaciones: hijos };
}

function paginar(lista, url, porPaginaDefecto = 10) {
  const perPage = Math.min(Number(url.searchParams.get('per_page')) || porPaginaDefecto, 100);
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
  return { pagina: lista.slice((page - 1) * perPage, page * perPage), total: lista.length, paginas: Math.max(Math.ceil(lista.length / perPage), 1) };
}

export function crearSimulador({ db, cert, key, reloj = () => new Date() } = {}) {
  const datos = crearDatos(db);
  const llamadas = [];
  let fallas = [];
  let siguienteOrdenWoo = 900000;

  function registrar(req, url, cuerpo, status) {
    llamadas.push({ en: reloj().toISOString(), metodo: req.method, ruta: url.pathname + url.search, cuerpo, status });
    if (llamadas.length > MAX_LLAMADAS) llamadas.shift();
  }

  function fallaPara(ruta) {
    const f = fallas.find(x => x.veces > 0 && new RegExp(x.ruta).test(ruta));
    if (!f) return null;
    f.veces -= 1;
    return f;
  }

  function woo(req, res, url, cuerpo) {
    const p = url.pathname.replace(/^\/wp-json\/wc\/v3/, '');
    const headersPaginado = (r) => ({ 'x-wp-total': String(r.total), 'x-wp-totalpages': String(r.paginas) });
    let m;
    if (p === '/products' && req.method === 'GET') {
      const lista = [...datos.productos.values()].filter(x => !x.parent_id);
      const r = paginar(lista, url);
      res.writeHead(200, { 'content-type': 'application/json', ...headersPaginado(r) });
      return res.end(JSON.stringify(r.pagina));
    }
    if ((m = p.match(/^\/products\/(\d+)\/variations$/)) && req.method === 'GET') {
      const r = paginar(datos.variaciones.get(Number(m[1])) || [], url);
      res.writeHead(200, { 'content-type': 'application/json', ...headersPaginado(r) });
      return res.end(JSON.stringify(r.pagina));
    }
    if ((m = p.match(/^\/products\/(\d+)(?:\/variations\/(\d+))?$/))) {
      const prod = datos.productos.get(Number(m[2] || m[1]));
      if (!prod) return json(res, 404, { code: 'woocommerce_rest_product_invalid_id', message: 'ID no válido.' });
      if (req.method === 'GET') return json(res, 200, prod);
      return json(res, 200, { ...prod, ...(cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) });
    }
    if (p === '/orders' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': '0', 'x-wp-totalpages': '1' });
      return res.end('[]');
    }
    if (p === '/orders' && req.method === 'POST') {
      siguienteOrdenWoo += 1;
      return json(res, 201, { id: siguienteOrdenWoo, status: cuerpo?.status || 'processing', ...(cuerpo || {}) });
    }
    if (/^\/orders\/\d+\/notes$/.test(p)) return json(res, 201, { id: Date.now(), note: cuerpo?.note || '' });
    if ((m = p.match(/^\/orders\/(\d+)$/))) {
      if (req.method === 'GET') return json(res, 404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'ID no válido.' });
      return json(res, 200, { id: Number(m[1]), ...(cuerpo || {}) });
    }
    if (p.startsWith('/webhooks')) return req.method === 'GET' ? json(res, 200, []) : json(res, 201, { id: 1, ...(cuerpo || {}) });
    return json(res, 404, { code: 'rest_no_route', message: `Ruta no simulada: ${p}` });
  }

  function ml(req, res, url, cuerpo) {
    const p = url.pathname;
    let m;
    if (p === '/oauth/token') return json(res, 200, { access_token: 'APP_USR-QA', refresh_token: 'TG-QA', expires_in: 21600, token_type: 'bearer' });
    if (p === '/items' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      return json(res, 200, ids.map(id => {
        const it = datos.items.get(id);
        return it ? { code: 200, body: it } : { code: 404, body: { error: 'not_found', message: `Item ${id} not found` } };
      }));
    }
    if ((m = p.match(/^\/items\/([A-Z]{3}\d+)\/variations\/(\d+)$/))) {
      const v = datos.items.get(m[1])?.variations.find(x => String(x.id) === m[2]);
      if (!v) return json(res, 404, { error: 'not_found' });
      return json(res, 200, req.method === 'GET' ? v : { ...v, ...(cuerpo || {}) });
    }
    if ((m = p.match(/^\/items\/([A-Z]{3}\d+)$/))) {
      const it = datos.items.get(m[1]);
      if (!it) return json(res, 404, { error: 'not_found', message: `Item ${m[1]} not found` });
      return json(res, 200, req.method === 'GET' ? it : { ...it, ...(cuerpo || {}) });
    }
    if ((m = p.match(/^\/users\/[^/]+\/items\/search$/))) {
      const ids = [...datos.items.keys()];
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const scroll = url.searchParams.get('search_type') === 'scan';
      const desde = scroll ? Number(url.searchParams.get('scroll_id') || 0) : offset;
      const results = ids.slice(desde, desde + limit);
      return json(res, 200, { results, paging: { total: ids.length, offset: desde, limit }, scroll_id: scroll && results.length ? String(desde + limit) : null });
    }
    if (p === '/orders/search') return json(res, 200, { results: [], paging: { total: 0, offset: 0, limit: 50 } });
    if (/^\/(orders|shipments|packs|claims)\//.test(p) || p.startsWith('/post-purchase/v1/claims/')) {
      if (p.endsWith('/search')) return json(res, 200, { data: [], results: [], paging: { total: 0 } });
      return json(res, 404, { error: 'not_found' });
    }
    if (p === '/questions/search') return json(res, 200, { questions: [], total: 0 });
    if (p.startsWith('/messages')) return json(res, 200, { results: [], messages: [], paging: { total: 0 } });
    if (/^\/sites\/[^/]+\/listing_prices$/.test(p)) return json(res, 200, []);
    if (/^\/users\/[^/]+\/shipping_options\/free$/.test(p)) return json(res, 200, { coverage: { all_country: { list_cost: 0 } } });
    return json(res, 404, { error: 'not_found', message: `Ruta no simulada: ${p}` });
  }

  async function manejar(req, res) {
    const url = new URL(req.url, 'http://simulador');
    const cuerpo = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await leerCuerpo(req) : null;

    if (url.pathname === '/__qa/llamadas') return json(res, 200, llamadas);
    if (url.pathname === '/__qa/fallas') {
      if (req.method === 'DELETE') { fallas = []; llamadas.length = 0; return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && cuerpo?.ruta && cuerpo?.status) {
        try { new RegExp(cuerpo.ruta); } catch { return json(res, 400, { error: 'regex inválida' }); }
        fallas.push({ ruta: cuerpo.ruta, status: Number(cuerpo.status), veces: Number(cuerpo.veces) || 1, retryAfter: cuerpo.retryAfter });
        return json(res, 201, { ok: true, fallas });
      }
      return json(res, 200, fallas);
    }

    const ruta = url.pathname + url.search;
    const falla = fallaPara(ruta);
    if (falla) {
      registrar(req, url, cuerpo, falla.status);
      const headers = { 'content-type': 'application/json' };
      if (falla.retryAfter) headers['retry-after'] = String(falla.retryAfter);
      res.writeHead(falla.status, headers);
      return res.end(JSON.stringify({ error: 'qa_falla_inyectada', status: falla.status }));
    }

    const original = res.writeHead.bind(res);
    res.writeHead = (status, ...resto) => { registrar(req, url, cuerpo, status); return original(status, ...resto); };
    if (url.pathname.startsWith('/wp-json/wc/v3/')) return woo(req, res, url, cuerpo);
    if (url.pathname.startsWith('/wp-json/')) return json(res, 503, { code: 'qa_no_disponible', message: 'Servicio de WordPress no simulado' });
    return ml(req, res, url, cuerpo);
  }

  const handler = (req, res) => { manejar(req, res).catch(e => json(res, 500, { error: 'simulador', message: e.message })); };
  return cert && key ? https.createServer({ cert, key }, handler) : http.createServer(handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.env.SIM_DB;
  if (!dbPath) { console.error('Falta SIM_DB (snapshot anonimizado)'); process.exit(2); }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const cert = process.env.SIM_CERT ? fs.readFileSync(process.env.SIM_CERT) : null;
  const key = process.env.SIM_KEY ? fs.readFileSync(process.env.SIM_KEY) : null;
  const puerto = Number(process.env.SIM_PORT) || 8443;
  crearSimulador({ db, cert, key }).listen(puerto, '0.0.0.0', () => {
    console.log(`simulador de canales en ${cert ? 'https' : 'http'}://0.0.0.0:${puerto}`);
  });
}
