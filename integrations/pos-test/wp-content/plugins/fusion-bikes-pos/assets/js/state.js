/**
 * FBPOSApp.State
 * Estado global y helpers de formato
 */
(function() {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  window.FBPOSApp = window.FBPOSApp || {};

  // Estado global compartido entre módulos
  FBPOSApp.state = {
    cart: new Map(),
    options: [],
    selected: null,
    screen: 'sale',
    customer: null,
    pendingAction: null,
    quoteId: null
  };

  /**
   * Formatea un número como ARS
   */
  FBPOSApp.money = function(n) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0
    }).format(n || 0);
  };

  /**
   * Formatea un número como USD
   */
  FBPOSApp.usd = function(n) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(n || 0);
  };

  /**
   * Calcula el subtotal del carrito
   */
  FBPOSApp.subtotal = function() {
    return [...FBPOSApp.state.cart.values()].reduce((a, p) => a + p.price * p.qty, 0);
  };

  /**
   * Devuelve los items del carrito como array de {id, qty}
   */
  FBPOSApp.items = function() {
    return [...FBPOSApp.state.cart.values()].map(p => ({
      id: p.id,
      qty: p.qty
    }));
  };

  // Exportar helpers de selectores para otros módulos
  FBPOSApp.$ = $;
  FBPOSApp.$$ = $$;
})();
