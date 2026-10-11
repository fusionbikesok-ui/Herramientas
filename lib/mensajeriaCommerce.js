import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { precioContado } from './mlPrecios.js';

const HOUR = 60 * 60 * 1000;
const DIRECTORY_TTL = 30 * 1000;
const CATALOG_TTL = 5 * 1000;
const DIRECTORY_PATH = '/opt/fusion-management-migration/directory-cache/directory.sqlite';
const TRACKING_URL = 'https://www.andreani.com/envio/';
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = (value, limit = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit).trim();
const validId = value => /^[1-9]\d{0,14}$/.test(String(value)) && Number.isSafeInteger(Number(value));

export class CommerceError extends Error {
  constructor(message, status = 503, code = 'commerce_unavailable') {
    super(message); this.status = status; this.code = code;
  }
}

// Exact identity only. A local Argentine number must include its complete area code;
// a domestic mobile prefix 15 without an unambiguous area code is not guessed.
export function canonicalPhone(value, country = 'AR') {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 64 || !/^\+?[\d\s().-]+$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  const international = raw.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits || digits.startsWith('0') && international) return '';
  if ((international || country === 'AR') && /^549[1-9]\d{9}$/.test(digits)) return '54' + digits.slice(3);
  if ((international || country === 'AR') && /^54[1-9]\d{9}$/.test(digits)) return digits;
  if (international) {
    if (digits.startsWith('54')) return '';
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
  }
  if (country !== 'AR') return '';
  if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) && !/^(0|15)/.test(digits) ? '54' + digits : '';
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['fusionbikes.com.ar', 'www.fusionbikes.com.ar'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname.startsWith('/wp-content/uploads/') && /\.(jpe?g|png|webp|gif|avif)$/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

function attributes(value) {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  // Catalog timestamps may be SQLite UTC timestamps; Woo directory dates already use Z.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function ageOf(value, now) {
  const ms = timestamp(value);
  return ms === null || ms > now + 5 * 60 * 1000 ? Infinity : Math.max(0, now - ms);
}

function fingerprint(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('not_file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export function createCommerce(db, { directoryPath = process.env.INBOX_DIRECTORY_PATH || DIRECTORY_PATH, now = Date.now } = {}) {
  let catalog = null, catalogExpires = 0, directory = null;

  function readCatalog() {
    if (catalog && now() < catalogExpires) return catalog;
    try {
      const rows = db.prepare(`SELECT id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en,img,precio,
        atributos_json,marca,gtin FROM catalogo_cache`).all();
      const byId = new Map(rows.filter(row => validId(row.id_woo)).map(row => [Number(row.id_woo), row]));
      const sellable = rows.filter(row => validId(row.id_woo) && ['simple', 'variation'].includes(row.tipo));
      let updatedAt = null;
      for (const row of sellable) if (timestamp(row.actualizado_en) > (timestamp(updatedAt) ?? 0)) updatedAt = row.actualizado_en;
      const searchable = sellable.map(row => {
        const parent = byId.get(Number(row.id_padre));
        return { row, parent, text: normalize([row.nombre,row.sku,row.gtin,row.marca,row.atributos_json,parent?.nombre,parent?.sku,parent?.gtin].join(' ')) };
      });
      catalog = { byId, searchable, updatedAt }; catalogExpires = now() + CATALOG_TTL;
      return catalog;
    } catch { throw new CommerceError('El catálogo local no está disponible.'); }
  }

  function productView(row, parent) {
    const price = finite(row.precio);
    const productId = Number(row.id_woo), parentId = Number(row.id_padre);
    const variation = row.tipo === 'variation' ? attributes(row.atributos_json).slice(0, 10)
      .map(attr => [clean(attr?.name, 80), clean(attr?.option, 100)].filter(Boolean).join(': ')).filter(Boolean).join(' · ') : '';
    return {
      id: productId, name: clean(row.nombre, 500), sku: clean(row.sku, 150), variation,
      image: imageUrl(row.img) || imageUrl(parent?.img),
      // This is the vigente Woo price, including offers; regular_price is only used by ML policy.
      price: price !== null && price >= 0 ? precioContado(price) : null,
      stock: finite(row.stock), url: `https://fusionbikes.com.ar/?p=${row.tipo === 'variation' && validId(parentId) ? parentId : productId}`,
      updated_at: clean(row.actualizado_en, 50) || null,
    };
  }

  function products(query, stock = 'all') {
    if (!['all', 'instock', 'outofstock'].includes(stock)) throw new CommerceError('Filtro de stock inválido.', 400, 'invalid_stock');
    if (typeof query !== 'string' || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query))
      throw new CommerceError('Usá una búsqueda de hasta 100 caracteres.', 400, 'invalid_query');
    const q = normalize(query), source = readCatalog();
    const status = { ok: true, updated_at: source.updatedAt, stale: ageOf(source.updatedAt, now()) > HOUR };
    if (q.length < 2) return { ...status, products: [], more: false };
    const tokens = q.split(/\s+/).filter(Boolean);
    const rank = (row, parent) => [row.sku, row.gtin].some(value => normalize(value) === q) ? 2
      : [parent?.sku, parent?.gtin].some(value => value && normalize(value) === q) ? 1 : 0;
    const matches = source.searchable.filter(item => (stock === 'all' || finite(item.row.stock) !== null && (stock === 'instock' ? item.row.stock > 0 : item.row.stock <= 0))
      && (rank(item.row, item.parent) || tokens.every(token => item.text.includes(token))));
    matches.sort((a, b) => rank(b.row, b.parent) - rank(a.row, a.parent)
      || String(a.row.nombre).localeCompare(String(b.row.nombre), 'es') || Number(a.row.id_woo) - Number(b.row.id_woo));
    return { ...status, products: matches.slice(0, 30).map(item => productView(item.row, item.parent)), more: matches.length > 30 };
  }

  function product(id) {
    if (!validId(id)) throw new CommerceError('Producto inválido.', 400, 'invalid_product');
    const source = readCatalog(), row = source.byId.get(Number(id));
    if (!row || !['simple', 'variation'].includes(row.tipo)) throw new CommerceError('El producto no figura en el catálogo local.', 404, 'product_not_found');
    return productView(row, source.byId.get(Number(row.id_padre)));
  }

  function readDirectory() {
    try {
      let stamp = fingerprint(directoryPath);
      if (directory && stamp === directory.stamp && now() < directory.expires) return directory;
      // Reopen on publication. Never keep a connection pointing at yesterday's replaced inode.
      for (let attempt = 0; attempt < 2; attempt++) {
        const source = new Database(directoryPath, { readonly: true, fileMustExist: true });
        let snapshot;
        try {
          snapshot = source.transaction(() => {
            const state = Object.fromEntries(source.prepare('SELECT key,value FROM state').all().map(row => [row.key, JSON.parse(row.value)]));
            const byPhone = new Map(); let count = 0;
            for (const row of source.prepare('SELECT id,data FROM orders').iterate()) {
              if (++count > 100000) throw new Error('directory_limit');
              const order = JSON.parse(row.data);
              if (!validId(order?.id) || Number(row.id) !== Number(order.id)) throw new Error('order_identity');
              const phone = canonicalPhone(order.billing?.phone, order.billing?.country || 'AR');
              if (!phone) continue;
              const list = byPhone.get(phone) || [];
              list.push(order); byPhone.set(phone, list);
            }
            for (const list of byPhone.values()) list.sort((a, b) => (timestamp(b.created_at) || 0) - (timestamp(a.created_at) || 0) || Number(b.id) - Number(a.id));
            return { byPhone, state };
          })();
        } finally { source.close(); }
        const current = fingerprint(directoryPath);
        if (stamp === current) {
          directory = { ...snapshot, stamp, expires: now() + DIRECTORY_TTL };
          return directory;
        }
        stamp = current;
      }
      throw new Error('directory_changed');
    } catch {
      directory = null;
      throw new CommerceError('La copia de pedidos no está disponible. Volvé a intentar después de sincronizar.', 503, 'directory_unavailable');
    }
  }

  function directoryStatus(source) {
    const updatedAt = source.state.orders_at || source.state.completed_at || null;
    return { updated_at: updatedAt, stale: ageOf(updatedAt, now()) > HOUR,
      complete: source.state.orders_complete === true, source: 'woocommerce_local' };
  }

  function tracking(order) {
    const orderId = typeof order === 'object' ? order?.id : order;
    if (!validId(orderId)) return [];
    try {
      const rows = db.prepare(`SELECT tracking FROM preparaciones WHERE wc_order_id=? AND canal='web'
        AND COALESCE(woo_paso1_incierto,0)=0 AND COALESCE(woo_paso2_pendiente,0)=0
        AND COALESCE(tracking,'')<>'' ORDER BY id DESC LIMIT 20`).all(Number(orderId));
      const numbers = [...new Set(rows.map(row => String(row.tracking ?? '').trim()).filter(value => /^[\d\s.-]+$/.test(value)).map(value => value.replace(/[\s.-]/g, '')).filter(value => /^\d{6,40}$/.test(value)))];
      return numbers.map(number => ({ carrier: 'Andreani', number, url: TRACKING_URL + encodeURIComponent(number) }));
    } catch { return []; }
  }

  function orderView(order, phone) {
    const items = (Array.isArray(order.items) ? order.items : []).slice(0, 20).map(item => ({
      name: clean(item.name, 250), quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
    }));
    return {
      id: Number(order.id), number: clean(order.number || order.id, 50), phone,
      customer_name: clean([order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' '), 200),
      created_at: clean(order.created_at, 50), status: clean(order.status, 60), total: clean(order.total, 40),
      currency: /^[A-Z]{3}$/.test(String(order.currency)) ? order.currency : '', items,
      last_items: items.slice(0, 3).map(item => item.name), invoice_available: null, tracking: tracking(order),
    };
  }

  function checkedPhone(value) {
    const phone = canonicalPhone(value);
    if (!phone) throw new CommerceError('Falta un teléfono completo válido para buscar los pedidos.', 400, 'invalid_phone');
    return phone;
  }

  function orders(value) {
    const phone = checkedPhone(value), source = readDirectory(), status = directoryStatus(source);
    const list = source.byPhone.get(phone) || [];
    return { ok: true, phone, orders: list.slice(0, 50).map(order => orderView(order, phone)), total: list.length, more: list.length > 50, ...status };
  }

  function orderForPhone(value, id) {
    const phone = checkedPhone(value);
    if (!validId(id)) throw new CommerceError('Pedido inválido.', 400, 'invalid_order');
    const source = readDirectory(), status = directoryStatus(source);
    if (!status.complete || ageOf(status.updated_at, now()) > 24 * HOUR)
      throw new CommerceError('La copia de pedidos necesita una sincronización completa antes de compartir datos del pedido.', 503, 'directory_stale');
    const order = (source.byPhone.get(phone) || []).find(item => Number(item.id) === Number(id));
    if (!order) throw new CommerceError('No hay un pedido asociado a ese teléfono.', 404, 'order_not_found');
    return orderView(order, phone);
  }

  return { products, product, orders, orderForPhone, tracking };
}
