/**
 * FBPOSApp.quoteHistory
 * Lógica para listar presupuestos y convertirlos a órdenes
 */
(function() {
  const $ = FBPOSApp.$;
  const $$ = FBPOSApp.$$;

  /**
   * Carga la lista de presupuestos desde el servidor
   */
  FBPOSApp.loadQuoteHistory = async function() {
    try {
      $('#fbpos-quote-history-loading').hidden = false;
      $('#fbpos-quote-history-table').innerHTML = '';
      $('#fbpos-quote-history-error').textContent = '';

      const response = await FBPOSApp.api('/quotes', { method: 'GET' });

      if (!response.quotes || response.quotes.length === 0) {
        $('#fbpos-quote-history-loading').hidden = true;
        $('#fbpos-quote-history-table').innerHTML = `
          <div class="quote-history-empty">
            <p>No hay presupuestos registrados aún.</p>
          </div>
        `;
        return;
      }

      // Construir tabla de presupuestos
      const rows = response.quotes.map(quote => {
        const statusLabel = FBPOSApp.getQuoteStatusLabel(quote);
        const canConvert = quote.status === 'pending';
        const actionBtn = canConvert
          ? `<button class="fbpos-btn small primary" data-quote-id="${quote.id}" onclick="FBPOSApp.startQuoteConversion(${quote.id})">Convertir a pedido</button>`
          : '';

        return `
          <tr>
            <td>${FBPOSApp.escapeHtml(quote.number)}</td>
            <td>${FBPOSApp.escapeHtml(quote.customer)}</td>
            <td>${FBPOSApp.money(quote.total)}</td>
            <td>${FBPOSApp.formatDate(quote.created)}</td>
            <td>${FBPOSApp.formatDate(quote.valid_until)}</td>
            <td>${statusLabel}</td>
            <td>${actionBtn}</td>
          </tr>
        `;
      }).join('');

      $('#fbpos-quote-history-loading').hidden = true;
      $('#fbpos-quote-history-table').innerHTML = `
        <table class="fbpos-quote-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Cliente</th>
              <th>Total</th>
              <th>Creado</th>
              <th>Vence</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;
    } catch (e) {
      $('#fbpos-quote-history-loading').hidden = true;
      $('#fbpos-quote-history-error').textContent = `Error al cargar presupuestos: ${e.message}`;
    }
  };

  /**
   * Obtiene la etiqueta de estado traducida
   */
  FBPOSApp.getQuoteStatusLabel = function(quote) {
    const status = quote.status;
    if (status === 'pending') {
      return '<span class="status-badge pending">Pendiente</span>';
    } else if (status === 'converted') {
      return `<span class="status-badge converted">Convertido a pedido #${quote.converted_order_number || quote.converted_order_id}</span>`;
    } else if (status === 'expired') {
      return '<span class="status-badge expired">Vencido</span>';
    }
    return `<span class="status-badge">${status}</span>`;
  };

  /**
   * Formatea una fecha en formato legible
   */
  FBPOSApp.formatDate = function(dateString) {
    if (!dateString) return '—';
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateString;
    }
  };

  /**
   * Inicia el flujo de conversión: carga el presupuesto y prepara el checkout
   */
  FBPOSApp.startQuoteConversion = async function(quoteId) {
    try {
      const response = await FBPOSApp.api('/quotes', { method: 'GET' });
      const quote = response.quotes.find(q => q.id === quoteId);

      if (!quote) {
        alert('Presupuesto no encontrado');
        return;
      }

      if (quote.status !== 'pending') {
        alert(`Este presupuesto no puede ser convertido (estado: ${quote.status})`);
        return;
      }

      // Guardar el quote_id en el estado
      FBPOSApp.state.quoteId = quoteId;

      // Crear un plan ficticio para que el checkout funcione correctamente
      FBPOSApp.state.selected = {
        label: `Presupuesto ${quote.number}`,
        factor: 1,
        installments: null,
        totalARS: quote.total,
        totalUSD: quote.total / (FBPOS.usdRate || 1),
        totalText: FBPOSApp.money(quote.total)
      };

      // Limpiar carrito y precargar cliente del presupuesto (ALTO 3 FIX)
      FBPOSApp.state.cart.clear();
      // Precargar cliente con los datos del presupuesto para evitar que se pierda
      FBPOSApp.state.customer = {
        name: quote.customer || '',
        email: quote.customer_email || '',
        phone: quote.customer_phone || '',
        document: quote.customer_document || '',
        document_type: quote.customer_document_type || ''
      };
      FBPOSApp.state.pendingAction = null;
      $('#fbpos-note').value = '';

      // Ir al checkout — renderCheckout() ya manejará el resumen del presupuesto
      // (MEDIO 4 FIX: eliminado setTimeout frágil, ahora es renderCheckout quien lo renderiza internamente)
      FBPOSApp.go('checkout');

    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  // === LISTENERS: Presupuestos ===
  // Los listeners se configuran cuando se carga la pantalla de presupuestos

})();
