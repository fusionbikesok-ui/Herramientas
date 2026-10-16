/**
 * FBPOSApp.customer
 * Lógica de identificación y gestión de clientes
 */
(function() {
  const $ = FBPOSApp.$;
  const $$ = FBPOSApp.$$;

  /**
   * Actualiza el resumen del cliente en la UI
   */
  FBPOSApp.updateCustomerSummary = function() {
    const c = FBPOSApp.state.customer;
    $('#fbpos-customer-summary').textContent = c ? c.name : 'Sin identificar';
    $('#fbpos-customer-meta').textContent = !c
      ? 'Elegí consumidor final o buscá por DNI/CUIT, nombre o apellido'
      : c.consumerFinal
        ? 'Consumidor final'
        : `${c.document_type || 'DNI'} ${c.document || '—'}${c.phone ? ' · ' + c.phone : ''}`;
  };

  /**
   * Abre el modal de identificación de cliente
   */
  FBPOSApp.openCustomer = function(action = null) {
    FBPOSApp.state.pendingAction = action;
    $('#fbpos-customer-modal').hidden = false;
    $('#fbpos-customer-form').hidden = true;
    $('#fbpos-customer-results').innerHTML = '';
  };

  /**
   * Cierra el modal de identificación de cliente
   */
  FBPOSApp.closeCustomer = function() {
    FBPOSApp.state.pendingAction = null;
    $('#fbpos-customer-modal').hidden = true;
  };

  /**
   * Continúa con la acción pendiente (quote o charge)
   */
  FBPOSApp.continuePending = async function() {
    const a = FBPOSApp.state.pendingAction;
    FBPOSApp.state.pendingAction = null;

    // Solo cerrar el modal si hay una acción pendiente
    if (a) {
      $('#fbpos-customer-modal').hidden = true;
    }

    if (a === 'quote') await FBPOSApp.makeQuote(true);
    if (a === 'charge') await FBPOSApp.chargeOrder(true);
  };

  /**
   * Rellena los campos del formulario de cliente
   */
  FBPOSApp.fillCustomer = function(c) {
    $('#fbpos-document-type').value = c.document_type || 'DNI';
    $('#fbpos-customer-document').value = c.document || '';

    // Determinar tipo de cliente según si tiene company o first_name/last_name
    const customerType = c.company ? 'company' : 'individual';
    $('#fbpos-customer-type').value = customerType;

    if (customerType === 'company') {
      $('#fbpos-customer-company').value = c.company || '';
      $('#fbpos-person-fields').hidden = true;
      $('#fbpos-company-fields').hidden = false;
    } else {
      $('#fbpos-customer-first-name').value = c.first_name || '';
      $('#fbpos-customer-last-name').value = c.last_name || '';
      $('#fbpos-person-fields').hidden = false;
      $('#fbpos-company-fields').hidden = true;
    }

    $('#fbpos-customer-phone').value = c.phone || '';
    $('#fbpos-customer-email').value = c.email || '';
    $('#fbpos-customer-address').value = c.address_1 || '';
    $('#fbpos-customer-city').value = c.city || '';
    $('#fbpos-customer-state').value = c.state || '';
    $('#fbpos-customer-postcode').value = c.postcode || '';

    FBPOSApp.state.customer = { ...c, consumerFinal: false };
  };

  /**
   * Busca clientes en la API
   */
  FBPOSApp.searchCustomer = async function() {
    const q = $('#fbpos-customer-document-search').value.trim();
    const isDocument = /^[\d.\-\s]+$/.test(q);
    const valid = isDocument ? q.replace(/\D/g, '').length >= 5 : q.length >= 2;

    if (!valid) {
      $('#fbpos-customer-results').innerHTML = `
        <div class="customer-notice">
          ${isDocument ? 'Ingresá al menos 5 números.' : 'Ingresá al menos 2 letras.'}
        </div>
      `;
      return;
    }

    $('#fbpos-customer-results').innerHTML = '<div class="customer-notice">Buscando clientes...</div>';

    try {
      const rows = await FBPOSApp.api('/customers?q=' + encodeURIComponent(q));

      if (!rows.length) {
        if (isDocument) {
          $('#fbpos-customer-document').value = q.replace(/\D/g, '');
        } else {
          // Asumir que es un nombre y poner en el primer campo de nombre
          const customerType = $('#fbpos-customer-type').value;
          if (customerType === 'company') {
            $('#fbpos-customer-company').value = q;
          } else {
            $('#fbpos-customer-first-name').value = q;
          }
        }

        $('#fbpos-customer-results').innerHTML =
          '<div class="customer-notice">No encontramos coincidencias. Podés cargar un cliente nuevo debajo.</div>';
        return;
      }

      // Mostrar resultados
      $('#fbpos-customer-results').innerHTML = rows
        .map(
          (c, i) => {
            // Construir nombre: razón social o nombre completo
            const displayName = c.company
              ? c.company
              : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name;
            return `
        <button class="customer-result" data-i="${i}" type="button">
          <strong>${displayName}</strong>
          <small>
            ${c.document ? `${c.document_type} ${c.document}` : 'Sin DNI/CUIT'}
            · ${c.phone || 'Sin teléfono'}
            ${c.email ? ' · ' + c.email : ''}
          </small>
        </button>
      `;
          }
        )
        .join('');

      // Listener para seleccionar cliente
      $('#fbpos-customer-results').onclick = async e => {
        const b = e.target.closest('.customer-result');
        if (!b) return;
        const selected = rows[+b.dataset.i];
        FBPOSApp.fillCustomer(selected);
        FBPOSApp.updateCustomerSummary();
        $('#fbpos-customer-results').innerHTML = '<div class="customer-notice ok">Cliente seleccionado. Continuando...</div>';
        await FBPOSApp.continuePending();
      };
    } catch (e) {
      $('#fbpos-customer-results').innerHTML = `<div class="customer-notice error">${e.message}</div>`;
    }
  };

  /**
   * Verifica si hay cliente identificado, abre modal si no
   */
  FBPOSApp.requireCustomer = function(action) {
    if (FBPOSApp.state.customer) return true;
    FBPOSApp.openCustomer(action);
    return false;
  };

  // === LISTENERS: Identificación de cliente ===
  $('#fbpos-identify-customer').onclick = () => FBPOSApp.openCustomer();
  $('#fbpos-close-customer').onclick = FBPOSApp.closeCustomer;

  // Consumidor final
  $('#fbpos-final-consumer').onclick = async () => {
    FBPOSApp.state.customer = {
      id: 0,
      name: 'Consumidor final',
      document: '',
      document_type: '',
      phone: '',
      email: '',
      consumerFinal: true
    };
    FBPOSApp.updateCustomerSummary();
    await FBPOSApp.continuePending();
  };

  // Mostrar formulario de búsqueda
  $('#fbpos-with-data').onclick = () => {
    $('#fbpos-customer-form').hidden = false;
    setTimeout(() => $('#fbpos-customer-document-search').focus(), 0);
  };

  // Cambiar tipo de documento (DNI/CUIT) → autoajusta tipo de cliente
  $('#fbpos-document-type').onchange = () => {
    const docType = $('#fbpos-document-type').value;
    const suggestedType = docType === 'CUIT' ? 'company' : 'individual';
    $('#fbpos-customer-type').value = suggestedType;
    FBPOSApp.updateCustomerTypeFields();
  };

  // Cambiar tipo de cliente (Persona física/Empresa) → mostrar/ocultar campos
  $('#fbpos-customer-type').onchange = () => FBPOSApp.updateCustomerTypeFields();

  /**
   * Actualiza la visibilidad de campos según el tipo de cliente
   */
  FBPOSApp.updateCustomerTypeFields = function() {
    const customerType = $('#fbpos-customer-type').value;
    if (customerType === 'company') {
      $('#fbpos-person-fields').hidden = true;
      $('#fbpos-company-fields').hidden = false;
      // Limpiar campos de persona física
      $('#fbpos-customer-first-name').value = '';
      $('#fbpos-customer-last-name').value = '';
    } else {
      $('#fbpos-person-fields').hidden = false;
      $('#fbpos-company-fields').hidden = true;
      // Limpiar campo de razón social
      $('#fbpos-customer-company').value = '';
    }
    FBPOSApp.showValidationMessages([]);
  };

  // Buscar cliente
  $('#fbpos-search-customer').onclick = FBPOSApp.searchCustomer;
  $('#fbpos-customer-document-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      FBPOSApp.searchCustomer();
    }
  });

  /**
   * Muestra mensajes de validación inline
   */
  FBPOSApp.showValidationMessages = function(messages) {
    const container = $('#fbpos-validation-messages');
    if (messages.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = messages
      .map(msg => `<div class="validation-error">${msg}</div>`)
      .join('');
  };

  /**
   * Valida el formulario y retorna errores (array vacío si válido)
   */
  FBPOSApp.validateCustomerForm = function() {
    const errors = [];
    const document = $('#fbpos-customer-document').value.replace(/\D/g, '');
    const customerType = $('#fbpos-customer-type').value;
    const phone = $('#fbpos-customer-phone').value.trim();
    const email = $('#fbpos-customer-email').value.trim();

    // Validar documento
    if (!document) {
      errors.push('Ingresá el DNI o CUIT.');
    } else if (document.length < 7) {
      errors.push('Ese DNI o CUIT parece incompleto — revisá los dígitos.');
    }

    // Validar nombre según tipo
    if (customerType === 'individual') {
      const firstName = $('#fbpos-customer-first-name').value.trim();
      const lastName = $('#fbpos-customer-last-name').value.trim();
      if (!firstName) {
        errors.push('Ingresá el nombre.');
      }
      if (!lastName) {
        errors.push('Ingresá el apellido.');
      }
    } else {
      const company = $('#fbpos-customer-company').value.trim();
      if (!company) {
        errors.push('Ingresá la razón social.');
      }
    }

    // Validar teléfono
    if (!phone) {
      errors.push('Ingresá un teléfono de contacto.');
    }

    // Validar email
    if (!email) {
      errors.push('Ingresá un email.');
    }

    return errors;
  };

  // Confirmar cliente
  $('#fbpos-confirm-customer').onclick = async () => {
    // Validar
    const validationErrors = FBPOSApp.validateCustomerForm();
    if (validationErrors.length > 0) {
      FBPOSApp.showValidationMessages(validationErrors);
      return;
    }
    FBPOSApp.showValidationMessages([]);

    const customerType = $('#fbpos-customer-type').value;
    const c = {
      id: FBPOSApp.state.customer?.id || 0,
      customer_type: customerType,
      document: $('#fbpos-customer-document').value.replace(/\D/g, ''),
      document_type: $('#fbpos-document-type').value,
      first_name: customerType === 'individual' ? $('#fbpos-customer-first-name').value.trim() : '',
      last_name: customerType === 'individual' ? $('#fbpos-customer-last-name').value.trim() : '',
      company_name: customerType === 'company' ? $('#fbpos-customer-company').value.trim() : '',
      phone: $('#fbpos-customer-phone').value.trim(),
      email: $('#fbpos-customer-email').value.trim(),
      address_1: $('#fbpos-customer-address').value.trim(),
      city: $('#fbpos-customer-city').value.trim(),
      state: $('#fbpos-customer-state').value.trim(),
      postcode: $('#fbpos-customer-postcode').value.trim(),
      consumerFinal: false
    };

    try {
      if ($('#fbpos-save-customer').checked) {
        const r = await FBPOSApp.api('/customer', {
          method: 'POST',
          body: JSON.stringify(c)
        });
        FBPOSApp.state.customer = { ...r.customer, consumerFinal: false };
      } else {
        FBPOSApp.state.customer = c;
      }

      FBPOSApp.updateCustomerSummary();
      $('#fbpos-customer-modal').hidden = true;
      await FBPOSApp.continuePending();
    } catch (e) {
      FBPOSApp.showValidationMessages([e.message]);
    }
  };

  /**
   * Inicializa el modal de cliente al cargar la página
   */
  FBPOSApp.initializeCustomerForm = function() {
    // Asegurar que el tipo de cliente sea "individual" por defecto
    $('#fbpos-customer-type').value = 'individual';
    // Mostrar campos de Persona física por defecto
    $('#fbpos-person-fields').hidden = false;
    $('#fbpos-company-fields').hidden = true;
    // Limpiar mensajes de validación
    FBPOSApp.showValidationMessages([]);
  };

  // Inicializar cuando el DOM esté listo
  document.addEventListener('DOMContentLoaded', FBPOSApp.initializeCustomerForm);
})();
