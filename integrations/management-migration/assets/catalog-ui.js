/* Shared display for the local, read-only catalogue. Never writes or contacts Woo. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const amount = n => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  function picture(p) {
    let valid=false;
    try { const u=new URL(p.image);valid=u.protocol==='https:'&&['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname.startsWith('/wp-content/uploads/')&&/\.(jpe?g|png|webp|gif)$/i.test(u.pathname); } catch {}
    return `<span class="fusion-product-mark" aria-hidden="true">${esc((p.name||'P').slice(0,1))}${valid?`<img src="${esc(p.image)}" alt="" width="56" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</span>`;
  }
  function updated(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : 'sin fecha disponible';
  }
  window.FusionLocalCatalog = {
    render(rows) {
      if (!rows.length) return '<div class="empty fusion-catalog-empty">No se encontraron productos en el catálogo local. Probá otro nombre, SKU o código.</div>';
      return rows.map(p => `<article class="fusion-catalog-result"><div class="fusion-catalog-top">${picture(p)}<div><h3>${esc(p.name)}</h3><p class="fusion-product-code">${esc(p.sku || 'Sin SKU')}${p.ean ? ' · GTIN '+esc(p.ean) : ''}</p></div><span class="fusion-stock ${typeof p.stock === 'number' && p.stock > 0 ? 'fusion-stock-positive' : ''}">${typeof p.stock === 'number' ? esc(p.stock)+' unidades' : 'Sin dato de stock'}</span></div><div class="fusion-catalog-meta"><span>Stock registrado · ${esc(updated(p._local.updated_at))}</span><span>${typeof p._local.reference_price === 'number' ? amount(p._local.reference_price) : 'Precio al contado no disponible'}<small>${esc(p._local.price_label)}</small></span></div></article>`).join('');
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    const banner=document.querySelector('.fusion-migration-banner');
    if(banner){const link=document.createElement('a');link.href='/herramientas/gestion-vps/directory/';link.textContent='Clientes y pedidos';banner.appendChild(link);}
    const help = document.querySelector('.scanner-help span');
    if (help) help.textContent = 'Escaneá el código para consultar';
    const button = document.querySelector('#refresh-catalog');
    if (button) { button.textContent = 'Releer stock local'; button.title = 'Relee la copia sincronizada en el VPS. No consulta la tienda.'; }
    const search = document.querySelector('#product-search');
    if (search) {
      const note = document.createElement('p'); note.className = 'fusion-catalog-note';
      note.textContent = 'Catálogo local sincronizado · Precio de referencia. El total final se confirma en el checkout de la tienda.';
      document.querySelector('.catalog-controls')?.appendChild(note);
    }
  });
  document.addEventListener('error', event => {
    if(event.target?.matches?.('.fusion-product-mark img'))event.target.remove();
  }, true);
})();
