/**
 * FBPOSApp.pricing
 * Lógica de opciones de pago y precios
 */
(function() {
  const $ = FBPOSApp.$;

  /**
   * Verifica si una pasarela es Mercado Pago nativo
   */
  FBPOSApp.isMP = function(id) {
    id = String(id || '').toLowerCase();
    return id.includes('mercado-pago') || id.includes('mercadopago') || id.includes('woo-mercado-pago');
  };

  /**
   * Verifica si una pasarela es Posnet
   */
  FBPOSApp.isPosnet = function(id) {
    return String(id || '').toLowerCase() === 'fbpos_posnet';
  };

  /**
   * Verifica si una pasarela requiere cuotas obligatorias (MP o Posnet)
   */
  FBPOSApp.isCardLike = function(id) {
    return FBPOSApp.isMP(id) || FBPOSApp.isPosnet(id);
  };

  /**
   * Construye las opciones de precio en base a perfiles y planes
   */
  FBPOSApp.buildOptions = function() {
    const base = FBPOSApp.subtotal();
    const out = [];

    // Agregar perfiles de precio
    // Los perfiles (contado, transferencia, dólar) no tienen cuotas para MP
    FBPOS.profiles.forEach((p, i) => {
      const ars = base * p.factor;
      const isUSD = p.currency === 'USD';
      const val = isUSD ? (FBPOS.usdRate ? ars / FBPOS.usdRate : 0) : ars;

      out.push({
        key: 'p' + i,
        label: p.label,
        factor: p.factor,
        currency: p.currency,
        totalARS: ars,
        totalText: isUSD
          ? FBPOS.usdRate
            ? FBPOSApp.usd(val)
            : 'Configurar USD'
          : FBPOSApp.money(ars),
        detail: isUSD ? `${FBPOS.usdSource || 'Dólar Blue'} · Ref. ${FBPOSApp.money(FBPOS.usdRate)}` : 'Pago directo',
        installments: null
      });
    });

    // Agregar planes de pago
    // Las cuotas válidas para MP se validan contra la lista permitida del backend
    // y se calcula el monto usando el coeficiente REAL de Master Control si está disponible
    FBPOS.plans.forEach((p, i) => {
      const allowedInstallments = FBPOS.allowedInstallments || [];
      const isValidMpInstallment = allowedInstallments.includes(String(p.count));

      // Usar el coeficiente real de Master Control si está disponible para esta cuota
      // Si no está disponible o Master Control no está activo, fallback al factor propio del POS
      const coefficients = FBPOS.installmentCoefficients || {};
      const realCoefficient = isValidMpInstallment ? coefficients[String(p.count)] : null;
      const effectiveFactor = (realCoefficient !== null && realCoefficient !== undefined) ? realCoefficient : p.factor;

      const t = base * effectiveFactor;

      out.push({
        key: 'c' + i,
        label: p.label,
        factor: effectiveFactor,
        currency: 'ARS',
        totalARS: t,
        totalText: FBPOSApp.money(t),
        detail: p.count > 1 ? `${p.count} pagos de ${FBPOSApp.money(t / p.count)}` : 'Pago contado',
        count: p.count,
        installments: isValidMpInstallment ? p.count : null
      });
    });

    return out;
  };

  /**
   * Renderiza la pantalla de opciones de precio
   */
  FBPOSApp.renderPricing = function() {
    FBPOSApp.state.options = FBPOSApp.buildOptions();

    $('#fbpos-price-cards').innerHTML = FBPOSApp.state.options
      .map(
        o => `
      <button class="price-card ${FBPOSApp.state.selected?.key === o.key ? 'selected' : ''}" data-key="${o.key}">
        <div>
          <span>${o.label}</span>
          <small>${o.detail}</small>
        </div>
        <strong>${o.totalText}</strong>
      </button>
    `
      )
      .join('');

    // Listener para seleccionar opción
    $('#fbpos-price-cards').onclick = e => {
      const b = e.target.closest('.price-card');
      if (!b) return;
      FBPOSApp.state.selected = FBPOSApp.state.options.find(o => o.key === b.dataset.key);
      FBPOSApp.renderPricing();
    };

    // Actualizar resumen
    $('#fbpos-selected-label').textContent = FBPOSApp.state.selected?.label || '—';
    $('#fbpos-selected-total').textContent = FBPOSApp.state.selected?.totalText || '$0';
    $('#fbpos-selected-detail').textContent =
      FBPOSApp.state.selected?.detail || 'Seleccioná una alternativa.';
    $('#fbpos-to-checkout').disabled = !FBPOSApp.state.selected;
  };
})();
