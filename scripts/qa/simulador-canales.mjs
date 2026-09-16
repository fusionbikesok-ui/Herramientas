// Simulador de MercadoLibre y WooCommerce para el entorno QA bajo demanda y los barridos de E1 T2.
// Contrato vigente: E0/E1. Procedencia: archive/plans-legacy-2026-09-13/2026-09-13-qa-bajo-demanda.md.
//
// Uso: SIM_DB=<snapshot anonimizado> [SIM_CERT=cert.pem SIM_KEY=key.pem] [SIM_PORT=8443] \
//      node scripts/qa/simulador-canales.mjs
//
// - Lee publicaciones y productos del snapshot (sólo lectura) y responde con esa forma.
// - E1 T2 pasa `crearSimulador({ fixture, reloj })`: datos en memoria (órdenes, envíos, preguntas,
//   reclamos, mensajes, items, pedidos y productos Woo), sin SQLite ni configuración por HTTP.
//   `fixture.alLlamar({metodo, ruta, n}, datos)` muta los datos vivos entre páginas de forma determinista.
// - Las escrituras (PUT/POST) nunca salen de acá: se responden con éxito y quedan registradas.
// - Control de pruebas (plano de control, no cuenta como llamada de canal):
//     GET  /__qa/llamadas         últimas llamadas recibidas (con headers no sensibles)
//     POST /__qa/fallas           {"ruta": "regex", "status": 429, "veces": 3, "retryAfter": 30}
//                                 o {"ruta": "regex", "modo": "cortar"|"cortar-despues"} o {"ruta", "demoraMs"}
//     DELETE /__qa/fallas         limpia fallas y registro
// - HTTPS si recibe certificado (el cliente Woo de la app exige https); si no, HTTP.
import http from 'http';
import https from 'https';
import fs from 'fs';
import { pathToFileURL } from 'url';

const MAX_LLAMADAS = 500;
// Nunca se registra Authorization ni cookies: sólo headers que las pruebas necesitan verificar.
const HEADERS_REGISTRADOS = ['x-format-new', 'x-fusion-plano'];

function json(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extra });
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

function coleccionesVacias() {
  return {
    ordenesMl: [], envios: new Map(), preguntas: new Map(), reclamos: new Map(),
    noLeidos: [], packs: new Map(), ordenesWoo: [],
  };
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
  return { items, productos: porId, variaciones: hijos, ...coleccionesVacias() };
}

function porId(lista = []) {
  return new Map(lista.map(x => [String(x.id), x]));
}

function datosDesdeFixture(fixture) {
  const ml = fixture.ml ?? {};
  const woo = fixture.woo ?? {};
  const productos = new Map();
  const variaciones = new Map();
  for (const p of woo.products ?? []) {
    productos.set(Number(p.id), p);
    const padre = Number(p.parent_id) || 0;
    if (padre) {
      if (!variaciones.has(padre)) variaciones.set(padre, []);
      variaciones.get(padre).push(p);
    }
  }
  return {
    items: porId(ml.items), productos, variaciones,
    ordenesMl: ml.orders ?? [], envios: porId(ml.shipments), preguntas: porId(ml.questions),
    reclamos: porId(ml.claims), noLeidos: ml.unread ?? [],
    packs: new Map(Object.entries(ml.packs ?? {})), ordenesWoo: woo.orders ?? [],
  };
}

function paginar(lista, url, porPaginaDefecto = 10) {
  const perPage = Math.min(Number(url.searchParams.get('per_page')) || porPaginaDefecto, 100);
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
  return { pagina: lista.slice((page - 1) * perPage, page * perPage), total: lista.length, paginas: Math.max(Math.ceil(lista.length / perPage), 1) };
}

function offsetLimit(url, limiteDefecto = 50, maximo = 50) {
  return {
    offset: Math.max(Number(url.searchParams.get('offset')) || 0, 0),
    limit: Math.min(Number(url.searchParams.get('limit')) || limiteDefecto, maximo),
  };
}

// Woo guarda `*_gmt` sin zona; se interpreta como UTC.
const msGmt = v => Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);

export function crearSimulador({ db, fixture, cert, key, reloj = () => new Date() } = {}) {
  const datos = fixture ? datosDesdeFixture(fixture) : crearDatos(db);
  const llamadas = [];
  let fallas = [];
  let siguienteOrdenWoo = 900000;
  let contador = 0;

  function registrar(req, url, cuerpo, status) {
    const headers = {};
    for (const h of HEADERS_REGISTRADOS) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
    llamadas.push({ en: reloj().toISOString(), metodo: req.method, ruta: url.pathname + url.search, cuerpo, status, headers });
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
    // Semántica de `status` de Woo: por defecto `any`, y `any` NO incluye `trash` (el legado depende de
    // esa exclusión: ver routes/sync.js y routes/woo.js). Un valor explícito, o una lista, filtra.
    const porEstado = () => {
      const pedidos = (url.searchParams.get('status') || 'any').split(',').map(s => s.trim()).filter(Boolean);
      return (x) => (pedidos.includes('any') ? x.status !== 'trash' : pedidos.includes(x.status));
    };
    let m;
    if (p === '/products' && req.method === 'GET') {
      // Mismos filtros que el controlador real: sin esto un barrido incremental recibiría todo el
      // catálogo en cada ventana y la prueba no distinguiría un adaptador que consulta de más.
      const despues = url.searchParams.get('modified_after');
      const antes = url.searchParams.get('modified_before');
      const lista = [...datos.productos.values()]
        .filter(x => !x.parent_id)
        .filter(x => (!despues || msGmt(x.date_modified_gmt) > Date.parse(despues))
          && (!antes || msGmt(x.date_modified_gmt) < Date.parse(antes)))
        .filter(porEstado())
        .sort((a, b) => Number(a.id) - Number(b.id));
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
      const despues = url.searchParams.get('modified_after');
      const antes = url.searchParams.get('modified_before');
      const lista = datos.ordenesWoo
        .filter(o => (!despues || msGmt(o.date_modified_gmt) > Date.parse(despues)) && (!antes || msGmt(o.date_modified_gmt) < Date.parse(antes)))
        .filter(porEstado())
        .sort((a, b) => msGmt(a.date_modified_gmt) - msGmt(b.date_modified_gmt) || Number(a.id) - Number(b.id));
      const r = paginar(lista, url);
      res.writeHead(200, { 'content-type': 'application/json', ...headersPaginado(r) });
      return res.end(JSON.stringify(r.pagina));
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
    // missed_feeds: forma NO verificada por sonda (ver plataforma/src/reconciliacion/missed-feeds.ts).
    // `fixture.ml.missedFeeds` es la lista completa; `fixture.ml.missedFeedsForma` puede romper la forma.
    if (p === '/missed_feeds' && req.method === 'GET') {
      const topic = url.searchParams.get('topic');
      if (topic === 'items' && !url.searchParams.get('site_id') && fixture?.ml?.missedFeedsExigeSitio) return json(res, 400, { error: 'site_id requerido' });
      const todos = (fixture?.ml?.missedFeeds || []).filter(m => (m.topic === topic) || (topic === 'orders_v2' && m.topic === 'orders'));
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 50);
      if (fixture?.ml?.missedFeedsForma === 'rota') return json(res, 200, { results: todos.slice(offset, offset + limit) });
      return json(res, 200, { messages: todos.slice(offset, offset + limit), offset, limit, total: todos.length });
    }
    // Multiget verificado por sonda 2026-09-16: `{id, status_code, body}` por elemento. `fixture.ml.fallosBulk`
    // ({ id: status }) simula un fallo parcial de un elemento sin tirar el lote.
    if (p === '/items/bulk' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      return json(res, 200, ids.map(id => {
        const fallo = fixture?.ml?.fallosBulk?.[id];
        if (fallo) return { id, status_code: fallo, body: { error: 'simulado' } };
        const it = datos.items.get(id);
        return it ? { id, status_code: 200, body: it } : { id, status_code: 404, body: { error: 'not_found' } };
      }));
    }
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
    if (p === '/orders/search') {
      const desde = url.searchParams.get('order.date_last_updated.from');
      const hasta = url.searchParams.get('order.date_last_updated.to');
      const { offset, limit } = offsetLimit(url);
      const lista = datos.ordenesMl
        .filter(o => (!desde || Date.parse(o.date_last_updated) >= Date.parse(desde)) && (!hasta || Date.parse(o.date_last_updated) <= Date.parse(hasta)))
        .sort((a, b) => Date.parse(a.date_last_updated) - Date.parse(b.date_last_updated) || String(a.id).localeCompare(String(b.id)));
      if (url.searchParams.get('sort') === 'date_desc') lista.reverse();
      return json(res, 200, { results: lista.slice(offset, offset + limit), paging: { total: lista.length, offset, limit } });
    }
    if ((m = p.match(/^\/shipments\/([^/]+)$/)) && req.method === 'GET') {
      const s = datos.envios.get(decodeURIComponent(m[1]));
      return s ? json(res, 200, s) : json(res, 404, { error: 'not_found' });
    }
    if (p === '/post-purchase/v1/claims/search') {
      const estado = url.searchParams.get('status');
      const { offset, limit } = offsetLimit(url, 30, 100);
      const lista = [...datos.reclamos.values()].filter(c => !estado || c.status === estado);
      return json(res, 200, { data: lista.slice(offset, offset + limit), results: [], paging: { total: lista.length, offset, limit } });
    }
    if ((m = p.match(/^\/post-purchase\/v1\/claims\/([^/]+)$/)) && req.method === 'GET') {
      const c = datos.reclamos.get(decodeURIComponent(m[1]));
      return c ? json(res, 200, c) : json(res, 404, { error: 'not_found' });
    }
    if (/^\/(orders|shipments|packs|claims)\//.test(p) || p.startsWith('/post-purchase/v1/claims/')) {
      if (p.endsWith('/search')) return json(res, 200, { data: [], results: [], paging: { total: 0 } });
      return json(res, 404, { error: 'not_found' });
    }
    if (p === '/questions/search') {
      const estado = url.searchParams.get('status');
      const { offset, limit } = offsetLimit(url);
      const lista = [...datos.preguntas.values()].filter(q => !estado || q.status === estado);
      return json(res, 200, { questions: lista.slice(offset, offset + limit), total: lista.length, limit, offset });
    }
    if ((m = p.match(/^\/questions\/([^/]+)$/)) && req.method === 'GET') {
      const q = datos.preguntas.get(decodeURIComponent(m[1]));
      return q ? json(res, 200, q) : json(res, 404, { error: 'not_found' });
    }
    if (p === '/messages/unread') return json(res, 200, { results: datos.noLeidos, total: datos.noLeidos.length, messages: [], paging: { total: datos.noLeidos.length } });
    if ((m = p.match(/^\/messages\/packs\/([^/]+)\/sellers\/[^/]+$/)) && req.method === 'GET') {
      const mensajes = datos.packs.get(decodeURIComponent(m[1]));
      if (!mensajes && fixture) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { messages: mensajes ?? [], results: [], paging: { total: mensajes?.length ?? 0 } });
    }
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
      if (req.method === 'POST' && cuerpo?.ruta && (cuerpo?.status || cuerpo?.modo || cuerpo?.demoraMs)) {
        try { new RegExp(cuerpo.ruta); } catch { return json(res, 400, { error: 'regex inválida' }); }
        fallas.push({
          ruta: cuerpo.ruta, status: Number(cuerpo.status) || 0, veces: Number(cuerpo.veces) || 1,
          retryAfter: cuerpo.retryAfter, modo: cuerpo.modo, demoraMs: Number(cuerpo.demoraMs) || 0,
        });
        return json(res, 201, { ok: true, fallas });
      }
      return json(res, 200, fallas);
    }

    const ruta = url.pathname + url.search;
    contador += 1;
    fixture?.alLlamar?.({ metodo: req.method, ruta, n: contador }, datos);
    const falla = fallaPara(ruta);
    if (falla?.demoraMs) await new Promise(r => setTimeout(r, falla.demoraMs));
    if (falla?.modo === 'cortar') {
      registrar(req, url, cuerpo, 0);
      return req.socket.destroy();
    }
    if (falla?.modo === 'cortar-despues') {
      registrar(req, url, cuerpo, 200);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
      res.write('{"results":[');
      return setTimeout(() => req.socket.destroy(), 10);
    }
    if (falla?.status) {
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
  // Import diferido: el modo fixture (plataforma/) no necesita el binario nativo de SQLite.
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const cert = process.env.SIM_CERT ? fs.readFileSync(process.env.SIM_CERT) : null;
  const key = process.env.SIM_KEY ? fs.readFileSync(process.env.SIM_KEY) : null;
  const puerto = Number(process.env.SIM_PORT) || 8443;
  crearSimulador({ db, cert, key }).listen(puerto, '0.0.0.0', () => {
    console.log(`simulador de canales en ${cert ? 'https' : 'http'}://0.0.0.0:${puerto}`);
  });
}
