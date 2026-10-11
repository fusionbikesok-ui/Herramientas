import sharp from 'sharp';

const counts = [6, 9, 12, 18, 24];
const failure = (code, message, status = 502) => Object.assign(new Error(message), { code, status });
const idValid = id => /^[1-9]\d{0,14}$/.test(String(id)) && Number.isSafeInteger(Number(id));
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit).trim();
const amount = value => typeof value === 'string' && /^\d{1,12}(\.\d{1,10})?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const money = value => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value);

export function productMessage(product, quote) {
  const detail = [product.name, product.variation, product.url,
    `💰 *Contado / transferencia:* ${money(quote.cash)}`].filter(Boolean).join('\n');
  const plans = quote.installments.map(p => `• ${p.count} cuotas de ${money(p.amount)}`).join('\n');
  return [detail, '💳 *Elegí cómo pagar*\nAceptamos tarjetas bancarizadas y no bancarizadas.', plans,
    ...(quote.free_shipping ? ['🚚 *Envío gratis*'] : [])].join('\n\n');
}

export function productImageUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['fusionbikes.com.ar', 'www.fusionbikes.com.ar'].includes(u.hostname)
      && !u.port && !u.username && !u.password && !u.search && !u.hash
      && u.pathname.startsWith('/wp-content/uploads/') && /\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname) ? u.href : '';
  } catch { return ''; }
}

async function bounded(response, max) {
  if (!response.ok || Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel(); throw new Error('response');
  }
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; if (size > max) throw new Error('limit'); parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

export function createProductSource({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const quotes = new Map(), images = new Map(), inFlight = new Map(); let converting = 0;
  async function quote(product) {
    if (!idValid(product.id)) throw failure('invalid_product', 'Elegí un producto válido.', 400);
    const key = `${product.id}:${product.sku}`;
    const saved = quotes.get(key); if (saved && saved.expires > now()) return saved.data;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 8) throw failure('quote_busy', 'Estamos consultando precios. Volvé a intentar en unos segundos.', 429);
    const job = Promise.resolve().then(async () => {
      try {
        const base = new URL(env.WOO_URL);
        if (base.protocol !== 'https:' || !['fusionbikes.com.ar', 'www.fusionbikes.com.ar'].includes(base.hostname) || base.port || base.username || base.password || !env.WOO_CK || !env.WOO_CS) throw new Error('config');
        const url = new URL(`/wp-json/wc/v3/fusion-herramientas/commercial-products?ids=${product.id}`, base);
        const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${env.WOO_CK}:${env.WOO_CS}`).toString('base64') }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        const body = JSON.parse((await bounded(response, 128 * 1024)).toString('utf8'));
        const p = body.items?.[0];
        if (body.schema !== 1 || body.currency !== 'ARS' || body.items?.length !== 1 || !p || p.state !== 'ok' || p.source !== 'master_control_pricing_engine' || Number(p.id) !== product.id || String(p.sku || '') !== String(product.sku || '') || p.quantity !== 1 || !Array.isArray(p.plans) || p.plans.length > 20) throw new Error('identity');
        const cash = amount(p.base_amount);
        if (cash === null || cash <= 0 || typeof p.free_shipping !== 'boolean') throw new Error('price');
        const installments = counts.map(count => {
          const found = p.plans.filter(x => x.plan === String(count));
          if (found.length !== 1) throw new Error('plan');
          const per = amount(found[0].installment_amount);
          if (per === null || per <= 0) throw new Error('installment');
          return { count, amount: per };
        });
        const data = { cash, installments, free_shipping: p.free_shipping, name: clean(p.name, 500), quoted_at: body.generated_at };
        if (quotes.size >= 100) quotes.delete(quotes.keys().next().value);
        quotes.set(key, { data, expires: now() + 60000 }); return data;
      } catch { throw failure('product_quote_unavailable', 'No se pudieron verificar las cuotas actuales de la tienda. Volvé a intentar.'); }
      finally { inFlight.delete(key); }
    });
    inFlight.set(key, job); return job;
  }
  async function photo(product) {
    if (!product.image) return null;
    const url = productImageUrl(product.image);
    if (!url) throw failure('product_image_unavailable', 'La foto del producto no está disponible.');
    const saved = images.get(url); if (saved && saved.expires > now()) return { ...saved.media, name: `Producto-${product.sku || product.id}.jpg` };
    if (converting >= 2) throw failure('image_busy', 'Hay otras fotos en preparación. Volvé a intentar en unos segundos.', 429);
    converting++;
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'image/*' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      const bytes = await bounded(response, 8 * 1024 * 1024);
      const input = sharp(bytes, { limitInputPixels: 25_000_000, pages: 1, failOn: 'warning' });
      const metadata = await input.metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'heif', 'avif'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('format');
      const jpeg = await input.rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      if (jpeg.length > 2 * 1024 * 1024) throw new Error('output');
      const media = { mime: 'image/jpeg', data_base64: jpeg.toString('base64') };
      if (images.size >= 40) images.delete(images.keys().next().value);
      images.set(url, { media, expires: now() + 5 * 60000 }); return { ...media, name: `Producto-${product.sku || product.id}.jpg` };
    } catch { throw failure('product_image_unavailable', 'No se pudo preparar la foto del producto. Volvé a intentar.'); }
    finally { converting--; }
  }
  return { quote, photo };
}
