/**
 * FBPOSApp.app
 * Controlador principal y bootstrap de la aplicación
 */
(function() {
  const $ = FBPOSApp.$;
  const $$ = FBPOSApp.$$;

  /**
   * Navega a una pantalla específica
   */
  FBPOSApp.go = function(screen) {
    FBPOSApp.state.screen = screen;

    // Mostrar/ocultar pantallas
    $$('.fbpos-screen').forEach(x =>
      x.classList.toggle('active', x.dataset.screen === screen)
    );

    // Orden de los pasos en el wizard
    const stepOrder = ['sale', 'pricing', 'checkout', 'done'];
    const currentStepIndex = stepOrder.indexOf(screen);

    // Actualizar botones de navegación: active para el actual, completed para anteriores
    $$('.fbpos-steps button').forEach(x => {
      const buttonStepIndex = stepOrder.indexOf(x.dataset.step);
      x.classList.toggle('active', x.dataset.step === screen);
      x.classList.toggle('completed', buttonStepIndex < currentStepIndex && buttonStepIndex >= 0);
    });

    // Actualizar etiqueta del paso
    const labels = {
      sale: '1 · Armado de venta',
      pricing: '2 · Opciones de pago',
      checkout: '3 · Cobro',
      done: '4 · Finalización',
      quotes: 'Historial de presupuestos'
    };
    $('#fbpos-step-label').textContent = labels[screen];

    // Renderizar contenido según pantalla
    if (screen === 'pricing') FBPOSApp.renderPricing();
    if (screen === 'checkout') FBPOSApp.renderCheckout();
    if (screen === 'quotes') FBPOSApp.loadQuoteHistory();
  };

  /**
   * Reinicia la venta: limpia carrito, cliente, nota y vuelve a la pantalla inicial
   */
  FBPOSApp.reset = function() {
    FBPOSApp.state.cart.clear();
    FBPOSApp.state.selected = null;
    FBPOSApp.state.customer = null;
    FBPOSApp.state.pendingAction = null;
    FBPOSApp.state.quoteId = null;  // CRÍTICO 2 FIX: Limpiar quoteId para evitar que contamine la venta siguiente
    $('#fbpos-note').value = '';
    FBPOSApp.updateCustomerSummary();
    FBPOSApp.renderCart();
    FBPOSApp.go('sale');
    $('#fbpos-search').focus();
  };

  // === LISTENERS: Navegación principal ===
  $('#fbpos-new').onclick = FBPOSApp.reset;
  $('#fbpos-to-pricing').onclick = () => FBPOSApp.go('pricing');
  $('#fbpos-to-checkout').onclick = () => FBPOSApp.go('checkout');
  const quotesBtn = $('#fbpos-to-quotes');
  if (quotesBtn) {
    quotesBtn.onclick = () => FBPOSApp.go('quotes');
  }

  // Botones "volver" — limpiar quoteId si volvemos de una conversión de presupuesto
  $$('[data-back]').forEach(b => {
    b.onclick = () => {
      // CRÍTICO 2 FIX: Limpiar quoteId cuando se vuelve atrás para no contaminar otra venta
      if (FBPOSApp.state.quoteId !== null && FBPOSApp.state.quoteId !== undefined) {
        FBPOSApp.state.quoteId = null;
      }
      FBPOSApp.go(b.dataset.back);
    };
  });

  // === INICIALIZACIÓN ===
  FBPOSApp.updateCustomerSummary();
  FBPOSApp.renderCart();
})();
