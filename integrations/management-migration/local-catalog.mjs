import http from 'node:http';

export class CatalogError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
const normalize = v => String(v ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const finite = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const array = v => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };

export function catalogImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(u.hostname)
      && !u.username && !u.password && !u.port && !u.search && !u.hash
      && u.pathname.startsWith('/wp-content/uploads/') && /\.(jpe?g|png|webp|gif)$/i.test(u.pathname) ? u.href : '';
  } catch { return ''; }
}

// Existing Herramientas display rule (including web offers), not ML's price list.
// Keep its policy in one place. This endpoint reads SQLite and never contacts Woo.
export function readLocalCash(product, cookie, port) {
  if (!product.sku || product.sku.length > 150) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = http.get({hostname:'127.0.0.1',port,path:'/api/consulta-precios/buscar?q='+encodeURIComponent(product.sku),
      headers:{cookie,accept:'application/json'},timeout:3000}, response => {
      let bytes=0;const chunks=[];
      response.on('data', b=>{bytes+=b.length;if(bytes>128*1024)request.destroy(new Error('price limit'));else chunks.push(b);});
      response.on('error',reject);
      response.on('end',()=>{
        try {
          const data=JSON.parse(Buffer.concat(chunks));const p=data.producto;
          if(response.statusCode!==200||data.ok!==true)throw new Error('local price');
          resolve(data.found===true && p?.id_woo===product.id && p.sku===product.sku
            && typeof p.precio==='number' && Number.isFinite(p.precio) && p.precio>=0 ? p.precio : null);
        } catch { reject(new CatalogError('No se pudo leer el precio al contado de Herramientas.')); }
      });
    });
    request.on('timeout',()=>request.destroy(new Error('price timeout')));request.on('error',reject);
  });
}

// Only these fixed, already existing local reads are available. No Woo client or credentials.
export function readLocalCatalog(cookie, port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/woo/catalogo',
      headers: { cookie, accept: 'application/json' }, timeout: 6000 }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) request.destroy(new CatalogError('El catálogo local excede el límite de consulta.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new CatalogError('No se pudo leer el catálogo de Herramientas.');
          const data = JSON.parse(Buffer.concat(chunks));
          if (data.ok !== true || !Array.isArray(data.data) || data.data.length > 50000) throw new Error('shape');
          if (data.data.some(p => !Number.isSafeInteger(p.id_woo) || p.id_woo < 1 || typeof p.nombre !== 'string')) throw new Error('rows');
          resolve(data.data);
        } catch (error) { reject(error instanceof CatalogError ? error : new CatalogError('El catálogo local no respondió en el formato esperado.')); }
      });
    });
    request.on('timeout', () => request.destroy(new CatalogError('El catálogo local tardó demasiado. Volvé a intentar.')));
    request.on('error', error => reject(error instanceof CatalogError ? error : new CatalogError('No se pudo consultar el catálogo local.')));
  });
}

export function catalogRoute(local) {
  const url = new URL(local, 'http://private.invalid');
  const route = url.searchParams.get('rest_route');
  if (route === '/fbpos/v2/search') return { module: 'pos', type: 'search', query: url.searchParams };
  if (/^\/fbpos\/v2\/product\/[1-9]\d*$/.test(route || '')) return { module: 'pos', type: 'product', id: Number(route.split('/').at(-1)), query: url.searchParams };
  if (route === '/fusion-taller/v1/products') return { module: 'taller', type: 'search', query: url.searchParams };
  if (route === '/fusion-arca/v1/products') return { module: 'facturador', type: 'search', query: url.searchParams };
  return null;
}

function product(row, exact = false, parent = null) {
  const stock = finite(row.stock);
  return { id: row.id_woo, name: row.nombre, sku: String(row.sku || ''), ean: String(row.gtin || ''),
    parent_id: row.id_padre || 0, variation: row.tipo === 'variation' ? array(row.atributos_json).map(a => `${a.name}: ${a.option}`).join(' · ') : '',
    stock, stock_quantity: stock, stock_status: 'unverified', in_stock: null,
    price: null, cents: null, selectable: false, exact, image: catalogImage(row.img) || catalogImage(parent?.img), image_fallbacks: [], coefficients: {}, dollar: 0, promo: false,
    _local: { source: 'catalogo_cache', updated_at: row.actualizado_en || null,
      reference_price: null, price_label: 'Contado / Transferencia · catálogo local', price_source:'herramientas_consulta_precios',
      availability_verified: false, commercial_price_verified: false, read_only: true } };
}

export function queryCatalog(rows, target) {
  const sellable = rows.filter(p => ['simple', 'variation'].includes(p.tipo));
  if (target.type === 'product') {
    const found = sellable.find(p => p.id_woo === target.id);
    if (!found) throw new CatalogError('El producto no figura en el catálogo local.', 404);
    return product(found, false, rows.find(p=>p.id_woo===found.id_padre));
  }
  const params = target.query;
  for (const key of ['q', 'page', 'stock', 'exact', 'include_out_of_stock']) {
    if (params.getAll(key).length > 1) throw new CatalogError('Parámetro repetido.', 400);
  }
  const q = String(params.get('q') || '').trim();
  if (q.length > 100 || /[\u0000-\u001f]/.test(q)) throw new CatalogError('Usá una búsqueda de hasta 100 caracteres.', 400);
  const pageText = params.get('page') || '1';
  if (!/^[1-9]\d{0,3}$/.test(pageText)) throw new CatalogError('Página inválida.', 400);
  const page = Number(pageText);
  const stockFilter = params.get('stock') || 'all';
  if (!['all', 'instock', 'outofstock'].includes(stockFilter)) throw new CatalogError('Filtro de stock inválido.', 400);
  const needle = normalize(q);
  const exactIds = new Set(rows.filter(p => needle && [p.sku, p.gtin].some(v => normalize(v) === needle)).map(p => p.id_woo));
  const words = needle.split(/\s+/).filter(Boolean);
  let matches = needle ? sellable.filter(p => {
    const isExact = exactIds.has(p.id_woo), parentExact = exactIds.has(p.id_padre);
    if (params.get('exact') === '1') return isExact || parentExact;
    const haystack = normalize([p.nombre, p.sku, p.gtin, p.marca, p.atributos_json].join(' '));
    return isExact || parentExact || (needle.length >= 2 && words.every(w => haystack.includes(w)));
  }) : [];
  const positiveOnly = target.module === 'pos' ? params.get('include_out_of_stock') !== '1' && params.get('exact') !== '1' : stockFilter === 'instock';
  if (positiveOnly) matches = matches.filter(p => finite(p.stock) !== null && p.stock > 0);
  if (target.module === 'facturador' && stockFilter === 'outofstock') matches = matches.filter(p => finite(p.stock) !== null && p.stock <= 0);
  matches.sort((a, b) => Number(exactIds.has(b.id_woo)) - Number(exactIds.has(a.id_woo)) || a.nombre.localeCompare(b.nombre, 'es') || a.id_woo - b.id_woo);
  const limit = target.module === 'pos' ? 60 : target.module === 'taller' ? 30 : 20;
  const offset = target.module === 'facturador' ? (page - 1) * limit : 0;
  const parents = new Map(rows.filter(p=>p.tipo==='variable').map(p=>[p.id_woo,p]));
  const output = matches.slice(offset, offset + limit).map(p => product(p, exactIds.has(p.id_woo),parents.get(p.id_padre)));
    return target.module === 'pos' ? output : { rows: output, page, limit, has_more: matches.length > offset + limit, local_catalog: true };
}

export function createLocalCatalog({ port, read = readLocalCatalog, readCash = readLocalCash, now = Date.now, ttl = 5000 }) {
  let cache = null, expires = 0, loading = null, prices = new Map();
  return async (target, cookie) => {
    if (!cache || now() >= expires) {
      if (!loading) loading = read(cookie, port).then(rows => { cache = rows; prices = new Map(); expires = now() + ttl; return rows; }).finally(() => { loading = null; });
      await loading;
    }
    const result=queryCatalog(cache, target);
    const products=Array.isArray(result)?result:result.rows||[result];
    const priceCache=prices;let next=0;
    await Promise.all(Array.from({length:Math.min(4,products.length)},async()=>{
      while(next<products.length){
        const p=products[next++];
        if(!priceCache.has(p.id))priceCache.set(p.id,Promise.resolve().then(()=>readCash(p,cookie,port)).catch(()=>null));
        p._local.reference_price=finite(await priceCache.get(p.id));
        // POS can use the synchronized row to prepare a checkout.  The origin
        // checkout still revalidates price and stock before any order is made.
        if (target.module === 'pos') {
          p.price = p._local.reference_price;
          p.cents = p.price === null ? null : Math.round(p.price * 100);
          p.selectable = p.price !== null && p.stock !== null && p.stock > 0;
          p.stock_status = p.stock !== null && p.stock > 0 ? 'instock' : 'outofstock';
          p.in_stock = p.selectable;
          p._local.pos_checkout_ready = p.selectable;
        }
      }
    }));
    return result;
  };
}
