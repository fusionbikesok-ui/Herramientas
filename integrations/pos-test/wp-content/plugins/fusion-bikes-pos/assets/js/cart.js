/**
 * FBPOSApp.cart
 * Lógica del carrito: renderizado y operaciones CRUD
 */
(function() {
  const $ = FBPOSApp.$;
  const $$ = FBPOSApp.$$;

  /**
   * Renderiza el carrito actual
   */
  FBPOSApp.renderCart = function() {
    const box = $('#fbpos-cart');
    const arr = [...FBPOSApp.state.cart.values()];

    // Renderizar items o mensaje vacío
    box.innerHTML = arr.length
      ? arr
          .map(p => `
        <div class="cart-row">
          <img src="${p.image}">
          <div>
            <strong>${p.name}</strong>
            <small>${p.sku || ''}</small>
          </div>
          <div class="qty">
            <button data-act="dec" data-id="${p.id}">−</button>
            <b>${p.qty}</b>
            <button data-act="inc" data-id="${p.id}">+</button>
          </div>
          <strong>${FBPOSApp.money(p.price * p.qty)}</strong>
          <button class="remove" data-act="remove" data-id="${p.id}">×</button>
        </div>
      `)
          .join('')
      : '<div class="empty">Escaneá o buscá productos para comenzar.</div>';

    // Listeners para cambiar qty o eliminar
    box.onclick = e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const p = FBPOSApp.state.cart.get(+b.dataset.id);
      if (!p) return;
      if (b.dataset.act === 'inc') p.qty++;
      if (b.dataset.act === 'dec') p.qty = Math.max(1, p.qty - 1);
      if (b.dataset.act === 'remove') FBPOSApp.state.cart.delete(p.id);
      FBPOSApp.renderCart();
    };

    // Actualizar contador y total
    const units = arr.reduce((a, p) => a + p.qty, 0);
    $('#fbpos-cart-count').textContent = `${units} unidades`;
    $('#fbpos-sale-total').textContent = FBPOSApp.money(FBPOSApp.subtotal());
    $('#fbpos-to-pricing').disabled = !arr.length;
    $('#fbpos-quote-now').disabled = !arr.length;

    // Recalcular opciones de precio
    FBPOSApp.state.options = FBPOSApp.buildOptions();
  };

  /**
   * Agrega un producto al carrito
   */
  FBPOSApp.add = function(p) {
    const x = FBPOSApp.state.cart.get(p.id);
    if (x) x.qty++;
    else FBPOSApp.state.cart.set(p.id, { ...p, qty: 1 });
    FBPOSApp.renderCart();
    $('#fbpos-search').value = '';
    $('#fbpos-results').innerHTML = '';
    $('#fbpos-search').focus();
  };

  // === LISTENER: Búsqueda de productos ===
  let timer;
  let lastResults = [];

  const runSearch = async q => {
    try {
      $('#fbpos-search-status').textContent = 'Buscando...';
      const r = await FBPOSApp.api('/search?q=' + encodeURIComponent(q));
      lastResults = r;
      $('#fbpos-search-status').textContent = `${r.length} resultados`;
      $('#fbpos-results').innerHTML =
        r
          .map(
            p => `
          <button class="product-card" data-id="${p.id}" ${p.stock_status !== 'instock' ? 'disabled' : ''}>
            <img src="${p.image}">
            <div>
              <strong>${p.name}</strong>
              <small>${p.sku || 'Sin SKU'} · ${p.stock === null ? 'Stock disponible' : 'Stock ' + p.stock}</small>
            </div>
            <b>${FBPOSApp.money(p.price)}</b>
          </button>
        `
          )
          .join('') || '<div class="empty">No se encontraron productos.</div>';

      // Listener para seleccionar un producto
      $('#fbpos-results').onclick = ev => {
        const b = ev.target.closest('.product-card');
        if (!b) return;
        FBPOSApp.add(r.find(x => x.id === +b.dataset.id));
      };

      // Auto-agregar si hay 1 resultado y coincide exactamente con SKU o código de barras
      // (cubre el caso de un escáner que tipea el código completo sin apretar Enter)
      if (r.length === 1 && q && (r[0].sku === q || (r[0].barcode && r[0].barcode === q))) {
        FBPOSApp.add(r[0]);
      }
    } catch (err) {
      $('#fbpos-search-status').textContent = err.message;
    }
  };

  $('#fbpos-search').addEventListener('input', e => {
    clearTimeout(timer);
    const q = e.target.value.trim();

    if (q.length < 2) {
      lastResults = [];
      $('#fbpos-results').innerHTML = '';
      return;
    }

    timer = setTimeout(() => runSearch(q), 250);
  });

  // Los escáneres de código de barras suelen terminar la secuencia con Enter.
  // Si ya hay un único resultado visible, confirmarlo de inmediato sin esperar el click.
  $('#fbpos-search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();

    const q = e.target.value.trim();
    if (q.length < 2) return;

    clearTimeout(timer);

    if (lastResults.length === 1) {
      FBPOSApp.add(lastResults[0]);
    } else {
      runSearch(q);
    }
  });
})();
