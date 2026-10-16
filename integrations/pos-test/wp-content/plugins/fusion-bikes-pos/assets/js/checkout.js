/**
 * FBPOSApp.checkout
 * Lógica de cobro: gateway, pago simple, pago mixto, procesamiento
 */
(function() {
  const $ = FBPOSApp.$;
  const $$ = FBPOSApp.$$;

  // Estado global para pago mixto con tarjetas
  let mixedState = {
    ticketRef: null,
    pollingIntervals: {}
  };

  /**
   * Persiste el estado del pago mixto en sessionStorage para sobrevivir un F5.
   * Guarda: mixed_ticket_ref y por cada fila completed: su mixed_row_id y estado.
   */
  // Ventana de validez del estado persistido: pasado este tiempo, se descarta aunque
  // el total del ticket coincida (revisor, ronda 9, hallazgo 5).
  const MIXED_STATE_MAX_AGE_MS = 30 * 60 * 1000;

  FBPOSApp.saveMixedSessionState = function() {
    const ticketRef = mixedState.ticketRef;
    if (!ticketRef) {
      sessionStorage.removeItem('fbpos_mixed_state');
      return;
    }

    const rows = $$('#fbpos-mixed-rows .mixed-row');
    const completedRows = [];
    const processingRows = [];
    rows.forEach(row => {
      const rowId = row.getAttribute('data-row-id');
      const mixedRowId = row.getAttribute('data-mixed-row-id');
      if (!rowId || !mixedRowId) return;

      const baseAmount = parseFloat(row.querySelector('.mixed-amount')?.value) || 0;

      if (row.classList.contains('completed')) {
        const totalAmount = parseFloat(row.getAttribute('data-total-amount')) || 0;
        if (totalAmount > 0) {
          completedRows.push({ rowId, mixedRowId, baseAmount, totalAmount });
        }
      } else if (row.classList.contains('processing')) {
        // CRÍTICO ronda 9, hallazgo 3: una pierna abierta pero no confirmada también
        // hay que persistirla, si no un F5 la deja huérfana y el cajero puede volver
        // a cobrarla (doble cobro real en la tarjeta del cliente).
        processingRows.push({ rowId, mixedRowId, baseAmount });
      }
    });

    const state = {
      ticketRef,
      ticketTotal: FBPOSApp.state.selected?.totalARS || 0,
      savedAt: Date.now(),
      completedRows,
      processingRows
    };

    sessionStorage.setItem('fbpos_mixed_state', JSON.stringify(state));
  };

  /**
   * Restaura el estado del pago mixto desde sessionStorage después de un F5.
   * Solo restaura si el ticket actual corresponde al mismo total y el estado no es viejo.
   */
  FBPOSApp.loadMixedSessionState = function() {
    const saved = sessionStorage.getItem('fbpos_mixed_state');
    if (!saved) return;

    try {
      const state = JSON.parse(saved);
      const currentTicketTotal = FBPOSApp.state.selected?.totalARS || 0;
      const age = Date.now() - (state.savedAt || 0);

      // Validar que corresponde al mismo ticket (por total) y que no es un estado viejo
      // de otra venta (revisor, ronda 9, hallazgo 5 — el total solo no alcanza, pero
      // sumarle una expiración corta acota mucho el riesgo de dos tickets iguales).
      if (Math.abs(state.ticketTotal - currentTicketTotal) > 0.01 || age > MIXED_STATE_MAX_AGE_MS) {
        sessionStorage.removeItem('fbpos_mixed_state');
        return;
      }

      mixedState.ticketRef = state.ticketRef;

      const rows = $$('#fbpos-mixed-rows .mixed-row');

      (state.completedRows || []).forEach(savedRow => {
        const row = rows.find(r => r.getAttribute('data-row-id') === savedRow.rowId);
        if (!row) return;

        row.setAttribute('data-mixed-row-id', savedRow.mixedRowId);
        row.setAttribute('data-total-amount', savedRow.totalAmount);
        row.classList.add('completed');

        // Restaurar el monto base ANTES de deshabilitar el input — si no, el input
        // queda con el valor por defecto (mitad del total) y el balance nunca cuadra
        // porque el campo ya está disabled y el cajero no puede corregirlo
        // (revisor, ronda 9, hallazgo 2).
        const amountInput = row.querySelector('.mixed-amount');
        if (amountInput && savedRow.baseAmount > 0) {
          amountInput.value = savedRow.baseAmount;
        }

        row.querySelector('.mixed-amount').disabled = true;
        row.querySelector('.mixed-installments').disabled = true;
        row.querySelector('.mixed-gateway').disabled = true;
        row.querySelector('.remove-pay').disabled = true;

        const statusEl = row.querySelector('.mixed-row-status');
        if (statusEl) {
          statusEl.innerHTML = '<div class="mixed-status-ok">✓ Tarjeta aprobada</div>';
        }
      });

      (state.processingRows || []).forEach(savedRow => {
        const row = rows.find(r => r.getAttribute('data-row-id') === savedRow.rowId);
        if (!row) return;

        row.setAttribute('data-mixed-row-id', savedRow.mixedRowId);
        row.classList.add('processing');

        const amountInput = row.querySelector('.mixed-amount');
        if (amountInput && savedRow.baseAmount > 0) {
          amountInput.value = savedRow.baseAmount;
        }

        // Reanudar el polling que se perdió con la recarga de página — si no, la fila
        // queda "esperando" para siempre y el cajero puede reintentar el cobro por su
        // cuenta creyendo que nunca se abrió (revisor, ronda 9, hallazgo 3).
        FBPOSApp.startRowPolling(row, savedRow.mixedRowId);
      });
    } catch (e) {
      sessionStorage.removeItem('fbpos_mixed_state');
    }
  };

  /**
   * Genera un UUID v4 simple (no criptográficamente seguro, pero suficiente para este caso)
   */
  FBPOSApp.generateUUID = function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  /**
   * ALTO 4 FIX: Escapar HTML para evitar XSS con datos del gateway
   */
  FBPOSApp.escapeHtml = function(text) {
    if (typeof text !== 'string') return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  };

  /**
   * Obtiene o crea el ticket_ref para el pago mixto con tarjetas
   */
  FBPOSApp.getMixedTicketRef = function() {
    if (!mixedState.ticketRef) {
      mixedState.ticketRef = FBPOSApp.generateUUID();
    }
    return mixedState.ticketRef;
  };


  /**
   * Valida si una cantidad de cuotas es válida
   */
  FBPOSApp.isValidInstallment = function(installments) {
    const allowed = FBPOS.allowedInstallments || [];
    return allowed.includes(String(installments));
  };

  /**
   * Actualiza el mensaje de ayuda según el gateway seleccionado
   */
  FBPOSApp.updateGatewayHelp = function() {
    const id = $('#fbpos-gateway')?.value || '';
    const box = $('#fbpos-gateway-help');

    if (!box) return;

    box.innerHTML = FBPOSApp.isMP(id)
      ? `
      <strong>Mercado Pago nativo</strong>
      <span>Al confirmar, se abrirá el checkout seguro con el formulario real de tarjeta y su selector de cuotas.</span>
    `
      : `
      <strong>Cobro directo POS</strong>
      <span>El pedido se procesará con el medio seleccionado.</span>
    `;

    box.classList.toggle('mp', FBPOSApp.isMP(id));
  };

  /**
   * Renderiza la pantalla de checkout
   * MEDIO 4 FIX: Si se está convirtiendo un presupuesto, renderizar el resumen en lugar del carrito
   */
  FBPOSApp.renderCheckout = function() {
    if (!FBPOSApp.state.selected) {
      FBPOSApp.go('pricing');
      return;
    }

    $('#fbpos-checkout-plan').textContent = FBPOSApp.state.selected.label;
    $('#fbpos-checkout-total').textContent = FBPOSApp.state.selected.totalText;

    // Si estamos convirtiendo un presupuesto, renderizar su resumen; si no, renderizar carrito
    const checkoutItemsDiv = $('#fbpos-checkout-items');
    if (FBPOSApp.state.quoteId !== null && FBPOSApp.state.quoteId !== undefined) {
      // Obtener datos del presupuesto de la lista
      // Nota: esto requiere que loadQuoteHistory ya haya cargado los presupuestos
      // pero como estamos aquí después de startQuoteConversion, trabajamos con lo que tenemos
      checkoutItemsDiv.innerHTML = `
        <div class="quote-checkout-summary">
          <h3>Conversión de presupuesto</h3>
          <p><strong>Presupuesto:</strong> ${FBPOSApp.escapeHtml(FBPOSApp.state.selected.label)}</p>
          <p><strong>Cliente:</strong> ${FBPOSApp.escapeHtml(FBPOSApp.state.customer?.name || 'Consumidor final')}</p>
          <p><strong>Total:</strong> $${FBPOSApp.state.selected.totalARS?.toFixed(2) || '0.00'}</p>
          <p><em>Los artículos del presupuesto se usarán automáticamente.</em></p>
        </div>
      `;
    } else {
      // Renderizar carrito normal
      checkoutItemsDiv.innerHTML = [...FBPOSApp.state.cart.values()]
        .map(
          p => `
        <div class="checkout-item">
          <span>${p.qty} × ${p.name}</span>
          <strong>${FBPOSApp.money(p.price * p.qty)}</strong>
        </div>
      `
        )
        .join('');
    }

    // Rellenar dropdown de gateways (PUNTO 7: escapar datos del gateway)
    // CRÍTICO 1 FIX: Deshabilitar Mercado Pago si se está convirtiendo un presupuesto
    const gw = $('#fbpos-gateway');
    gw.innerHTML = FBPOS.gateways.map(g => {
      const isConvertingQuote = FBPOSApp.state.quoteId !== null && FBPOSApp.state.quoteId !== undefined;
      const disabled = isConvertingQuote && FBPOSApp.isMP(g.id) ? 'disabled' : '';
      const label = isConvertingQuote && FBPOSApp.isMP(g.id)
        ? `${FBPOSApp.escapeHtml(g.title)} (no disponible al convertir un presupuesto)`
        : FBPOSApp.escapeHtml(g.title);
      return `<option value="${FBPOSApp.escapeHtml(g.id)}" ${disabled}>${label}</option>`;
    }).join('');
    gw.onchange = FBPOSApp.updateGatewayHelp;

    // Si se está convirtiendo presupuesto y Mercado Pago estaba seleccionado, cambiar al primer gateway habilitado
    if (FBPOSApp.state.quoteId !== null && FBPOSApp.state.quoteId !== undefined && FBPOSApp.isMP(gw.value)) {
      let firstEnabledGateway = '';
      for (const g of FBPOS.gateways) {
        if (!FBPOSApp.isMP(g.id)) {
          firstEnabledGateway = g.id;
          break;
        }
      }
      if (firstEnabledGateway) {
        gw.value = firstEnabledGateway;
      }
    }

    // Renderizar pago mixto y actualizar saldo
    FBPOSApp.renderMixed();
    FBPOSApp.updateGatewayHelp();
  };

  /**
   * Renderiza filas para pago combinado
   * CRÍTICO 5 FIX: Restaurar estado desde sessionStorage después de F5
   */
  FBPOSApp.renderMixed = function() {
    const box = $('#fbpos-mixed-rows');
    if (!box) return;

    // Limpiar estado de polling anterior
    Object.keys(mixedState.pollingIntervals).forEach(key => FBPOSApp.stopRowPolling(key));

    // Si no hay filas en el DOM, crear las iniciales
    if (!box.children.length) {
      mixedState.ticketRef = null;
      box.innerHTML = FBPOSApp.rowHTML(0) + FBPOSApp.rowHTML(1);
      const rows = box.querySelectorAll('.mixed-row');
      rows.forEach(row => {
        FBPOSApp.attachRowListeners(row);
        FBPOSApp.updateRowVisibility(row);
      });

      const ins = box.querySelectorAll('input.mixed-amount');
      if (ins[0]) ins[0].value = Math.round((FBPOSApp.state.selected?.totalARS || 0) / 2);
      if (ins[1]) ins[1].value = Math.round((FBPOSApp.state.selected?.totalARS || 0) / 2);

      // Restaurar estado desde sessionStorage (después de F5) — pisa los valores por
      // defecto de arriba con los montos reales de cada fila si había un pago mixto en curso.
      FBPOSApp.loadMixedSessionState();
    }

    FBPOSApp.updateBalance();
  };

  /**
   * Genera el HTML de una fila de pago
   * Accesibilidad: aria-live en .mixed-row-status para anunciar cambios de estado
   * PUNTO 7: Escapar los datos del gateway para evitar XSS
   */
  FBPOSApp.rowHTML = function(i) {
    const rowId = 'mixed-row-' + i;
    return `
    <div class="mixed-row" data-row-id="${rowId}">
      <select class="mixed-gateway">${FBPOS.gateways.map(g => {
        // Mercado Pago dentro de un pago mixto está roto (no aparece en el checkout real
        // y aplica un descuento incorrecto — ver tarea #17, bloqueada). Hasta arreglarlo,
        // se deshabilita acá para que el cajero no pueda elegirlo por error; para tarjeta
        // en pago mixto hoy se usa Posnet o el link de pago (Mercado Pago en pago simple).
        const disabled = FBPOSApp.isMP(g.id) ? 'disabled' : '';
        const label = FBPOSApp.isMP(g.id) ? `${FBPOSApp.escapeHtml(g.title)} (no disponible en pago mixto)` : FBPOSApp.escapeHtml(g.title);
        return `<option value="${FBPOSApp.escapeHtml(g.id)}" ${disabled}>${label}</option>`;
      }).join('')}</select>
      <input type="number" class="mixed-amount" min="0" step="0.01" placeholder="Importe">
      <div class="mixed-row-extra" style="display: none;">
        <select class="mixed-installments">
          <option value="">Seleccionar cuotas</option>
          ${(FBPOS.allowedInstallments || []).map(inst => `<option value="${inst}">${inst} cuota${inst !== '1' ? 's' : ''}</option>`).join('')}
        </select>
        <div class="mixed-charge-info"></div>
        <div class="mixed-row-status" aria-live="polite" aria-atomic="true"></div>
        <button type="button" class="mixed-charge-btn fbpos-btn secondary">Cobrar</button>
      </div>
      <button type="button" class="remove-pay">×</button>
    </div>
  `;
  };

  /**
   * Valida que la suma de montos base de todas las filas sea igual al total del ticket.
   * Con la nueva decisión, el pago mixto reparte sobre el TOTAL YA FINANCIADO (sin recargo adicional).
   * Cada fila de tarjeta cobra su monto base exactamente, sin cálculo de recargo.
   */
  FBPOSApp.updateBalance = function() {
    const rows = $$('#fbpos-mixed-rows .mixed-row');
    let baseTotal = 0;

    rows.forEach(row => {
      const amount = parseFloat(row.querySelector('.mixed-amount')?.value) || 0;
      baseTotal += amount;
    });

    const ticketTotal = FBPOSApp.state.selected?.totalARS || 0;
    const diff = ticketTotal - baseTotal;
    const el = $('#fbpos-mixed-balance');

    if (el) {
      const balanceText = Math.abs(diff) < 1
        ? `✓ Importes completos (${FBPOSApp.money(baseTotal)})`
        : diff > 0
          ? `Falta asignar ${FBPOSApp.money(diff)}`
          : `Excede ${FBPOSApp.money(-diff)}`;

      el.innerHTML = `<div>${balanceText}</div>`;
    }
  };

  /**
   * Actualiza la visibilidad de campos según el tipo de gateway seleccionado
   */
  FBPOSApp.updateRowVisibility = function(row) {
    const select = row.querySelector('.mixed-gateway');
    const extra = row.querySelector('.mixed-row-extra');
    const isCardLike = FBPOSApp.isCardLike(select.value);
    const isPosnet = FBPOSApp.isPosnet(select.value);
    const isMP = FBPOSApp.isMP(select.value);

    if (isCardLike) {
      extra.style.display = 'grid';
      extra.classList.add('visible');

      // Actualizar opciones de cuotas según el gateway
      const installmentsSelect = row.querySelector('.mixed-installments');
      const allowedInsts = isPosnet
        ? (FBPOS.allowedInstallmentsPosnet || [])
        : (FBPOS.allowedInstallments || []);

      const currentValue = installmentsSelect.value;
      installmentsSelect.innerHTML =
        '<option value="">Seleccionar cuotas</option>' +
        allowedInsts.map(inst => `<option value="${inst}">${inst} cuota${inst !== '1' ? 's' : ''}</option>`).join('');

      // Restaurar valor si está disponible en las nuevas opciones
      if (allowedInsts.includes(currentValue)) {
        installmentsSelect.value = currentValue;
      }
    } else {
      extra.style.display = 'none';
      extra.classList.remove('visible');
    }

    // Bug real (probador-e2e): Posnet no abre pierna ni redirect — se resuelve en el
    // momento, como efectivo, solo que exige cuotas. El botón "Cobrar"/el estado de
    // "esperando confirmación" son exclusivos del flujo asíncrono de MP; mostrarlos para
    // Posnet hacía que el cajero clickeara "Cobrar" y disparara ese flujo por error
    // (intentaba abrir una pestaña, pedía verificar estado, etc. — nada de eso aplica).
    const chargeBtn = row.querySelector('.mixed-charge-btn');
    const statusEl = row.querySelector('.mixed-row-status');
    if (chargeBtn) {
      chargeBtn.style.display = isMP ? '' : 'none';
    }
    if (statusEl && !isMP) {
      statusEl.innerHTML = '';
    }
  };

  /**
   * SIMPLIFICADO: En pago mixto, cada fila de tarjeta cobra el monto base sin recargo adicional.
   * El selector de cuotas es solo informativo (Mercado Pago lo requiere) pero NO dispara cálculo de precio.
   * Este método está vacío porque la lógica de display ya no aplica.
   */
  FBPOSApp.updateRowCharge = function(row) {
    // Ahora simplemente limpiamos el área (se usaba antes para mostrar recargos)
    const chargeInfo = row.querySelector('.mixed-charge-info');
    if (chargeInfo) {
      chargeInfo.innerHTML = '';
    }
  };

  /**
   * Detiene el polling de una fila
   */
  FBPOSApp.stopRowPolling = function(rowId) {
    if (mixedState.pollingIntervals[rowId]) {
      clearInterval(mixedState.pollingIntervals[rowId]);
      delete mixedState.pollingIntervals[rowId];
    }
  };

  /**
   * Inicia el polling de estado de una fila de tarjeta
   * CRÍTICO 2 FIX: Guardar monto final (total_amount) cuando llega a completed
   * CRÍTICO 4 FIX: Quitar clase .processing en ambos desenlaces (completed y failed)
   */
  FBPOSApp.startRowPolling = function(row, mixedRowId) {
    const rowDataId = row.getAttribute('data-row-id');
    const statusEl = row.querySelector('.mixed-row-status');

    FBPOSApp.stopRowPolling(rowDataId);

    statusEl.innerHTML = '<div class="mixed-status-waiting">⏳ Esperando confirmación de Mercado Pago...</div>';

    const pollFn = async () => {
      try {
        const response = await FBPOSApp.api('/mixed-leg-status?row_id=' + encodeURIComponent(mixedRowId), {
          method: 'GET'
        });

        if (response.status === 'completed') {
          FBPOSApp.stopRowPolling(rowDataId);
          const txData = response.transaction_data || {};
          const cardDisplay = txData.last_four_digits ? `•••• ${txData.last_four_digits} (${txData.card_brand || 'Tarjeta'})` : 'Tarjeta';
          const installmentsDisplay = txData.installments ? `${txData.installments} cuota${txData.installments !== '1' ? 's' : ''}` : '';

          // Escapar valores del gateway para evitar XSS (ALTO 4 FIX)
          const safeCardDisplay = FBPOSApp.escapeHtml(cardDisplay);
          const safeInstallments = FBPOSApp.escapeHtml(installmentsDisplay);

          // CRÍTICO 3 FIX: Usar total_amount_raw (numérico) en lugar de total_amount (HTML)
          // Si total_amount_raw no viene o no es válido, mostrar error explícito
          const totalAmountRaw = parseFloat(txData.total_amount_raw);
          if (isNaN(totalAmountRaw) || totalAmountRaw <= 0) {
            statusEl.innerHTML = `<div class="mixed-status-error">✗ No se pudo confirmar el monto cobrado, contactá soporte</div>`;
            row.classList.add('failed');
            row.classList.remove('processing');
            return;
          }

          statusEl.innerHTML = `<div class="mixed-status-ok">✓ ${safeCardDisplay} — ${safeInstallments} — ${FBPOSApp.money(totalAmountRaw)} APROBADA</div>`;

          // Guardar monto real cobrado para consolidación
          row.setAttribute('data-total-amount', totalAmountRaw);

          row.classList.add('completed');
          // Quitar .processing cuando llega a completed
          row.classList.remove('processing');

          // PUNTO 8 FIX: Revertir estado del botón "Abriendo..." a su estado original
          const chargeBtn = row.querySelector('.mixed-charge-btn');
          if (chargeBtn) {
            chargeBtn.disabled = true;  // Mantener deshabilitado (no cobrar de nuevo una completed)
            chargeBtn.textContent = 'Cobrar';  // Revertir a texto original
          }

          // Congelar campos de la fila (punto 6)
          row.querySelector('.mixed-amount').disabled = true;
          row.querySelector('.mixed-installments').disabled = true;
          row.querySelector('.mixed-gateway').disabled = true;
          row.querySelector('.remove-pay').disabled = true;

          // Persistir estado en sessionStorage (punto 5)
          FBPOSApp.saveMixedSessionState();
        } else if (response.status === 'failed' || response.status === 'cancelled') {
          FBPOSApp.stopRowPolling(rowDataId);
          const reason = response.failure_reason || 'Pago rechazado';

          // Escapar reason para evitar XSS (ALTO 4 FIX)
          const safeReason = FBPOSApp.escapeHtml(reason);

          statusEl.innerHTML = `
            <div class="mixed-status-error">✗ ${safeReason}</div>
            <div class="mixed-error-actions">
              <button type="button" class="mixed-retry-btn fbpos-btn secondary small">Reintentar</button>
              <button type="button" class="mixed-change-btn fbpos-btn secondary small">Cambiar cuotas/monto</button>
              <button type="button" class="mixed-cash-btn fbpos-btn secondary small">Pasar a efectivo</button>
            </div>
          `;
          row.classList.add('failed');
          // CRÍTICO 4 FIX: Quitar .processing cuando llega a failed
          row.classList.remove('processing');
        }
        // Si sigue en pending o processing, continuar polling
      } catch (e) {
        // En caso de error de API, continuamos polling
      }
    };

    // Polling cada 3 segundos
    pollFn(); // Ejecutar inmediatamente
    mixedState.pollingIntervals[rowDataId] = setInterval(pollFn, 3000);
  };

  /**
   * Procesa el cobro de una fila de tarjeta
   */
  FBPOSApp.chargeCardRow = async function(row) {
    const gateway = row.querySelector('.mixed-gateway').value;
    const amount = parseFloat(row.querySelector('.mixed-amount').value) || 0;
    const installments = parseInt(row.querySelector('.mixed-installments').value) || 0;

    if (amount <= 0 || !installments) {
      // PUNTO 8 FIX: Mostrar mensaje en el panel en lugar de alert()
      $('#fbpos-message').textContent = 'Completá monto y cuotas antes de cobrar.';
      return;
    }

    if (!FBPOSApp.state.selected || !FBPOSApp.state.selected.factor) {
      // PUNTO 8 FIX: Mostrar mensaje en el panel en lugar de alert()
      $('#fbpos-message').textContent = 'Operación incompleta. Volvé a la pantalla de precios.';
      return;
    }

    // Generar IDs únicos
    const mixedTicketRef = FBPOSApp.getMixedTicketRef();
    const mixedRowId = FBPOSApp.generateUUID();

    const btn = row.querySelector('.mixed-charge-btn');
    btn.disabled = true;
    btn.textContent = 'Abriendo...';

    try {
      const payload = {
        items: FBPOSApp.items(),
        // Decisión de negocio: una pierna de pago mixto cobra EXACTAMENTE el monto base
        // que tipeó el cajero, sin ningún recargo adicional (el recargo del plan global
        // del ticket, si lo hay, ya está incluido en lo que se está repartiendo). factor
        // siempre 1 acá — el backend también lo fuerza server-side, no depende de esto.
        factor: 1,
        gateway,
        mixed_leg: true,
        mixed_ticket_ref: mixedTicketRef,
        mixed_row_id: mixedRowId,
        mixed_leg_amount: amount,
        installments,
        customer_id: FBPOSApp.state.customer?.id || 0,
        customer_name: FBPOSApp.state.customer?.name || 'Consumidor final',
        customer_phone: FBPOSApp.state.customer?.phone || '',
        customer_email: FBPOSApp.state.customer?.email || '',
        customer_document: FBPOSApp.state.customer?.document || '',
        document_type: FBPOSApp.state.customer?.document_type || ''
      };

      const response = await FBPOSApp.api('/order', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      // Guardar mixed_row_id en el elemento para referencia posterior
      row.setAttribute('data-mixed-row-id', response.mixed_row_id);
      row.classList.add('processing');

      // Persistir de inmediato: si el cajero recarga la página mientras la pierna está
      // "processing" (pierna abierta, cliente todavía pagando en la otra pestaña), hay
      // que poder reanudar el polling en vez de dejarla huérfana (ronda 9, hallazgo 3).
      FBPOSApp.saveMixedSessionState();

      // M1 FIX: Abrir con noopener para mitigación de window.opener
      const payWindow = window.open(response.payment_url, '_blank', 'noopener');

      // Iniciar polling
      FBPOSApp.startRowPolling(row, response.mixed_row_id);

      // Mostrar interfaz de espera en la fila
      const chargeInfo = row.querySelector('.mixed-charge-info');
      if (payWindow === null) {
        // M1 FIX: Si falla (pop-up bloqueado), mostrar botón de reapertura desde el inicio
        chargeInfo.innerHTML = '<div style="margin-top: 8px;"><small style="color: #d32f2f;">⚠ Pop-up bloqueado. Hacé clic en "Abrir checkout" para completar el pago.</small></div>';
      } else {
        chargeInfo.innerHTML = '<div style="margin-top: 8px;"><small>Se abrió una pestaña nueva para completar el pago. Aguardando confirmación...</small></div>';
      }

      const statusEl = row.querySelector('.mixed-row-status');
      // M1 FIX: Mostrar siempre botón de reapertura (por si se cierra la pestaña)
      statusEl.innerHTML = '<button type="button" class="mixed-reopen-btn fbpos-btn secondary small">Abrir checkout</button><button type="button" class="mixed-verify-btn fbpos-btn secondary small">Verificar ahora</button>';

      // Listener para reabrir pestaña
      statusEl.querySelector('.mixed-reopen-btn')?.addEventListener('click', () => {
        window.open(response.payment_url, '_blank', 'noopener');
      });

      // Listener para verificar
      statusEl.querySelector('.mixed-verify-btn')?.addEventListener('click', () => {
        FBPOSApp.stopRowPolling(row.getAttribute('data-row-id'));
        FBPOSApp.startRowPolling(row, response.mixed_row_id);
      });
    } catch (e) {
      // PUNTO 8 FIX: Mostrar mensaje en el panel en lugar de alert()
      $('#fbpos-message').textContent = 'Error al abrir pago de tarjeta: ' + FBPOSApp.escapeHtml(e.message);
      btn.disabled = false;
      btn.textContent = 'Cobrar';
    }
  };

  // === LISTENERS: Modo de pago ===
  $('#fbpos-payment-mode').onchange = e => {
    $('#fbpos-single-payment').hidden = e.target.value === 'mixed';
    $('#fbpos-mixed-payment').hidden = e.target.value !== 'mixed';
    FBPOSApp.updateBalance();
  };

  $('#fbpos-add-payment').onclick = () => {
    // Contar filas de tarjeta actuales
    const cardRows = $$('#fbpos-mixed-rows [data-row-id*="mixed-row-"]').filter(r => FBPOSApp.isMP(r.querySelector('.mixed-gateway')?.value));
    if (cardRows.length >= 2) {
      alert('Máximo 2 tarjetas permitidas por pago combinado.');
      return;
    }

    const newRow = FBPOSApp.rowHTML(Date.now());
    $('#fbpos-mixed-rows').insertAdjacentHTML('beforeend', newRow);

    // Configurar listeners para la nueva fila
    const lastRow = $('#fbpos-mixed-rows').lastElementChild;
    FBPOSApp.attachRowListeners(lastRow);
  };

  /**
   * Attach listeners a una fila de pago
   * ALTO 3 FIX: Validar límite de 2 tarjetas al cambiar gateway de fila existente
   */
  FBPOSApp.attachRowListeners = function(row) {
    const gatewaySelect = row.querySelector('.mixed-gateway');
    const amountInput = row.querySelector('.mixed-amount');
    const installmentsSelect = row.querySelector('.mixed-installments');
    const chargeBtn = row.querySelector('.mixed-charge-btn');
    const removeBtn = row.querySelector('.remove-pay');

    gatewaySelect.addEventListener('change', () => {
      // ALTO 3 FIX: Si se intenta cambiar a MP, validar que no exceeda 2 tarjetas
      if (FBPOSApp.isMP(gatewaySelect.value)) {
        const allRows = $$('#fbpos-mixed-rows .mixed-row');
        const activeCardRows = allRows.filter(r => {
          if (r === row) return false; // Excluir la fila actual (su antiguo gateway)
          return FBPOSApp.isMP(r.querySelector('.mixed-gateway')?.value);
        });
        if (activeCardRows.length >= 2) {
          // Revertir selección, mostrar mensaje de error
          const oldValue = gatewaySelect.value;
          gatewaySelect.value = row.getAttribute('data-prev-gateway') || '';
          $('#fbpos-message').textContent =
            'Máximo 2 tarjetas permitidas por pago combinado. Completá o remové una tarjeta antes de agregar otra.';
          return;
        }
      }
      // Guardar el gateway anterior para poder revertir si es necesario
      row.setAttribute('data-prev-gateway', gatewaySelect.value);

      FBPOSApp.updateRowVisibility(row);
      FBPOSApp.updateBalance();
    });

    amountInput.addEventListener('input', () => {
      FBPOSApp.updateRowCharge(row);
      FBPOSApp.updateBalance();
    });

    installmentsSelect.addEventListener('change', () => {
      FBPOSApp.updateRowCharge(row);
      FBPOSApp.updateBalance();
    });

    chargeBtn?.addEventListener('click', () => {
      FBPOSApp.chargeCardRow(row);
    });

    // PUNTO 8 FIX: Listener directo en removeBtn removido - se maneja con delegación en el contenedor

    // Guardar gateway inicial
    row.setAttribute('data-prev-gateway', gatewaySelect.value);
  };

  $('#fbpos-mixed-rows').addEventListener('click', e => {
    // Listeners para acciones en fila rechazada
    if (e.target.classList.contains('mixed-retry-btn')) {
      const row = e.target.closest('.mixed-row');
      // PUNTO 8 FIX: Quitar ambas clases .failed y .processing antes de reintentar
      row.classList.remove('processing');
      row.classList.remove('failed');
      FBPOSApp.chargeCardRow(row);
    }

    if (e.target.classList.contains('mixed-change-btn')) {
      const row = e.target.closest('.mixed-row');
      const statusEl = row.querySelector('.mixed-row-status');
      statusEl.innerHTML = '';
      row.classList.remove('failed');
      row.classList.remove('processing');
      const chargeBtn = row.querySelector('.mixed-charge-btn');
      chargeBtn.disabled = false;
      chargeBtn.textContent = 'Cobrar';
    }

    if (e.target.classList.contains('mixed-cash-btn')) {
      const row = e.target.closest('.mixed-row');
      const gatewaySelect = row.querySelector('.mixed-gateway');

      // M4 FIX: No asumir FBPOS.gateways[0] es efectivo, buscar el primero que no sea
      // "tipo tarjeta" (ni MP ni Posnet) — con isMP() solo, esto podía elegir Posnet,
      // que exige cuotas igual que una tarjeta y rechazaba la fila sin explicación.
      let cashGatewayId = '';
      for (const gw of FBPOS.gateways) {
        if (!FBPOSApp.isCardLike(gw.id)) {
          cashGatewayId = gw.id;
          break;
        }
      }
      if (!cashGatewayId && FBPOS.gateways.length > 0) {
        cashGatewayId = FBPOS.gateways[0].id; // Fallback
      }

      gatewaySelect.value = cashGatewayId;
      const evt = new Event('change', { bubbles: true });
      gatewaySelect.dispatchEvent(evt);
      const statusEl = row.querySelector('.mixed-row-status');
      statusEl.innerHTML = '';
      row.classList.remove('failed');
      // CRÍTICO 4 FIX: Quitar .processing cuando se pasa a efectivo
      row.classList.remove('processing');
      const chargeBtn = row.querySelector('.mixed-charge-btn');
      chargeBtn.disabled = false;
      chargeBtn.textContent = 'Cobrar';
      FBPOSApp.updateBalance();
    }

    if (e.target.classList.contains('remove-pay')) {
      const row = e.target.closest('.mixed-row');
      FBPOSApp.stopRowPolling(row.getAttribute('data-row-id'));
      row.remove();
      FBPOSApp.updateBalance();
    }
  });

  $('#fbpos-mixed-rows').addEventListener('input', FBPOSApp.updateBalance);

  /**
   * Procesa el cobro: crea la orden y gestiona el pago
   * CRÍTICO 4 FIX: Cambiar criterio de "pendiente" a cualquier fila MP sin .completed
   * ALTO 1 FIX: Validar balance ANTES de enviar
   */
  FBPOSApp.chargeOrder = async function(skipCustomer = false) {
    if (!skipCustomer && !FBPOSApp.requireCustomer('charge')) return;

    const gateway = $('#fbpos-gateway').value;
    const mixedMode = $('#fbpos-payment-mode').value === 'mixed';
    const rows = $$('#fbpos-mixed-rows .mixed-row');
    const cardRows = rows.filter(r => FBPOSApp.isMP(r.querySelector('.mixed-gateway')?.value));
    // CRÍTICO 4 FIX: Cualquier fila MP que no tenga .completed es pendiente (sin importar .processing)
    const pendingCardRows = cardRows.filter(r => !r.classList.contains('completed'));

    // Validar completitud del pago mixto con tarjetas
    if (mixedMode && cardRows.length > 0) {
      if (pendingCardRows.length > 0) {
        $('#fbpos-message').textContent =
          'Completá todos los cobros con tarjeta antes de finalizar. Hacé clic en "Cobrar" en cada fila de tarjeta.';
        return;
      }

      // Validar que haya al menos una fila completada
      const completedCardRows = cardRows.filter(r => r.classList.contains('completed'));
      if (completedCardRows.length === 0) {
        $('#fbpos-message').textContent = 'Esperando que se completen los cobros con tarjeta.';
        return;
      }
    }

    // ALTO 1 FIX: Validar balance ANTES de enviar
    if (mixedMode) {
      const ticketTotal = FBPOSApp.state.selected?.totalARS || 0;
      let baseTotal = 0;
      rows.forEach(row => {
        baseTotal += parseFloat(row.querySelector('.mixed-amount')?.value) || 0;
      });
      const diff = ticketTotal - baseTotal;
      if (Math.abs(diff) > 0.01) {
        $('#fbpos-message').textContent =
          diff > 0
            ? `Los montos no cuadran. Falta asignar ${FBPOSApp.money(diff)}.`
            : `Los montos no cuadran. Excede ${FBPOSApp.money(-diff)}.`;
        return;
      }
    }

    // Validación: Posnet en pago mixto requiere cuotas obligatorias
    if (mixedMode) {
      for (let r of rows) {
        const gwId = r.querySelector('.mixed-gateway')?.value;
        const isPosnet = FBPOSApp.isPosnet(gwId);
        if (isPosnet) {
          const installmentsValue = r.querySelector('.mixed-installments')?.value;
          if (!installmentsValue) {
            $('#fbpos-message').textContent = 'Posnet en pago mixto requiere cuotas (3, 6, 9, 12 o 18). Seleccioná un valor en la fila.';
            return;
          }
        }
      }
    }

    // Validación: Mercado Pago y Posnet requieren un plan de cuotas válido (no contado)
    if (!mixedMode && FBPOSApp.isCardLike(gateway)) {
      if (!FBPOSApp.state.selected || !FBPOSApp.state.selected.installments) {
        $('#fbpos-message').textContent =
          'Para pagar con tarjeta, elegí un plan de cuotas (no está disponible para pago contado).';
        return;
      }

      // Posnet no admite 24 cuotas — sin esto, el cajero arma toda la venta y recién
      // se entera del rechazo al confirmar, porque el plan de 24 cuotas de la pantalla
      // de Precios se arma con la lista completa de MP, no con la de Posnet (revisor).
      if (FBPOSApp.isPosnet(gateway) && String(FBPOSApp.state.selected.installments) === '24') {
        $('#fbpos-message').textContent =
          'Posnet no admite 24 cuotas. Elegí otro plan en la pantalla de Precios (hasta 18 cuotas).';
        return;
      }
    }

    // Abrir ventana para Mercado Pago si aplica (Posnet no abre ventana)
    let payWindow = null;
    if (!mixedMode && FBPOSApp.isMP(gateway)) {
      payWindow = window.open('about:blank', 'fbpos_mp_checkout');
    }

    // Deshabilitar botón de confirmación
    const btn = $('#fbpos-charge');
    btn.disabled = true;
    btn.textContent = 'Procesando...';
    $('#fbpos-message').textContent = '';

    try {
      // Armar payload
      const mixed = [];
      if (mixedMode) {
        rows.forEach(r => {
          const gwId = r.querySelector('.mixed-gateway')?.value;
          const isMP = FBPOSApp.isMP(gwId);
          const isPosnet = FBPOSApp.isPosnet(gwId);

          // CRÍTICO 2 FIX: Usar monto total guardado para filas completadas,
          // monto base para otras filas
          let amount = +r.querySelector('.mixed-amount')?.value || 0;
          if (isMP && r.classList.contains('completed')) {
            const totalAmount = parseFloat(r.getAttribute('data-total-amount')) || 0;
            if (totalAmount > 0) {
              amount = totalAmount;
            }
          }

          const payment = {
            gateway: gwId,
            amount: amount
          };

          // Si es Posnet en pago mixto, incluir cuotas obligatorias
          if (isPosnet) {
            const installmentsValue = r.querySelector('.mixed-installments')?.value;
            if (installmentsValue) {
              payment.installments = installmentsValue;
            }
          }

          // Si la fila es tarjeta completada, incluir datos de la transacción
          if (isMP && r.classList.contains('completed')) {
            const mixedRowId = r.getAttribute('data-mixed-row-id');
            if (mixedRowId) {
              payment.mixed_row_id = mixedRowId;
              payment.mixed_ticket_ref = FBPOSApp.getMixedTicketRef();
            }
          }

          mixed.push(payment);
        });
      }

      // Si es mixto con tarjetas, usar mixed_consolidate
      const hasCardRows = cardRows.length > 0;

      // Construir payload: si hay quote_id, usarlo; si no, usar items
      const payload = {
        factor: FBPOSApp.state.selected?.factor || 1,
        label: FBPOSApp.state.selected?.label || '',
        // Bug real (probador-e2e): "!mixedMode || hasCardRows ? '' : gateway" evaluaba
        // siempre a '' en pago simple, porque !mixedMode ya es true ahí solo. Esto rompía
        // el pago simple para TODOS los gateways (no solo Posnet) — el backend rechazaba
        // con "Medio de pago no válido." porque nunca llegaba ningún gateway. En pago
        // mixto el gateway de nivel raíz no se usa (va por fila en mixed_payments).
        gateway: mixedMode ? '' : gateway,
        installments: FBPOSApp.state.selected?.installments || null,
        mixed_payments: mixed,
        mixed_consolidate: mixedMode && hasCardRows,
        customer_id: FBPOSApp.state.customer?.id || 0,
        customer_name: FBPOSApp.state.customer?.name || 'Consumidor final',
        customer_phone: FBPOSApp.state.customer?.phone || '',
        customer_email: FBPOSApp.state.customer?.email || '',
        customer_document: FBPOSApp.state.customer?.document || '',
        document_type: FBPOSApp.state.customer?.document_type || '',
        note: $('#fbpos-note').value
      };

      // Agregar quote_id o items según el modo
      if (FBPOSApp.state.quoteId) {
        payload.quote_id = FBPOSApp.state.quoteId;
      } else {
        payload.items = FBPOSApp.items();
      }

      // Llamar a la API
      const d = await FBPOSApp.api('/order', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      // Renderizar resultado
      const waiting = d.requires_native_payment;

      // PUNTO 7: Validar y escapar URLs (payment_url, invoice_url, edit_url)
      const isValidUrl = (url) => {
        try {
          const u = new URL(url, window.location.origin);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      };

      const paymentUrl = isValidUrl(d.payment_url) ? FBPOSApp.escapeHtml(d.payment_url) : '#';
      const invoiceUrl = isValidUrl(d.invoice_url) ? FBPOSApp.escapeHtml(d.invoice_url) : '#';
      const editUrl = isValidUrl(d.edit_url) ? FBPOSApp.escapeHtml(d.edit_url) : '#';

      $('#fbpos-done-card').innerHTML = `
        <div class="success-icon">${waiting ? '↗' : '✓'}</div>
        <h2>${waiting ? 'Completar compra online' : 'Venta registrada'}</h2>
        <p>Pedido #${d.number} · ${d.status}</p>
        <strong class="done-total">${d.total}</strong>
        ${
          waiting
            ? '<p class="native-payment-copy">Se abrió el checkout completo de la tienda. Allí verás el resumen, los datos del cliente, Mercado Pago y las cuotas exactamente como en una compra online.</p>'
            : ''
        }
        <div class="done-actions">
          ${
            waiting
              ? `<a class="fbpos-btn primary" target="fbpos_mp_checkout" href="${paymentUrl}">Abrir checkout completo</a>`
              : `<a class="fbpos-btn primary" target="_blank" href="${invoiceUrl}">Crear Factura AFIP</a>`
          }
          <button class="fbpos-btn secondary" id="done-quote">Presupuesto / comprobante</button>
          ${waiting ? '' : `<a class="fbpos-btn ghost" target="_blank" href="${editUrl}">Ver pedido</a>`}
          <button class="fbpos-btn dark" id="done-new">Nueva venta</button>
        </div>
      `;

      FBPOSApp.go('done');

      // Listeners del resultado
      $('#done-quote').onclick = FBPOSApp.makeQuote;
      $('#done-new').onclick = FBPOSApp.reset;

      // Navegar a Mercado Pago si aplica
      if (d.payment_url) {
        if (payWindow && !payWindow.closed) payWindow.location = d.payment_url;
        else window.open(d.payment_url, 'fbpos_mp_checkout');
      }
    } catch (e) {
      if (payWindow && !payWindow.closed) payWindow.close();
      $('#fbpos-message').textContent = e.message;

      // Si estamos convirtiendo un presupuesto y falla con "ya fue convertido",
      // recargar la lista de presupuestos
      if (FBPOSApp.state.quoteId && e.message && e.message.includes('ya fue convertido')) {
        setTimeout(() => {
          FBPOSApp.state.quoteId = null;
          FBPOSApp.loadQuoteHistory();
          FBPOSApp.go('quotes');
        }, 2000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirmar cobro';
    }
  };

  // Listener del botón de cobro
  $('#fbpos-charge').onclick = () => FBPOSApp.chargeOrder(false);

  /**
   * M2 FIX: Teardown de pollings al salir del checkout
   * Cuando se navega fuera (Nueva venta, Carrito, etc), detener todos los pollings
   */
  FBPOSApp.cleanupMixedPayments = function() {
    Object.keys(mixedState.pollingIntervals).forEach(key => {
      FBPOSApp.stopRowPolling(key);
    });
    mixedState.ticketRef = null;
    // Ronda 9, hallazgo 5: sin esto, el estado viejo sobrevivía a "Nueva venta" y podía
    // rehidratarse sobre un ticket distinto que casualmente diera el mismo total.
    sessionStorage.removeItem('fbpos_mixed_state');
  };

  /**
   * PUNTO 4 FIX: El wrapping de FBPOSApp.reset se hace en DOMContentLoaded para asegurar
   * que app.js ya haya cargado y definido la función original.
   * Si lo hacemos acá al nivel superior, checkout.js carga ANTES que app.js,
   * así que originalReset sería undefined y el wrapper se perdería cuando app.js pise la función.
   */
  document.addEventListener('DOMContentLoaded', () => {
    // En este punto, app.js ya cargó y FBPOSApp.reset está definido
    if (FBPOSApp.reset && typeof FBPOSApp.reset === 'function') {
      const originalReset = FBPOSApp.reset;
      FBPOSApp.reset = function() {
        FBPOSApp.cleanupMixedPayments();
        originalReset.call(this);
      };
    }
  });
})();
