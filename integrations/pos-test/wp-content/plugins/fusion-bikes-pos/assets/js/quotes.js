/**
 * FBPOSApp.quotes
 * Lógica de generación de presupuestos
 */
(function() {
  const $ = FBPOSApp.$;

  /**
   * Construye el payload para un presupuesto
   */
  FBPOSApp.quotePayload = function() {
    const c = FBPOSApp.state.customer || {
      name: 'Consumidor final',
      phone: '',
      email: '',
      document: '',
      document_type: '',
      id: 0
    };

    return {
      items: FBPOSApp.items(),
      subtotal: FBPOSApp.subtotal(),
      customer_id: c.id || 0,
      customer_name: c.name || 'Consumidor final',
      customer_phone: c.phone || '',
      customer_email: c.email || '',
      customer_document: c.document || '',
      document_type: c.document_type || '',
      note: $('#fbpos-note').value,
      options: FBPOSApp.buildOptions()
    };
  };

  /**
   * Genera un presupuesto
   */
  FBPOSApp.makeQuote = async function(skipCustomer = false) {
    if (!skipCustomer && !FBPOSApp.requireCustomer('quote')) return;

    try {
      const q = await FBPOSApp.api('/quote', {
        method: 'POST',
        body: JSON.stringify(FBPOSApp.quotePayload())
      });

      $('#fbpos-quote-content').innerHTML = `
        <div class="quote-success">
          <div class="success-icon">✓</div>
          <h2>Presupuesto ${q.number}</h2>
          <p>Se guardó con miniaturas, enlaces y todas las opciones de pago.</p>
          <div class="quote-actions">
            <a class="fbpos-btn primary" target="_blank" href="${q.url}">Ver presupuesto</a>
            <a class="fbpos-btn secondary" target="_blank" href="${q.print_url}">Imprimir / PDF</a>
            <a class="fbpos-btn whatsapp" target="_blank" href="${q.whatsapp}">Enviar por WhatsApp</a>
          </div>
          <input value="${q.url}" readonly onclick="this.select()">
        </div>
      `;

      $('#fbpos-quote-modal').hidden = false;
    } catch (e) {
      alert(e.message);
    }
  };

  // === LISTENERS: Presupuestos ===
  $('#fbpos-quote-now').onclick = FBPOSApp.makeQuote;
  $('#fbpos-quote-pricing').onclick = FBPOSApp.makeQuote;
  $('#fbpos-close-quote').onclick = () => ($('#fbpos-quote-modal').hidden = true);
})();
