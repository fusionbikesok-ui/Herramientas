/*
 * Catálogo y vínculos (Fase D). Script clásico, sin build. Depende de ../lib/api.js y ../lib/format.js.
 * Contrato: docs/superpowers/specs/2026-10-09-fase-d-catalogo-y-vinculos.md (R1-R7) y el diseño visual
 * 2026-10-09-fase-d-diseno-ui.md. Lo que el servidor decide (permisos, versiones, veto) se respeta acá,
 * pero el servidor manda: la pantalla solo oculta/deshabilita para no ofrecer lo que va a dar 403.
 */
(function () {
  'use strict';

  var API = '/api/catalogo-vinculos';
  var IDENT = '/api/identidad-productos';
  var LIMITE_COLA = 50;
  var FILTROS = [['abiertos', 'Abiertos'], ['salteados', 'Salteados'], ['intervencion', 'En intervención'], ['pausadas', 'Pausadas']];
  var CAMPO_TXT = { titulo: 'el título', sku: 'el SKU', gtin: 'el GTIN', color: 'el color', talle: 'el talle',
    rodado: 'el rodado', transmision: 'la transmisión', velocidades: 'las velocidades' };
  var ICONO = { rojo: '✗', ambar: '⚠', verde: '✓', gris: '–' };
  var ESTADO_OP = { shadow: 'encolada', pendiente: 'encolada', procesando: 'encolada', verificando: 'encolada',
    completada: 'aplicada', fallida: 'fallida', intervencion: 'frenada', bloqueada_impacto: 'frenada' };
  var MSG = {
    NOT_FOUND: 'Este caso ya no existe. Se resolvió o lo sacaron.',
    INVALID_INPUT: 'Falta completar un dato (por ejemplo, el motivo). Revisá lo marcado.',
    omitir_requiere_override: 'Esta publicación está en "no sincronizar". Quitalo antes de vincular.',
    INVALID_STATE: 'Este caso no admite esa acción en su estado actual.',
    OPERACION_DUPLICADA: 'Ya se mandó este cambio. Mirá su estado en Ejecución.'
  };
  var MSG_ERROR_SIN_RED = 'Sin conexión. No se guardó nada.';

  var esc = (window.Fmt && window.Fmt.esc) || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  };
  var money = (window.Fmt && window.Fmt.money) || function (x) { return x == null ? '—' : '$ ' + Number(x).toLocaleString('es-AR'); };
  var fecha = (window.Fmt && window.Fmt.fecha) || function (s) { return s ? String(s) : '—'; };
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function enc(s) { return encodeURIComponent(s); }
  function uuid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function atajoTxt(k) { return '<kbd class="cv-kbd-accion" aria-hidden="true">' + k + '</kbd>'; }
  function cuentaCampos(motivos) {
    var campos = (motivos || []).map(function (m) { return CAMPO_TXT[m.campo] || m.etiqueta || m.campo; });
    return campos.length ? campos.join(', ') : 'los atributos marcados';
  }

  // ── Estado de la pantalla ──────────────────────────────────────────────────────────────────────
  var S = {
    isAdmin: false, canWrite: false,
    tab: 'casos', offline: false, busy: null,
    filtro: 'abiertos', conteos: {}, cola: [], colaError: null, colaCargada: false,
    casoId: null, detalle: null, detalleError: null, ejec: null,
    candidatos: null, candidatosError: null, elegido: null, queryCand: '', soloDif: false, fotoGrande: false,
    guardado: null, conflictoVersion: null, hermanas: null, accionError: null,
    nsOpId: null, nsVariante: null, nsConfirm: false, nsEnviando: false,
    deshacer: null, deshacerTimer: null,
    opIds: {}, dlgActivo: null, dlgDisparador: null,
    ejecEstados: null, ejecPoll: null, ejecError: null,
    retenidas: null, retError: null, retAbierta: null, retAviso: {},
    vincResultados: null, vincQ: '', conflictos: null, conflictosError: null, conflictoAbierto: null, conflictoDetalle: null
  };

  // ── Red ───────────────────────────────────────────────────────────────────────────────────────
  function llamar(metodo, url, body) {
    var opts = { method: metodo, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (r) {
      setOffline(false);
      return r.text().then(function (txt) {
        var d = {};
        try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = { ok: false, error: 'Respuesta inválida del servidor' }; }
        return { status: r.status, ok: r.ok && d.ok !== false, data: d };
      });
    }, function () {
      setOffline(true);
      return { red: true, status: 0, ok: false, data: {} };
    });
  }
  function api(metodo, ruta, body) { return llamar(metodo, API + ruta, body); }
  function identidad(ruta) { return llamar('GET', IDENT + ruta); }

  function mensajeDe(res) {
    if (res.red) return MSG_ERROR_SIN_RED;
    if (res.status === 403) return 'Esto lo hace José.';
    var d = res.data || {};
    if (d.code === 'contradiccion_titulo') return 'No se puede vincular: difiere ' + cuentaCampos(d.motivos) + '. Lo confirma José.';
    if (d.code === 'SIN_CAMBIO_SKU') {
      var pausada = S.detalle && S.detalle.caso && S.detalle.caso.publicacion && S.detalle.caso.publicacion.status === 'paused';
      return pausada ? 'Vínculo actualizado, ML ya tenía este SKU.' : 'Activa: ML ya tiene este SKU, no hay nada que cambiar.';
    }
    if (MSG[d.code]) return MSG[d.code];
    return d.error || ('Error HTTP ' + res.status);
  }

  function setOffline(v) {
    if (S.offline === v) return;
    S.offline = v;
    var b = $('#cv-offline');
    b.hidden = !v;
    aplicarBloqueo();
  }

  // Acciones deshabilitadas por falta de conexión o por operación en curso (aria-disabled, no disabled).
  function aplicarBloqueo() {
    $$('[data-accion]').forEach(function (el) {
      var accion = el.getAttribute('data-accion');
      if (accion === 'tab' || accion === 'reintentar-carga' || accion === 'volver-cola') return;
      var bloquear = S.offline || (S.busy && S.busy !== accion);
      el.setAttribute('aria-disabled', bloquear ? 'true' : 'false');
    });
  }

  function anunciar(texto, nivel) {
    var v = $('#cv-live');
    if (!v) return;
    v.setAttribute('role', nivel === 'alerta' ? 'alert' : 'status');
    v.textContent = '';
    setTimeout(function () { v.textContent = texto; }, 30);
  }

  // ── Franja, filtros y cola ─────────────────────────────────────────────────────────────────────
  function cuentaLista(x) { return Array.isArray(x) ? x.length : Number(x) || 0; }

  function cargarEstado() {
    var cont = $('#cv-estado');
    cont.setAttribute('aria-busy', 'true');
    return api('GET', '/estado').then(function (r) {
      cont.setAttribute('aria-busy', 'false');
      if (!r.ok) { cont.innerHTML = cajaError(mensajeDe(r), 'cargarEstado'); return; }
      var e = r.data.data || {};
      var salud = e.salud || {};
      var conc = e.conciliacion || {};
      var bolsa = cuentaLista(e.conflictos_bolsa);
      var sinRespaldo = cuentaLista(e.sin_respaldo_woo);
      var protec = cuentaLista(e.esperando_proteccion);
      var chips = [
        { txt: salud.sano ? 'Lectura sana' : (salud.degradado ? 'Lectura degradada' : 'Lectura con observación'),
          clase: salud.sano ? '' : 'alerta', icono: salud.sano ? '' : '⚠ ', lbl: 'Salud de lectura', filtro: 'abiertos' },
        { txt: conc.exacta ? 'Exacta' : 'Sin conciliar', clase: conc.exacta ? '' : 'alerta', icono: conc.exacta ? '' : '⚠ ', lbl: 'Conciliación', filtro: 'abiertos' },
        { txt: String(bolsa), clase: bolsa > 0 ? 'alerta' : '', icono: bolsa > 0 ? '⚠ ' : '', lbl: 'Conflictos de bolsa compartida', filtro: 'abiertos' },
        { txt: String(sinRespaldo), clase: sinRespaldo > 0 ? 'critico' : '', icono: sinRespaldo > 0 ? '✗ ' : '', lbl: 'Vendiendo sin respaldo en Woo', filtro: 'abiertos' },
        { txt: String(protec), clase: protec > 0 ? 'alerta' : '', icono: protec > 0 ? '⚠ ' : '', lbl: 'Protección pendiente', filtro: 'abiertos' }
      ];
      cont.innerHTML = chips.map(function (c) {
        return '<a href="#cv-cola" class="cv-chip-salud' + (c.clase ? ' cv-chip-salud--' + c.clase : '') + '" data-accion="ir-filtro" data-filtro="' + c.filtro + '">'
          + '<span>' + esc(c.lbl) + ':</span> <b>' + c.icono + esc(c.txt) + '</b></a>';
      }).join('');
    });
  }

  function renderFiltros() {
    $('#cv-filtros').innerHTML = FILTROS.map(function (f) {
      var n = S.conteos[f[0]];
      var on = S.filtro === f[0];
      return '<button type="button" class="ui-chip" data-accion="filtro" data-filtro="' + f[0] + '" aria-pressed="' + on + '">'
        + esc(f[1]) + (n != null ? ' <span>(' + n + ')</span>' : '') + '</button>';
    }).join('');
  }

  function chipsCaso(f) {
    var c = f.chips || {};
    var out = '';
    if (c.pausada) out += '<span class="ui-chip">⏸ PAUSADA</span>';
    if (c.hermanas > 0) out += '<span class="ui-chip">⧉ HERMANAS ' + c.hermanas + '</span>';
    if (c.intervencion) out += '<span class="ui-chip ui-chip--urgente"><span class="cv-lock-ico" aria-hidden="true">🔒</span> INTERVENCIÓN</span>';
    return out;
  }

  function renderCola() {
    var cont = $('#cv-cola');
    cont.setAttribute('aria-busy', 'false');
    if (S.colaError) {
      cont.innerHTML = cajaError(S.colaError, 'cargarCola');
      return;
    }
    if (!S.cola.length) {
      cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>No hay casos abiertos</p>'
        + (S.filtro === 'abiertos' ? '<button type="button" class="ui-btn" data-accion="filtro" data-filtro="salteados">Ver salteados</button>' : '')
        + '</div>';
      return;
    }
    cont.classList.toggle('cv-cola--scroll', S.cola.length > 6);
    var titulo = $('#cola-titulo');
    if (titulo) titulo.textContent = 'Cola · ' + S.cola.length + (S.cola.length > 6 ? ' casos' : (S.cola.length === 1 ? ' caso' : ' casos'));
    var idx = S.cola.findIndex(function (f) { return f.caso_id === S.casoId; });
    var foco = idx >= 0 ? idx : 0;
    cont.innerHTML = S.cola.map(function (f, i) {
      var sel = f.caso_id === S.casoId;
      var plata = f.plata > 0
        ? '<span class="cv-plata">' + esc(money(f.plata)) + ' en juego</span>'
        : '<span class="cv-plata cv-plata--cero">Sin plata en juego</span>';
      return '<button type="button" role="option" class="cv-caso" data-accion="abrir" data-caso="' + f.caso_id + '"'
        + ' aria-selected="' + sel + '" tabindex="' + (i === foco ? '0' : '-1') + '">'
        + '<span class="cv-caso__titulo">' + esc(f.titulo || f.ml_key) + '</span>'
        + '<span class="cv-caso__motivo">' + esc(f.motivo || '') + '</span>'
        + (f.salteado_por ? '<span class="cv-salteado">↷ Salteado por ' + esc(f.salteado_por) + '</span>' : '')
        + '<span class="cv-caso__pie">' + plata + '<span class="cv-chips">' + chipsCaso(f) + '</span></span>'
        + '</button>';
    }).join('');
  }

  function cajaError(texto, reintento) {
    return '<div class="api-estado api-estado--error" role="alert"><p>' + esc(texto) + '</p>'
      + '<button type="button" class="btn-reintentar cv-btn-44" data-accion="reintentar-carga" data-reintento="' + reintento + '">Reintentar</button></div>';
  }

  function cargarCola(opts) {
    opts = opts || {};
    var cont = $('#cv-cola');
    cont.setAttribute('aria-busy', 'true');
    if (!S.colaCargada) cont.innerHTML = '<div class="cv-skeleton"></div><div class="cv-skeleton"></div><div class="cv-skeleton"></div>';
    return api('GET', '/cola?filtro=' + S.filtro + '&limit=' + LIMITE_COLA).then(function (r) {
      S.colaCargada = true;
      if (!r.ok) { S.colaError = mensajeDe(r); S.cola = []; renderCola(); return; }
      S.colaError = null;
      S.cola = r.data.data || [];
      $('#cnt-casos').textContent = '· ' + (r.data.total != null ? r.data.total : S.cola.length);
      renderFiltros();
      renderCola();
      if (opts.seleccionar !== false) {
        var sigue = S.cola.some(function (f) { return f.caso_id === S.casoId; });
        if (!sigue && S.cola.length) abrirCaso(S.cola[0].caso_id, { foco: false });
        else if (!S.cola.length) { S.casoId = null; S.detalle = null; renderDetalleVacio(); }
      }
    });
  }

  function cargarConteos() {
    return Promise.all(FILTROS.map(function (f) {
      return api('GET', '/cola?filtro=' + f[0] + '&limit=1').then(function (r) {
        if (r.ok) S.conteos[f[0]] = r.data.total;
      });
    })).then(renderFiltros);
  }

  function renderDetalleVacio() {
    var d = $('#cv-detalle');
    d.setAttribute('aria-busy', 'false');
    d.innerHTML = '<p class="cv-vacio-det">Elegí un caso de la cola.</p>';
  }

  // ── Detalle ────────────────────────────────────────────────────────────────────────────────────
  function abrirCaso(id, opts) {
    opts = opts || {};
    S.casoId = id;
    S.candidatos = null; S.candidatosError = null; S.elegido = null; S.hermanas = null;
    S.accionError = null; S.conflictoVersion = null; S.retAbierta = null;
    var d = $('#cv-detalle');
    d.setAttribute('aria-busy', 'true');
    d.innerHTML = '<div class="cv-skeleton cv-skeleton--det"></div>';
    marcarSeleccionEnCola();
    return Promise.all([api('GET', '/casos/' + id), api('GET', '/ejecucion')]).then(function (rs) {
      var r = rs[0];
      if (S.casoId !== id) return; // el usuario ya eligió otro caso
      if (r.status === 404) {
        S.detalle = null; S.detalleError = mensajeDe(r);
        d.setAttribute('aria-busy', 'false');
        d.innerHTML = cajaError(S.detalleError, 'cargarCola');
        return cargarCola({ seleccionar: false });
      }
      if (!r.ok) { S.detalle = null; S.detalleError = mensajeDe(r); return renderDetalle(); }
      S.detalleError = null;
      S.detalle = r.data.data;
      if (rs[1].ok) S.ejec = rs[1].data.data;
      var pub = S.detalle.caso.publicacion || {};
      return buscarCandidatos(S.queryCand || S.detalle.caso.publicacion?.titulo || '').then(function () {
        renderDetalle();
        if (opts.foco) enfocarDetalle();
      });
    });
  }

  function marcarSeleccionEnCola() {
    $$('#cv-cola [role="option"]').forEach(function (o) {
      var sel = Number(o.getAttribute('data-caso')) === S.casoId;
      o.setAttribute('aria-selected', sel ? 'true' : 'false');
      o.setAttribute('tabindex', sel ? '0' : '-1');
    });
  }

  function enfocarDetalle() {
    var t = $('#det-titulo');
    if (window.innerWidth < 1024 && t) t.scrollIntoView({ block: 'start' });
    if (t) t.focus();
  }

  function buscarCandidatos(q) {
    S.queryCand = q || '';
    var pub = (S.detalle && S.detalle.caso && S.detalle.caso.publicacion) || {};
    if (!S.queryCand.trim()) { S.candidatos = []; return Promise.resolve(); }
    var extra = (pub.gtin ? '&gtin_ml=' + enc(pub.gtin) : '') + (pub.seller_sku ? '&sku_ml=' + enc(pub.seller_sku) : '');
    return identidad('/productos/buscar?q=' + enc(S.queryCand.trim()) + extra).then(function (r) {
      if (!r.ok) { S.candidatosError = mensajeDe(r); S.candidatos = []; return; }
      S.candidatosError = null;
      S.candidatos = (r.data.data || []).slice(0, 3);
    });
  }

  function elegirCandidato(idx) {
    var c = (S.candidatos || [])[idx];
    if (!c || !S.detalle) return Promise.resolve();
    S.elegido = c;
    S.accionError = null;
    return api('GET', '/casos/' + S.casoId + '?sku=' + enc(c.sku_woo || '')).then(function (r) {
      if (r.ok && S.elegido === c) S.detalle.matriz = r.data.data.matriz;
      renderDetalle();
    });
  }

  function opIdPara(clave) {
    if (!S.opIds[clave]) S.opIds[clave] = uuid();
    return S.opIds[clave];
  }
  function soltarOpId(clave) { delete S.opIds[clave]; }

  function caso() { return S.detalle && S.detalle.caso; }
  function casoEnCola() { return S.cola.find(function (f) { return f.caso_id === S.casoId; }) || null; }

  function operacionDelCaso() {
    var ops = (S.ejec && S.ejec.operaciones) || [];
    return ops.find(function (o) { return o.caso_id === S.casoId && ['fallida', 'intervencion', 'bloqueada_impacto'].indexOf(o.estado) !== -1; }) || null;
  }

  function tarjetaOperacion() {
    var o = operacionDelCaso();
    if (!o) return '';
    var esFallida = o.estado === 'fallida';
    var titulo = esFallida ? '✗ ML la rechazó' : '⏸ Frenada';
    var motivo = o.ultimo_error || (esFallida ? 'sin detalle' : 'regla de protección');
    var accion = esFallida ? 'Reintenta José.' : 'Stock en 0 hasta resolver.';
    var texto = esFallida ? 'ML la rechazó: ' + motivo + '. ' + accion : 'Frenada: ' + motivo + '. ' + accion;
    return '<section class="cv-tarjeta-op" role="region" aria-label="Operación con problema" tabindex="-1">'
      + '<h3>' + titulo + '</h3><p>' + esc(texto) + '</p>'
      + '<p><a href="#cv-ejec" data-accion="ir-ejecucion">Ver en Ejecución</a>'
      + (S.retenidasDelCaso ? ' · <a href="#cv-ret" data-accion="ir-retenidas">Ver ' + S.retenidasDelCaso + ' ventas retenidas</a>' : '')
      + '</p></section>';
  }

  function semaforoHtml(f) {
    var leve = f.campo === 'gtin' && f.semaforo === 'ambar' && f.texto === 'Difiere';
    return '<span class="cv-sem cv-sem--' + f.semaforo + '"><span aria-hidden="true">' + ICONO[f.semaforo] + '</span> ' + esc(f.texto) + '</span>'
      + (leve ? ' <span class="cv-sem cv-sem--leve">leve<span class="sr-only">: sigue vendiendo</span></span>' : '');
  }

  function matrizHtml() {
    var m = caso() && S.detalle.matriz;
    if (!S.elegido) return '<p class="ui-resumen cv-matriz-vacia">Elegí un candidato para ver la comparación de atributos.</p>';
    if (!m || !m.filas || !m.filas.length) return '<p class="ui-resumen">Sin datos para comparar.</p>';
    var filas = m.filas.map(function (f) {
      var ocultar = S.soloDif && (f.semaforo === 'verde' || f.semaforo === 'gris');
      var clase = f.semaforo === 'rojo' ? 'cv-fila--rojo' : (f.semaforo === 'verde' ? 'cv-fila--verde' : (f.semaforo === 'gris' ? 'cv-fila--gris' : ''));
      var idClase = (f.campo === 'sku' || f.campo === 'gtin') ? ' class="ui-id"' : '';
      var ml = f.ml != null ? '<span' + idClase + '>' + esc(f.ml) + '</span>' : '—';
      var cand = f.candidato != null ? '<span' + idClase + '>' + esc(f.candidato) + '</span>' : '—';
      return '<tr class="' + clase + (ocultar ? ' cv-fila--oculta' : '') + '" data-semaforo="' + f.semaforo + '">'
        + '<th scope="row">' + esc(f.etiqueta) + '</th>'
        + '<td data-label="Publicación ML">' + ml + '</td>'
        + '<td data-label="Candidato elegido">' + cand + '</td>'
        + '<td data-label="Estado" data-col="estado">' + semaforoHtml(f) + '</td></tr>';
    }).join('');
    return '<table class="cv-matriz"><caption class="sr-only">Comparación de atributos: publicación ML contra el candidato elegido</caption>'
      + '<thead><tr><th scope="col">Atributo</th><th scope="col">Publicación ML</th><th scope="col">Candidato elegido</th><th scope="col">Estado</th></tr></thead>'
      + '<tbody>' + filas + '</tbody></table>';
  }

  function datosHtml() {
    var c = caso(); var obs = S.detalle.observado_ml || {}; var regla = S.detalle.regla || {};
    var estadoML = obs.estado === 'active' ? 'Activa' : (obs.estado === 'paused' ? 'Pausada' : (obs.estado || 'sin dato'));
    var reglaTxt = regla.frena ? 'Stock 0 por ' + (regla.motivo || 'protección') : ('Stock de Woo ' + (regla.stock_esperado != null ? regla.stock_esperado : 'sin dato'));
    var desfase = S.detalle.ml_no_refleja_regla
      ? '<div class="ui-aviso ui-aviso--atencion cv-aviso-desfase cv-aviso-fijo" role="note"><span class="cv-icono" aria-hidden="true">⚠</span><span>ML todavía no refleja la regla.</span></div>' : '';
    return '<div class="cv-datos">'
      + '<div class="cv-dato ui-panel"><h3 class="ui-label">Observado en ML</h3><p class="cv-dato__valor">' + esc(estadoML) + ' · cantidad ' + esc(obs.cantidad != null ? obs.cantidad : 'sin dato') + '</p></div>'
      + '<div class="cv-dato ui-panel"><h3 class="ui-label">Lo que manda la regla</h3><p class="cv-dato__valor">' + esc(reglaTxt) + '</p></div>'
      + '</div>' + desfase;
  }

  function candidatosHtml(soloLectura) {
    if (soloLectura) return '';
    var lista = S.candidatos || [];
    var filas = lista.map(function (p, i) {
      var sel = S.elegido && S.elegido.id === p.id;
      return '<button type="button" class="cv-cand' + (S.fotoGrande ? ' cv-cand--grande' : '') + '" data-accion="elegir" data-idx="' + i + '" aria-pressed="' + !!sel + '">'
        + '<span class="cv-cand__num" aria-hidden="true">' + (i + 1) + '</span>'
        + (p.img ? '<img class="cv-cand__img" src="' + esc(p.img) + '" alt="" loading="lazy">' : '<span class="cv-cand__img" aria-hidden="true"></span>')
        + '<span><span class="cv-cand__nombre">' + esc(p.nombre_canonico || p.nombre_woo || 'Producto') + '</span><br>'
        + '<span class="cv-cand__sku">SKU <span class="ui-id">' + esc(p.sku_woo || p.fusion_sku || '—') + '</span></span></span>'
        + '<span class="cv-cand__estado">' + (sel ? '✓ Elegido' : '') + '</span></button>';
    }).join('');
    var error = S.candidatosError ? '<p class="cv-error">' + esc(S.candidatosError) + '</p>' : '';
    var vacio = (!lista.length && !S.candidatosError) ? '<p class="ui-resumen">Sin candidatos para esa búsqueda. Probá con otro texto.</p>' : '';
    return '<section class="cv-bloque" aria-labelledby="cand-h">'
      + '<h3 id="cand-h" class="ui-label">Candidatos (1, 2 o 3 para elegir · sin preselección)</h3>'
      + '<form id="det-buscar" class="cv-buscador__fila" role="search" data-accion="buscar-cand">'
      + '<label class="sr-only" for="det-q">Buscar otra variante de producto</label>'
      + '<input id="det-q" class="ui-input" type="search" autocomplete="off" value="' + esc(S.queryCand) + '">'
      + '<button type="submit" class="ui-btn">Buscar</button></form>'
      + error + vacio
      + '<div class="cv-cands" role="group" aria-label="Candidatos">' + filas + '</div></section>';
  }

  function renderDetalle() {
    var d = $('#cv-detalle');
    d.setAttribute('aria-busy', 'false');
    if (S.detalleError && !S.detalle) { d.innerHTML = cajaError(S.detalleError, 'reabrirCaso'); return; }
    if (!S.detalle) return renderDetalleVacio();
    var c = caso(); var pub = c.publicacion || {};
    var enIntervencion = c.estado === 'intervencion';
    var soloLectura = enIntervencion && !S.isAdmin;
    var en = casoEnCola();
    var chips = [];
    if (pub.status === 'paused') chips.push('<span class="ui-chip">⏸ PAUSADA</span>');
    if (en && en.chips && en.chips.hermanas > 0) chips.push('<span class="ui-chip">⧉ HERMANAS ' + en.chips.hermanas + '</span>');
    if (enIntervencion) chips.push('<span class="ui-chip ui-chip--urgente"><span aria-hidden="true">🔒</span> INTERVENCIÓN</span>');
    var guardado = S.guardado ? barraGuardado() : '';
    var lectura = enIntervencion
      ? '<p class="cv-lock">En intervención. ' + (S.isAdmin ? 'Lo destrabás vos.' : 'Lo destraba José.') + '</p>' : '';
    var html = guardado
      + '<button type="button" class="ui-btn cv-volver" data-accion="volver-cola">← Volver a la cola</button>'
      + '<div class="cv-det__cabecera"><h2 id="det-titulo" tabindex="-1">' + esc(pub.titulo || c.ml_key) + '</h2>'
      + '<div class="cv-det__meta"><span class="ui-id">' + esc(pub.item_id || c.ml_key) + '</span> ' + chips.join(' ') + '</div>'
      + lectura + '</div>'
      + tarjetaOperacion()
      + datosHtml()
      + candidatosHtml(soloLectura)
      + (S.candidatos && !soloLectura ? '' : '')
      + '<div class="cv-matriz-wrap"><div class="cv-matriz-cab"><button type="button" class="ui-btn" data-accion="solo-dif" aria-pressed="' + S.soloDif + '">Solo diferencias <kbd aria-hidden="true">d</kbd></button></div>' + matrizHtml() + '</div>'
      + (soloLectura ? '' : accionesHtml())
      + (S.accionError ? '<div class="ui-aviso ui-aviso--critico cv-aviso-fijo cv-aviso-rojo" role="alert" tabindex="-1" id="err-accion"><span class="cv-icono" aria-hidden="true">✗</span><span>' + esc(S.accionError) + '</span></div>' : '');
    d.innerHTML = html;
    aplicarBloqueo();
    if (S.focoPendiente) { var f = $(S.focoPendiente); if (f) f.focus(); S.focoPendiente = null; }
    var q = $('#det-q'); if (q && S.queryCand) q.value = S.queryCand;
  }

  function barraGuardado() {
    var g = S.guardado;
    var cuenta = '';
    if (S.deshacer && S.deshacer.caso === g.caso) {
      cuenta = S.deshacer.vencido
        ? '<span class="cv-deshacer">Ya no se puede deshacer</span>'
        : '<button type="button" class="ui-btn" data-accion="deshacer">Deshacer (10 s)' + atajoTxt('z') + ' · <span id="cv-deshacer-txt">' + esc(textoDeshacer()) + '</span></button>';
    }
    return '<div class="ui-aviso ui-aviso--ok cv-guardado" role="status" aria-live="polite">'
      + '<span>' + esc(g.texto) + '</span>' + cuenta + '</div>';
  }

  function accionesHtml() {
    var c = caso();
    var en = casoEnCola();
    if (S.hermanas) return hermanasHtml();
    if (S.conflictoVersion) return conflictoHtml();
    var m = S.detalle.matriz || {};
    var veto = !!(S.elegido && m.veto);
    var razon = '';
    if (S.offline) razon = MSG_ERROR_SIN_RED;
    else if (!S.elegido) razon = 'Elegí un candidato para vincular.';
    else if (veto) razon = 'No se puede vincular: difiere ' + cuentaCampos(m.motivos) + '. Lo confirma José.';
    var bloqueado = !!(S.offline || !S.elegido || veto || S.busy);
    var vinc = '<button type="button" class="ui-btn ui-btn--primario cv-btn-primario-movil" data-accion="vincular" aria-disabled="' + bloqueado + '"'
      + (razon ? ' aria-describedby="razon-vincular"' : '') + '>'
      + (S.busy === 'vincular' ? '<span class="cv-girando" aria-hidden="true">↻</span> Guardando…' : 'Vincular' + atajoTxt('Enter'))
      + '</button>';
    var razonHtml = razon ? '<p id="razon-vincular" class="cv-acciones__razon' + (veto || S.offline ? '' : ' cv-acciones__razon--neutra') + '">' + esc(razon) + '</p>' : '';
    var acciones = '<div class="cv-acciones__grid">'
      + '<button type="button" class="ui-btn" data-accion="saltear" aria-disabled="' + !!S.busy + '">Saltear' + atajoTxt('s') + '</button>'
      + '<button type="button" class="ui-btn" data-accion="no-sincronizar" aria-disabled="' + !!S.busy + '">No sincronizar' + atajoTxt('n') + '</button>'
      + '</div>';
    var admin = '';
    if (S.isAdmin) {
      admin = '<div class="cv-grupo-solo-jose"><p class="ui-label cv-lock">Solo José</p><div class="cv-acciones__fila">'
        + (veto ? '<button type="button" class="ui-btn ui-btn--peligro" data-accion="admin" data-admin="confirmar">Confirmar igual</button>' : '')
        + '<button type="button" class="ui-btn" data-accion="admin" data-admin="link">Link de pago</button>'
        + '</div>'
        + (S.adminForm ? adminFormHtml() : '') + '</div>';
    }
    var deshacer = '';
    return '<div class="cv-acciones" role="group" aria-label="Acciones del caso">'
      + '<div class="cv-acciones__fila">' + vinc + '</div>' + razonHtml
      + acciones + deshacer + admin + '</div>';
  }

  function adminFormHtml() {
    var tipo = S.adminForm;
    var titulo = { confirmar: 'Confirmar igual · vincula pese a la contradicción', link: 'Link de pago · ignora stock y ventas', destrabar: 'Destrabar · vuelve a pendiente' }[tipo] || '';
    return '<form class="cv-cuadro-motivo" data-accion="admin-enviar" data-admin="' + tipo + '" novalidate>'
      + '<p class="ui-label">' + esc(titulo) + '</p>'
      + '<label class="ui-label" for="adm-motivo">Motivo <span>(obligatorio)</span></label>'
      + '<textarea id="adm-motivo" class="ui-input" rows="2" aria-describedby="adm-err"></textarea>'
      + '<p id="adm-err" class="cv-error" hidden></p>'
      + '<div class="cv-acciones__fila"><button type="submit" class="ui-btn ui-btn--peligro">Confirmar</button>'
      + '<button type="button" class="ui-btn" data-accion="admin-cancelar">Cancelar</button></div></form>';
  }

  function hermanasHtml() {
    var n = S.hermanas.n;
    return '<div class="ui-aviso ui-aviso--atencion cv-foco-bloque" role="alert" tabindex="-1" id="bloque-hermanas">'
      + '<p><span aria-hidden="true">⚠</span> Esto cambia también ' + n + ' publicaciones hermanas. ¿Seguimos?</p>'
      + '<div class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="hermanas-si">Vincular las ' + n + '</button>'
      + '<button type="button" class="ui-btn" data-accion="hermanas-no">Volver</button></div></div>';
  }

  function conflictoHtml() {
    var cv = S.conflictoVersion;
    return '<div class="ui-aviso ui-aviso--atencion cv-foco-bloque" role="alert" tabindex="-1" id="bloque-conflicto">'
      + '<p><strong>⚠ Alguien cambió este caso.</strong> Se recargó con la versión nueva. ' + esc(cv.diff) + '</p>'
      + '<div class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="conflicto-aplicar">Aplicar mi decisión sobre la versión nueva</button>'
      + '<button type="button" class="ui-btn" data-accion="conflicto-descartar">Descartar mi decisión</button></div></div>';
  }

  // ── Acciones de caso ───────────────────────────────────────────────────────────────────────────
  function cuerpoVincular(extra) {
    var c = caso(); var cand = S.elegido;
    return Object.assign({ tipo: 'vincular', product_id: cand.id, operation_id: opIdPara('vincular:' + c.id + ':' + cand.id),
      expected_version: c.expected_version, evidence_fingerprint: c.evidencia_fingerprint }, extra || {});
  }

  function vincular(extra) {
    if (!S.elegido || !caso() || S.busy || S.offline) return;
    var m = S.detalle.matriz || {};
    if (m.veto && !(extra && extra.override_contradiccion)) return; // Enter no hace nada con rojo
    var c = caso();
    var body = cuerpoVincular(extra);
    S.busy = 'vincular'; S.accionError = null; S.hermanas = null;
    renderDetalle();
    api('POST', '/casos/' + c.id + '/decisiones', body).then(function (r) {
      S.busy = null;
      if (r.red) { S.accionError = MSG_ERROR_SIN_RED; return renderDetalle(); }
      if (r.ok) { soltarOpId('vincular:' + c.id + ':' + S.elegido.id); return guardadoOk(c, 'Guardado · En cola para ML', 'vincular'); }
      if (r.status === 409 && r.data.code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED') {
        S.hermanas = { n: r.data.sibling_count, body: body };
        return renderDetalle();
      }
      if (r.status === 409 && (r.data.code === 'VERSION_CONFLICT' || r.data.code === 'EVIDENCE_CONFLICT')) {
        soltarOpId('vincular:' + c.id + ':' + S.elegido.id);
        S.conflictoVersion = { body: body, diff: 'Cambió la versión del caso.' };
        return abrirCaso(c.id).then(function () { S.conflictoVersion = { body: body, diff: 'Cambió la versión del caso.' }; renderDetalle(); });
      }
      soltarOpId('vincular:' + c.id + ':' + S.elegido.id);
      S.accionError = mensajeDe(r);
      renderDetalle();
      refrescarEjecucion();
    });
  }

  function guardadoOk(c, texto, accion) {
    S.guardado = { caso: c.id, texto: texto, titulo: c.publicacion && c.publicacion.titulo };
    S.elegido = null; S.candidatos = null; S.hermanas = null; S.adminForm = null; S.accionError = null;
    S.focoPendiente = null;
    anunciar('Guardado: ' + (c.publicacion && c.publicacion.titulo ? c.publicacion.titulo : 'caso') + '. ' + texto, 'estado');
    if (accion === 'ns-b') S.guardado.texto = 'En cola para ML · mirá Ejecución';
    siguienteCaso();
  }

  // Al guardar o saltear, la cola pasa al siguiente caso (criterio: "La tarjeta de cola pasa al siguiente").
  function siguienteCaso() {
    var idx = S.cola.findIndex(function (f) { return f.caso_id === S.casoId; });
    var siguiente = idx >= 0 && S.cola[idx + 1] ? S.cola[idx + 1].caso_id : null;
    S.casoId = null;
    return cargarCola({ seleccionar: false }).then(function () {
      var quedan = S.cola.length ? S.cola : [];
      var id = quedan.some(function (f) { return f.caso_id === siguiente; }) ? siguiente : (quedan[0] && quedan[0].caso_id);
      if (id) return abrirCaso(id, { foco: false });
      S.detalle = null; renderDetalleVacio();
    }).then(cargarEstado).then(cargarConteos);
  }

  function saltear() {
    var c = caso(); if (!c || S.busy || S.offline) return;
    S.busy = 'saltear';
    api('POST', '/casos/' + c.id + '/saltear', { expected_version: c.expected_version }).then(function (r) {
      S.busy = null;
      if (r.ok) { S.guardado = { caso: c.id, texto: 'Salteado. Pasa al final de la cola.' }; return siguienteCaso(); }
      if (r.status === 409 && r.data.code === 'VERSION_CONFLICT') return abrirCaso(c.id, { foco: false }).then(function () { S.accionError = mensajeDe(r); renderDetalle(); });
      S.accionError = mensajeDe(r); renderDetalle();
    });
  }

  function deshacerNS() {
    var d = S.deshacer; if (!d || d.vencido || Date.now() >= d.expira || S.busy) return;
    S.busy = 'deshacer'; renderDetalle();
    api('POST', '/claves/no-sincronizar/deshacer', { clave: d.clave, motivo: d.motivo }).then(function (r) {
      S.busy = null; limpiarDeshacer();
      if (r.ok) { S.guardado = { caso: d.caso, texto: 'Deshecho. La publicación vuelve a la cola.' }; anunciar('Deshecho.', 'estado'); return abrirCaso(d.caso, { foco: false }).then(cargarCola); }
      if (r.status === 409) { S.guardado = { caso: d.caso, texto: 'Ya se mandó a ML; mirá Ejecución' }; return renderDetalle(); }
      S.accionError = mensajeDe(r); renderDetalle();
    });
  }

  function limpiarDeshacer() {
    S.deshacer = null;
    clearInterval(S.deshacerTimer); S.deshacerTimer = null;
  }

  function textoDeshacer() {
    var resta = Math.max(0, Math.ceil((S.deshacer.expira - Date.now()) / 1000));
    return resta > 0 ? 'quedan ' + resta + ' s' : 'Ya no se puede deshacer';
  }

  // La cuenta regresiva actualiza solo su texto (no re-renderiza el detalle, para no pisar lo que la persona escribe).
  function iniciarDeshacer(d) {
    limpiarDeshacer();
    S.deshacer = d;
    anunciar('Podés deshacer durante 10 segundos.', 'estado');
    S.deshacerTimer = setInterval(function () {
      if (!S.deshacer) return clearInterval(S.deshacerTimer);
      var resta = Math.ceil((S.deshacer.expira - Date.now()) / 1000);
      if (resta === 3) anunciar('Quedan 3 segundos para deshacer.', 'estado');
      if (resta <= 0) {
        clearInterval(S.deshacerTimer); S.deshacerTimer = null;
        S.deshacer.vencido = true;
        anunciar('Ya no se puede deshacer.', 'estado');
        renderDetalle();
        return;
      }
      var t = $('#cv-deshacer-txt'); if (t) t.textContent = textoDeshacer();
    }, 1000);
  }

  // ── No sincronizar (diálogo) ───────────────────────────────────────────────────────────────────
  var VARIANTES = [
    { v: 'a', t: '(a) Solo marcar', l: 'Dejamos de tocarle el stock. Cualquiera lo revierte.' },
    { v: 'b', t: '(b) Marcar y pausar en ML', l: 'Además se pausa la publicación en ML.' },
    { v: 'c', t: '(c) Solo marcar, revierte José', l: 'Un operador no puede revertirlo.', lock: true }
  ];

  function abrirNS(disparador) {
    var c = caso(); if (!c || S.busy || S.offline) return;
    S.nsOpId = null; S.nsVariante = null; S.nsConfirm = false;
    $('#ns-variantes').innerHTML = VARIANTES.map(function (x) {
      return '<label class="cv-variante"><input type="radio" name="ns-variante" value="' + x.v + '">'
        + '<span><span class="cv-variante__titulo">' + esc(x.t) + '</span>' + (x.lock ? ' <span class="cv-lock"></span>' : '') + '</span>'
        + '<span class="cv-variante__linea">' + esc(x.l) + '</span></label>';
    }).join('');
    $('#ns-motivo').value = '';
    $('#ns-motivo').removeAttribute('aria-invalid');
    $('#ns-motivo-err').hidden = true;
    $('#ns-estado').hidden = true;
    $('#ns-alcance').hidden = true; $('#ns-alcance').innerHTML = '';
    $('#dlg-ns-titulo').textContent = 'No sincronizar · ' + (c.publicacion && c.publicacion.titulo || c.ml_key);
    abrirDialogo($('#dlg-ns'), disparador, $('#ns-variantes input'));
  }

  function nsEnviar(ev) {
    ev.preventDefault();
    var c = caso(); if (!c || S.nsEnviando) return;
    var radio = $('#ns-variantes input:checked');
    var motivo = $('#ns-motivo').value.trim();
    var err = $('#ns-motivo-err');
    var estado = $('#ns-estado');
    estado.hidden = true;
    if (!radio) { estado.textContent = 'Elegí una de las tres variantes.'; estado.hidden = false; $('#ns-variantes input').focus(); return; }
    if (!motivo) {
      err.textContent = 'Falta el motivo. Es obligatorio.'; err.hidden = false;
      $('#ns-motivo').setAttribute('aria-invalid', 'true'); $('#ns-motivo').focus();
      return;
    }
    err.hidden = true; $('#ns-motivo').removeAttribute('aria-invalid');
    var v = radio.value;
    var pub = c.publicacion || {};
    var body = { variante: v, motivo: motivo, expected_sku: pub.seller_sku || null };
    if (v === 'b') {
      S.nsOpId = S.nsOpId || uuid();
      body.operation_id = S.nsOpId;
      if (S.nsConfirm) body.confirm_sibling_impact = true;
    }
    S.nsEnviando = true; S.busy = 'no-sincronizar';
    $('#ns-enviar').innerHTML = '<span class="cv-girando" aria-hidden="true">↻</span> Guardando…';
    api('POST', '/casos/' + c.id + '/no-sincronizar', body).then(function (r) {
      S.nsEnviando = false; S.busy = null;
      $('#ns-enviar').textContent = 'Marcar no sincronizar';
      if (r.red) { estado.textContent = MSG_ERROR_SIN_RED; estado.hidden = false; return; }
      if (r.ok) {
        S.nsOpId = null;
        cerrarDialogo();
        var txt = v === 'b' ? 'En cola para ML · mirá Ejecución' : 'Guardado · No sincronizar (variante ' + v + ')';
        S.guardado = { caso: c.id, texto: txt, titulo: pub.titulo };
        if (v !== 'b') iniciarDeshacer({ caso: c.id, clave: c.ml_key, motivo: motivo, expira: Date.now() + 10000 });
        return siguienteCaso();
      }
      if (v === 'b' && r.status === 409 && r.data.code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED') {
        return mostrarAlcance(r.data.sibling_count);
      }
      S.nsOpId = null;
      estado.textContent = mensajeDe(r); estado.hidden = false;
    });
  }

  function mostrarAlcance(n) {
    var al = $('#ns-alcance');
    al.hidden = false;
    al.innerHTML = '<div class="ui-aviso ui-aviso--atencion cv-alcance"><p><span aria-hidden="true">⚠</span> La pausa es de la publicación entera. Pausa también estas ' + n + ' variaciones.</p>'
      + '<label class="cv-switch"><input type="checkbox" id="ns-conf"> <span>Entiendo, pausar las ' + n + '</span></label>'
      + '<p id="ns-conf-razon" class="cv-acciones__razon">Marcá la confirmación para pausar las ' + n + ' variaciones.</p></div>';
    var cb = $('#ns-conf');
    cb.focus();
    $('#ns-enviar').setAttribute('aria-disabled', 'true');
    $('#ns-enviar').setAttribute('aria-describedby', 'ns-conf-razon');
    S.nsConfirm = false;
  }

  // ── Diálogos (foco atrapado, Esc, foco vuelve al disparador) ──────────────────────────────────
  function abrirDialogo(el, disparador, enfocar) {
    S.dlgDisparador = disparador || null;
    S.dlgActivo = el;
    el.hidden = false;
    setTimeout(function () { (enfocar || focusables(el)[0] || el).focus(); }, 0);
  }
  function cerrarDialogo() {
    if (!S.dlgActivo) return;
    S.dlgActivo.hidden = true;
    var d = S.dlgDisparador;
    S.dlgActivo = null; S.dlgDisparador = null;
    if (d && document.contains(d)) d.focus();
    else { var nuevo = $('[data-accion="no-sincronizar"]'); if (nuevo && S.dlgActivo === null) nuevo.focus(); }
  }
  function focusables(root) {
    return $$('button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])', root)
      .filter(function (e) { return !e.hidden && e.offsetParent !== null || e === document.activeElement; });
  }
  function atraparTab(ev) {
    var f = focusables(S.dlgActivo);
    if (!f.length) return;
    var primero = f[0]; var ultimo = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === primero) { ev.preventDefault(); ultimo.focus(); }
    else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primero.focus(); }
  }

  // ── Atajos (R6): solo PC (>=1024 px), apagables, sin atajos dentro de campos de texto ─────────
  function atajosActivos() { return S.atajosOn && window.innerWidth >= 1024; }
  function esCampo(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function aplicarAtajosUI() {
    document.body.classList.toggle('cv-atajos-off', !S.atajosOn);
    $('#cv-atajos-on').checked = S.atajosOn;
    $('#dlg-atajos-on').checked = S.atajosOn;
    $('#cv-atajos-estado').textContent = S.atajosOn ? 'Atajos activados' : 'Atajos apagados';
    $('#dlg-atajos-txt').textContent = S.atajosOn ? 'Activados' : 'Apagados';
  }
  function guardarAtajos(v) {
    S.atajosOn = v;
    try { localStorage.setItem('cv-atajos', v ? 'on' : 'off'); } catch (e) { /* sin storage: queda en memoria */ }
    aplicarAtajosUI();
  }

  function teclado(ev) {
    if (S.dlgActivo) {
      if (ev.key === 'Escape') { ev.preventDefault(); cerrarDialogo(); }
      else if (ev.key === 'Tab') atraparTab(ev);
      return;
    }
    if (ev.key === 'Escape' && S.hermanas) { ev.preventDefault(); S.hermanas = null; renderDetalle(); return; }
    if (ev.key === 'Escape' && S.conflictoVersion) { ev.preventDefault(); S.conflictoVersion = null; renderDetalle(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || !atajosActivos()) return;
    var t = ev.target;
    if (esCampo(t)) return;
    var enCaso = S.tab === 'casos' && S.detalle;
    var interactivo = t && (t.tagName === 'BUTTON' || t.tagName === 'A');
    switch (ev.key) {
      case '1': case '2': case '3':
        if (enCaso && S.candidatos && S.candidatos[Number(ev.key) - 1] && !soloLecturaActual()) { ev.preventDefault(); elegirCandidato(Number(ev.key) - 1); }
        break;
      case 'Enter':
        if (!interactivo && enCaso && !soloLecturaActual()) { ev.preventDefault(); vincular(); }
        break;
      case 's': if (enCaso && !soloLecturaActual()) { ev.preventDefault(); saltear(); } break;
      case 'n': if (enCaso && !soloLecturaActual()) { ev.preventDefault(); abrirNS($('[data-accion="no-sincronizar"]')); } break;
      case 'z': if (S.deshacer && !S.deshacer.vencido) { ev.preventDefault(); deshacerNS(); } break;
      case 'd': if (enCaso) { ev.preventDefault(); S.soloDif = !S.soloDif; renderDetalle(); } break;
      case 'f': if (enCaso) { ev.preventDefault(); S.fotoGrande = !S.fotoGrande; renderDetalle(); } break;
      case '/': ev.preventDefault(); if (S.tab === 'casos' && enCaso) { $('#det-q') && $('#det-q').focus(); } else { activarTab('vinculos'); $('#vinc-q').focus(); } break;
      case '?': ev.preventDefault(); abrirDialogo($('#dlg-atajos'), $('#cv-btn-ayuda'), $('#dlg-atajos-on')); break;
      default: break;
    }
  }
  function soloLecturaActual() {
    return !!(S.detalle && S.detalle.caso.estado === 'intervencion' && !S.isAdmin);
  }

  // ── Ejecución ──────────────────────────────────────────────────────────────────────────────────
  function chipEstado(estado, o) {
    var k = ESTADO_OP[estado] || estado;
    var m = {
      encolada: ['cv-chip-estado', '↻', 'En cola para ML'],
      aplicada: ['cv-chip-estado cv-chip-estado--aplicada', '✓', 'Aplicada en ML'],
      fallida: ['cv-chip-estado cv-chip-estado--fallida', '✗', 'ML la rechazó: ' + (o.ultimo_error || 'sin detalle') + '. Reintenta José.'],
      frenada: ['cv-chip-estado cv-chip-estado--frenada', '⏸', 'Frenada: ' + (o.ultimo_error || 'regla de protección') + '. Stock en 0 hasta resolver.']
    }[k];
    if (!m) return '<span class="cv-chip-estado">' + esc(estado) + '</span>';
    return '<span class="' + m[0] + '"><span aria-hidden="true">' + m[1] + '</span> ' + esc(m[2]) + '</span>';
  }

  function cargarEjecucion() {
    var cab = $('#ejec-cabecera');
    cab.setAttribute('aria-busy', 'true');
    return api('GET', '/ejecucion').then(function (r) {
      cab.setAttribute('aria-busy', 'false');
      if (!r.ok) { cab.innerHTML = cajaError(mensajeDe(r), 'cargarEjecucion'); $('#ejec-cuerpo').innerHTML = ''; return; }
      var e = r.data.data;
      S.ejec = e;
      var anteriores = S.ejecEstados;
      var nuevos = {};
      var cambios = [];
      (e.operaciones || []).forEach(function (o) {
        var k = 'op' + o.id; var est = ESTADO_OP[o.estado] || o.estado;
        nuevos[k] = est;
        if (anteriores && anteriores[k] && anteriores[k] !== est) cambios.push(o.sku_objetivo + ': ' + est);
      });
      S.ejecEstados = nuevos;
      if (cambios.length) anunciar('Cambió: ' + cambios.join('; '), 'estado');
      renderEjecucion();
      actualizarContadoresTab();
    });
  }

  function refrescarEjecucion() { return cargarEjecucion(); }

  function renderEjecucion() {
    var e = S.ejec; if (!e) return;
    var fall = e.fallidas || 0;
    var ops = e.operaciones || [];
    var frenadas = ops.filter(function (o) { return ESTADO_OP[o.estado] === 'frenada'; }).length;
    var encoladas = ops.filter(function (o) { return ESTADO_OP[o.estado] === 'encolada'; }).length;
    $('#ejec-cabecera').innerHTML = '<div class="cv-cabecera-ejec">'
      + (fall > 0
        ? '<span class="cv-contador cv-contador--critico"><span aria-hidden="true">✗</span> ' + fall + ' fallidas</span> <span class="ui-resumen">ML rechazó ' + fall + '</span>'
        : '<span class="cv-contador cv-contador--ok"><span aria-hidden="true">✓</span> Sin fallidas</span>')
      + '<span class="ui-resumen"><span class="cv-frenadas">⏸ ' + frenadas + ' frenadas</span> · ↻ ' + encoladas + ' en cola</span></div>';
    var riesgo = (e.pausas || []).filter(function (p) { return p.impacto_hermanas > 0 && p.estado !== 'completada' && p.estado !== 'cancelada'; });
    var bloqueRiesgo = riesgo.length
      ? '<section class="ui-aviso ui-aviso--atencion cv-bloque" aria-labelledby="riesgo-h"><h3 id="riesgo-h" class="cv-h2"><span aria-hidden="true">⚠</span> Pausas con riesgo</h3>'
        + riesgo.map(function (p) {
          return '<p class="ui-resumen">' + esc(p.ml_key) + ' · pausa ' + p.impacto_hermanas + ' variaciones · ' + esc(p.motivo || '') + ' ' + chipEstado(p.estado, p) + '</p>';
        }).join('') + '</section>'
      : '';
    var filas = ops.map(function (o) {
      var est = ESTADO_OP[o.estado] || o.estado;
      var fallida = est === 'fallida';
      var acciones = '';
      if (S.isAdmin && fallida) acciones += '<button type="button" class="ui-btn" data-accion="reintentar" data-op="' + o.id + '">Reintentar</button> ';
      if (S.isAdmin && o.estado === 'bloqueada_impacto') acciones += '<button type="button" class="ui-btn" data-accion="confirmar-impacto" data-op="' + o.id + '">Confirmar impacto</button>';
      return '<article class="cv-ejec-fila' + (fallida ? ' cv-ejec-fila--fallida' : '') + '" data-op="' + o.id + '">'
        + '<div class="cv-ejec-fila__cab"><strong>' + esc(o.nombre_canonico || o.ml_key) + '</strong>' + chipEstado(o.estado, o) + '</div>'
        + '<p class="ui-resumen"><span class="ui-id">' + esc(o.sku_objetivo || '') + '</span> · ' + esc(fecha(o.actualizada_en || o.iniciada_en)) + '</p>'
        + (fallida && !S.isAdmin ? '<p class="ui-resumen">Reintenta José.</p>' : '')
        + (acciones ? '<div class="cv-ejec-acciones">' + acciones + '</div>' : '')
        + '</article>';
    }).join('');
    $('#ejec-cuerpo').innerHTML = bloqueRiesgo + (filas || '<p class="ui-resumen">No hay operaciones en ML.</p>');
  }

  function actualizarContadoresTab() {
    var e = S.ejec; if (!e) return;
    var n = e.fallidas || 0;
    $('#cnt-ejecucion').innerHTML = n > 0
      ? '<span class="cv-contador--critico"><span aria-hidden="true">✗</span> ' + n + ' fallidas</span>'
      : '<span class="ui-resumen">0 fallidas</span>';
  }

  function reintentarOp(id, accion) {
    var clave = accion + ':' + id;
    if (S.busy) return;
    S.busy = accion;
    api('POST', '/operaciones/' + id + '/' + (accion === 'reintentar' ? 'reintentar' : 'confirmar-impacto'), { operation_id: opIdPara(clave) }).then(function (r) {
      S.busy = null;
      if (r.ok || (!r.red && r.status !== 409 && r.status !== 0)) soltarOpId(clave);
      if (r.red) { anunciar(MSG_ERROR_SIN_RED, 'alerta'); return; }
      if (!r.ok) { anunciar(mensajeDe(r), 'alerta'); return; }
      anunciar('Enviado. Mirá el estado en Ejecución.', 'estado');
      cargarEjecucion();
    });
  }

  // ── Retenidas ─────────────────────────────────────────────────────────────────────────────────
  function causaDe(f) { return String(f.motivo || 'causa en revisión').replace(/_/g, ' '); }

  function cargarRetenidas() {
    var cont = $('#ret-cuerpo');
    cont.setAttribute('aria-busy', 'true');
    return api('GET', '/retenidas').then(function (r) {
      cont.setAttribute('aria-busy', 'false');
      if (!r.ok) { cont.innerHTML = cajaError(mensajeDe(r), 'cargarRetenidas'); return; }
      S.retenidas = r.data.data || [];
      S.retError = null;
      $('#cnt-retenidas').textContent = '· ' + S.retenidas.length;
      renderRetenidas();
    });
  }

  function renderRetenidas() {
    var cont = $('#ret-cuerpo');
    var lista = S.retenidas || [];
    var cabecera = '<div class="ui-aviso ui-aviso--info" role="note">Se liberan solas cada 5 minutos cuando la causa se resuelve.</div>';
    if (!lista.length) { cont.innerHTML = cabecera + '<div class="api-estado api-estado--vacio" role="status"><p>No hay ventas retenidas.</p></div>'; return; }
    cont.innerHTML = cabecera + lista.map(function (f) {
      var abierta = S.retAbierta === f.ml_order_id;
      var aviso = S.retAviso[f.ml_order_id]
        ? '<div class="ui-aviso ui-aviso--atencion cv-ret__aviso" role="alert">⚠ Se va a volver a retener.</div> ' : '';
      var liberar = '';
      if (S.canWrite && !S.retAviso[f.ml_order_id]) {
        liberar = abierta
          ? '<form class="cv-ret__form" data-accion="liberar-enviar" data-orden="' + esc(f.ml_order_id) + '" novalidate>'
            + '<label class="ui-label" for="ret-m-' + esc(f.id) + '">Motivo <span>(obligatorio)</span></label>'
            + '<textarea id="ret-m-' + esc(f.id) + '" class="ui-input" rows="2"></textarea>'
            + '<p class="cv-error" hidden></p>'
            + '<div class="cv-acciones__fila"><button type="submit" class="ui-btn ui-btn--primario">Confirmar liberación</button>'
            + '<button type="button" class="ui-btn" data-accion="liberar-cancelar">Cancelar</button></div></form>'
          : '<button type="button" class="ui-btn" data-accion="liberar-abrir" data-orden="' + esc(f.ml_order_id) + '" aria-expanded="false">Liberar</button>';
      }
      return '<article class="cv-ret">'
        + '<div class="cv-ret__cab"><span>Pedido <span class="ui-id">' + esc(f.ml_order_id) + '</span> · publicación <span class="ui-id">' + esc((f.claves || [])[0] || '—') + '</span></span>'
        + '<span class="ui-label">' + esc(fecha(f.creado_en)) + '</span></div>'
        + '<p class="ui-resumen">Causa: ' + esc(causaDe(f)) + '</p>'
        + aviso + liberar + '</article>';
    }).join('');
    actualizarContadoresTab();
  }

  function liberarRetenida(form) {
    var orden = form.getAttribute('data-orden');
    var motivo = form.querySelector('textarea').value.trim();
    var err = form.querySelector('.cv-error');
    if (!motivo) {
      err.textContent = 'Falta el motivo. Es obligatorio.'; err.hidden = false;
      form.querySelector('textarea').setAttribute('aria-invalid', 'true');
      form.querySelector('textarea').focus();
      return;
    }
    var fila = (S.retenidas || []).find(function (f) { return f.ml_order_id === orden; });
    var sigueCausa = !!(fila && fila.se_vuelve_a_retener);
    S.busy = 'liberar';
    api('POST', '/retenidas/' + enc(orden) + '/liberar', { motivo: motivo }).then(function (r) {
      S.busy = null;
      if (!r.ok) { err.textContent = mensajeDe(r); err.hidden = false; return; }
      S.retAbierta = null;
      if (sigueCausa) { S.retAviso[orden] = true; renderRetenidas(); anunciar('Liberada, pero se va a volver a retener.', 'alerta'); return; }
      anunciar('Venta liberada.', 'estado');
      cargarRetenidas();
    });
  }

  // ── Vínculos ──────────────────────────────────────────────────────────────────────────────────
  function buscarVinculos(q) {
    var cont = $('#vinc-resultados');
    cont.setAttribute('aria-busy', 'true');
    S.vincQ = q;
    return identidad('/productos/buscar?q=' + enc(q.trim())).then(function (r) {
      cont.setAttribute('aria-busy', 'false');
      if (!r.ok) { cont.innerHTML = cajaError(mensajeDe(r), 'buscarVinculos'); return; }
      var lista = r.data.data || [];
      if (!lista.length) { cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>Sin productos para “' + esc(q) + '”.</p></div>'; return; }
      cont.innerHTML = '<p class="ui-resumen" role="status">' + lista.length + ' resultado' + (lista.length === 1 ? '' : 's') + '</p>' + lista.map(function (p) {
        return '<article class="cv-tarjeta-vinc"><strong>' + esc(p.nombre_canonico || '—') + '</strong>'
          + '<p class="ui-resumen">SKU Fusion <span class="ui-id">' + esc(p.fusion_sku || '—') + '</span> · SKU Woo <span class="ui-id">' + esc(p.sku_woo || '—') + '</span></p>'
          + '<p class="ui-resumen">Stock Woo ' + esc(p.stock_woo == null ? 'sin dato' : p.stock_woo) + ' · publicaciones ML activas ' + esc(p.identidades_ml_activas || 0) + '</p></article>';
      }).join('');
    });
  }

  function cargarConflictos() {
    var cuerpo = $('#conflictos-cuerpo');
    return identidad('/identificadores/conflictos').then(function (r) {
      if (!r.ok) { cuerpo.innerHTML = cajaError(mensajeDe(r), 'cargarConflictos'); return; }
      S.conflictos = r.data.data || [];
      $('#cnt-conflictos').textContent = '· ' + S.conflictos.length;
      if (!S.conflictos.length) { cuerpo.innerHTML = '<p class="ui-resumen">Ningún código en conflicto.</p>'; return; }
      cuerpo.innerHTML = S.conflictos.map(function (x) {
        var abierto = S.conflictoAbierto === x.valor_normalizado;
        return '<article class="cv-conflicto"><div class="cv-conflicto__cab"><span><span class="ui-id">' + esc(x.valor_normalizado) + '</span> '
          + '<span class="ui-label">' + esc(x.subtipo || '') + ' · ' + esc(x.productos) + ' productos</span></span>'
          + '<button type="button" class="ui-btn" data-accion="ver-conflicto" data-valor="' + esc(x.valor_normalizado) + '" aria-expanded="' + abierto + '">'
          + (abierto ? 'Cerrar' : 'Ver y resolver') + '</button></div>'
          + (abierto ? conflictoDetalleHtml() : '') + '</article>';
      }).join('');
    });
  }

  function conflictoDetalleHtml() {
    var d = S.conflictoDetalle;
    if (!d) return '<p class="ui-resumen">Cargando…</p>';
    var filas = (d.productos || []).map(function (p) {
      return '<div class="cv-prod-conf__fila"><span><strong>' + esc(p.fusion_sku) + '</strong> ' + esc((p.nombre_canonico || '').slice(0, 70))
        + '<br><span class="ui-label">Stock Woo ' + esc(p.stock_woo == null ? '—' : p.stock_woo) + ' · Stock ML ' + esc(p.stock_ml) + '</span></span>'
        + '<span class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="resolver" data-ganador="' + p.id + '" data-valor="' + esc(d.valor_normalizado) + '">Es de este</button>'
        + '<button type="button" class="ui-btn ui-btn--peligro" data-accion="incorrecto" data-producto="' + p.id + '" data-valor="' + esc(d.valor_normalizado) + '">No le corresponde</button></span></div>';
    }).join('');
    return '<div class="cv-prod-conf">'
      + '<p class="ui-resumen">«Es de este» le deja el código a ese producto y marca a todos los demás como incorrectos. «No le corresponde» descarta sólo a ese.</p>'
      + '<div class="cv-campo"><label class="ui-label" for="conf-motivo">Motivo <span>(obligatorio)</span></label>'
      + '<input id="conf-motivo" class="ui-input" type="text" autocomplete="off"><p id="conf-err" class="cv-error" hidden></p></div>'
      + filas + (d.truncado ? '<p class="ui-resumen">Se muestran los ' + esc((d.productos || []).length) + ' con más stock, de ' + esc(d.total_productos) + '.</p>' : '')
      + '</div>';
  }

  function resolverConflicto(el) {
    var motivo = ($('#conf-motivo') || {}).value || '';
    motivo = motivo.trim();
    if (!motivo) { var e = $('#conf-err'); e.textContent = 'Falta el motivo. Es obligatorio.'; e.hidden = false; $('#conf-motivo').focus(); return; }
    var valor = el.getAttribute('data-valor');
    var ruta; var body;
    if (el.getAttribute('data-accion') === 'resolver') {
      ruta = '/identificadores/conflictos/resolver'; body = { valor_normalizado: valor, producto_id: Number(el.getAttribute('data-ganador')), motivo: motivo };
    } else {
      ruta = '/identificadores/incorrecto'; body = { valor_normalizado: valor, producto_id: Number(el.getAttribute('data-producto')), motivo: motivo };
    }
    llamar('POST', IDENT + ruta, body).then(function (r) {
      if (!r.ok) { var e2 = $('#conf-err'); if (e2) { e2.textContent = mensajeDe(r); e2.hidden = false; } return; }
      S.conflictoAbierto = null; S.conflictoDetalle = null;
      anunciar('Código resuelto: ' + valor, 'estado');
      cargarConflictos();
    });
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────────────────────
  var TABS = ['casos', 'vinculos', 'ejecucion', 'retenidas'];
  S.focoPendiente = null; S.adminForm = null;
  function activarTab(nombre) {
    S.tab = nombre;
    TABS.forEach(function (t) {
      var sel = t === nombre;
      var b = $('#tab-' + t);
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.setAttribute('tabindex', sel ? '0' : '-1');
      $('#panel-' + t).hidden = !sel;
    });
    clearInterval(S.ejecPoll); S.ejecPoll = null;
    if (nombre === 'casos' && !S.colaCargada) { cargarEstado(); cargarConteos(); cargarCola(); }
    if (nombre === 'vinculos' && S.conflictos === null) cargarConflictos();
    if (nombre === 'ejecucion') {
      cargarEjecucion();
      S.ejecPoll = setInterval(function () { if (!document.hidden) cargarEjecucion(); }, 20000);
    }
    if (nombre === 'retenidas') cargarRetenidas();
  }

  // Conteos de pestañas (fallidas y retenidas) al abrir la pantalla.
  function actualizarContadoresIniciales() {
    api('GET', '/ejecucion').then(function (r) { if (r.ok) { S.ejec = r.data.data; actualizarContadoresTab(); } });
    api('GET', '/retenidas').then(function (r) { if (r.ok) $('#cnt-retenidas').textContent = '· ' + (r.data.data || []).length; });
  }

  // ── Eventos (delegación) ──────────────────────────────────────────────────────────────────────
  function bindEventos() {
    document.addEventListener('keydown', teclado);

    $('#cv-atajos-on').addEventListener('change', function (e) { guardarAtajos(e.target.checked); });
    $('#dlg-atajos-on').addEventListener('change', function (e) { guardarAtajos(e.target.checked); });
    $('#cv-btn-ayuda').addEventListener('click', function (e) { abrirDialogo($('#dlg-atajos'), e.currentTarget, $('#dlg-atajos-on')); });
    $('#dlg-atajos-cerrar').addEventListener('click', cerrarDialogo);
    $('#ns-volver').addEventListener('click', cerrarDialogo);
    $('#ns-form').addEventListener('submit', nsEnviar);
    $('#ns-form').addEventListener('change', function (e) {
      if (e.target.name === 'ns-variante') {
        S.nsVariante = e.target.value;
        if (S.nsVariante !== 'b') { $('#ns-alcance').hidden = true; $('#ns-alcance').innerHTML = ''; S.nsConfirm = false; S.nsOpId = null; }
        $('#ns-enviar').removeAttribute('aria-disabled');
        $('#ns-enviar').removeAttribute('aria-describedby');
        $$('#ns-variantes .cv-variante').forEach(function (l) { l.setAttribute('aria-checked', String(l.querySelector('input').checked)); });
      }
    });
    $('#ns-alcance').addEventListener('change', function (e) {
      if (e.target.id === 'ns-conf') {
        S.nsConfirm = e.target.checked;
        var b = $('#ns-enviar');
        b.setAttribute('aria-disabled', S.nsConfirm ? 'false' : 'true');
        if (S.nsConfirm) b.removeAttribute('aria-describedby'); else b.setAttribute('aria-describedby', 'ns-conf-razon');
      }
    });
    $('#ns-enviar').addEventListener('click', function (e) {
      if (this.getAttribute('aria-disabled') === 'true') { e.preventDefault(); $('#ns-conf') && $('#ns-conf').focus(); }
    });

    // Tabs: flechas y Home/End.
    $('.cv-tabs').addEventListener('keydown', function (ev) {
      var i = TABS.indexOf(S.tab);
      var n = null;
      if (ev.key === 'ArrowRight') n = (i + 1) % TABS.length;
      else if (ev.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
      else if (ev.key === 'Home') n = 0;
      else if (ev.key === 'End') n = TABS.length - 1;
      if (n === null) return;
      ev.preventDefault();
      activarTab(TABS[n]);
      $('#tab-' + TABS[n]).focus();
    });
    $$('.cv-tabs [role="tab"]').forEach(function (b) {
      b.addEventListener('click', function () { activarTab(b.getAttribute('data-tab')); });
    });

    // Cola: flechas mueven el foco (no abren el caso); Enter/clic abre.
    $('#cv-cola').addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      var ops = $$('#cv-cola [role="option"]');
      var i = ops.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      var j = ev.key === 'ArrowDown' ? Math.min(ops.length - 1, i + 1) : Math.max(0, i - 1);
      ops[j].setAttribute('tabindex', '0'); ops[i].setAttribute('tabindex', '-1');
      ops[j].focus();
    });

    // Acciones y listas: un solo listener por contenedor.
    document.body.addEventListener('click', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-accion]');
      if (!el) return;
      if (el.getAttribute('aria-disabled') === 'true') { ev.preventDefault(); return; }
      var a = el.getAttribute('data-accion');
      switch (a) {
        case 'filtro':
          if (S.busy) return;
          S.filtro = el.getAttribute('data-filtro'); S.colaCargada = false; S.casoId = null; S.detalle = null;
          renderFiltros(); cargarCola(); break;
        case 'ir-filtro':
          ev.preventDefault();
          activarTab('casos');
          S.filtro = el.getAttribute('data-filtro'); S.colaCargada = false;
          cargarCola(); break;
        case 'abrir': ev.preventDefault(); S.guardado = null; S.focoPendiente = '#det-titulo'; abrirCaso(Number(el.getAttribute('data-caso')), { foco: window.innerWidth < 1024 }); break;
        case 'volver-cola':
          var opcion = $('#cv-cola [aria-selected="true"]'); if (opcion) opcion.focus();
          if (window.innerWidth < 1024) document.getElementById('cv-cola').scrollIntoView({ block: 'start' });
          break;
        case 'elegir': elegirCandidato(Number(el.getAttribute('data-idx'))); break;
        case 'vincular': vincular(); break;
        case 'saltear': saltear(); break;
        case 'no-sincronizar': abrirNS(el); break;
        case 'deshacer': deshacerNS(); break;
        case 'solo-dif': S.soloDif = !S.soloDif; renderDetalle(); break;
        case 'hermanas-si':
          if (!S.hermanas) break;
          var b = S.hermanas.body; S.hermanas = null;
          S.busy = 'vincular'; renderDetalle();
          api('POST', '/casos/' + caso().id + '/decisiones', Object.assign({}, b, { confirm_sibling_impact: true })).then(function (r) {
            S.busy = null;
            if (r.ok) return guardadoOk(caso(), 'Guardado · En cola para ML', 'vincular');
            S.accionError = mensajeDe(r); renderDetalle();
          });
          break;
        case 'hermanas-no': S.hermanas = null; renderDetalle(); enfocarPorSelector('[data-accion="vincular"]'); break;
        case 'conflicto-aplicar':
          if (!S.conflictoVersion) break;
          var nuevo = cuerpoVincular({}); S.conflictoVersion = null;
          var c = caso(); nuevo.operation_id = uuid(); nuevo.expected_version = c.expected_version; nuevo.evidence_fingerprint = c.evidencia_fingerprint;
          S.busy = 'vincular'; renderDetalle();
          api('POST', '/casos/' + c.id + '/decisiones', nuevo).then(function (r) {
            S.busy = null;
            if (r.ok) return guardadoOk(c, 'Guardado · En cola para ML', 'vincular');
            S.accionError = mensajeDe(r); renderDetalle();
          });
          break;
        case 'conflicto-descartar': S.conflictoVersion = null; renderDetalle(); break;
        case 'admin': S.adminForm = el.getAttribute('data-admin'); renderDetalle(); enfocarPorSelector('#adm-motivo'); break;
        case 'admin-cancelar': S.adminForm = null; renderDetalle(); break;
        case 'reintentar-carga':
          var rc = el.getAttribute('data-reintento');
          if (rc === 'cargarCola') { S.colaCargada = false; cargarCola(); }
          else if (rc === 'cargarEstado') cargarEstado();
          else if (rc === 'cargarEjecucion') cargarEjecucion();
          else if (rc === 'cargarRetenidas') cargarRetenidas();
          else if (rc === 'cargarConflictos') cargarConflictos();
          else if (rc === 'reabrirCaso' && S.casoId) abrirCaso(S.casoId);
          break;
        case 'reintentar': reintentarOp(Number(el.getAttribute('data-op')), 'reintentar'); break;
        case 'confirmar-impacto': reintentarOp(Number(el.getAttribute('data-op')), 'confirmar-impacto'); break;
        case 'liberar-abrir': S.retAbierta = el.getAttribute('data-orden'); renderRetenidas(); enfocarPorSelector('#ret-cuerpo textarea'); break;
        case 'liberar-cancelar': S.retAbierta = null; renderRetenidas(); break;
        case 'ver-conflicto':
          var valor = el.getAttribute('data-valor');
          if (S.conflictoAbierto === valor) { S.conflictoAbierto = null; cargarConflictos(); break; }
          S.conflictoAbierto = valor; S.conflictoDetalle = null; cargarConflictos();
          identidad('/identificadores/conflictos/' + enc(valor)).then(function (r) {
            if (S.conflictoAbierto !== valor) return;
            S.conflictoDetalle = r.ok ? r.data.data : null;
            if (!r.ok) S.conflictoDetalle = { valor_normalizado: valor, productos: [] };
            cargarConflictos().then(function () { enfocarPorSelector('#conf-motivo'); });
          });
          break;
        case 'resolver': case 'incorrecto': resolverConflicto(el); break;
        default: break;
      }
    });

    document.body.addEventListener('submit', function (ev) {
      var f = ev.target;
      if (f.id === 'det-buscar') {
        ev.preventDefault();
        var q = $('#det-q').value;
        S.queryCand = q; S.elegido = null;
        if (!caso()) return;
        buscarCandidatos(q).then(renderDetalle);
      } else if (f.getAttribute('data-accion') === 'admin-enviar') {
        ev.preventDefault();
        adminEnviar(f);
      } else if (f.getAttribute('data-accion') === 'liberar-enviar') {
        ev.preventDefault();
        liberarRetenida(f);
      } else if (f.id === 'vinc-form') {
        ev.preventDefault();
        var v = $('#vinc-q').value.trim();
        if (v) buscarVinculos(v);
      }
    });

    // Diálogo: clic fuera cierra (solo en el fondo).
    $$('.cv-dialogo-fondo').forEach(function (fondo) {
      fondo.addEventListener('click', function (ev) { if (ev.target === fondo) cerrarDialogo(); });
    });

    // Campo de motivo de admin: marca error al escribir.
    document.body.addEventListener('input', function (ev) {
      if (ev.target.id === 'adm-motivo' && ev.target.value.trim()) { $('#adm-err').hidden = true; }
    });

    window.addEventListener('online', function () { setOffline(false); cargarCola({ seleccionar: false }); });
    window.addEventListener('resize', aplicarBloqueo);
  }

  function enfocarPorSelector(sel) {
    setTimeout(function () { var el = $(sel); if (el) el.focus(); }, 0);
  }

  function adminEnviar(form) {
    var tipo = form.getAttribute('data-admin');
    var motivo = ($('#adm-motivo') || {}).value || '';
    motivo = motivo.trim();
    var err = $('#adm-err');
    if (!motivo) { err.textContent = 'Falta el motivo. Es obligatorio.'; err.hidden = false; $('#adm-motivo').setAttribute('aria-invalid', 'true'); $('#adm-motivo').focus(); return; }
    var c = caso(); var pub = c.publicacion || {};
    var body; var ruta; var clave = null;
    if (tipo === 'confirmar') {
      if (!S.elegido) { err.textContent = 'Elegí un candidato antes de confirmar.'; err.hidden = false; return; }
      body = cuerpoVincular({ override_contradiccion: true, motivo: motivo });
      ruta = '/casos/' + c.id + '/decisiones';
      S.busy = 'vincular'; renderDetalle();
      api('POST', ruta, body).then(function (r) {
        S.busy = null;
        if (r.ok) { S.adminForm = null; return guardadoOk(c, 'Guardado · Vinculado pese a la contradicción', 'vincular'); }
        S.accionError = mensajeDe(r); S.adminForm = null; renderDetalle();
      });
      return;
    }
    if (tipo === 'link') {
      body = { clave: c.ml_key, motivo: motivo, expected_sku: pub.seller_sku || null };
      ruta = '/claves/link-de-pago';
    } else {
      // Destrabar: la operación en intervención es la que se destraba.
      var op = (S.ejec && S.ejec.operaciones || []).find(function (o) { return o.caso_id === c.id && o.estado === 'intervencion'; });
      if (!op) { err.textContent = 'No hay una operación en intervención para este caso.'; err.hidden = false; return; }
      body = { operation_id: opIdPara('destrabar:' + op.id), motivo: motivo };
      ruta = '/operaciones/' + op.id + '/destrabar';
      clave = 'destrabar:' + op.id;
    }
    S.busy = tipo;
    api('POST', ruta, body).then(function (r) {
      S.busy = null;
      if (r.red) { err.textContent = MSG_ERROR_SIN_RED; err.hidden = false; return; }
      if (clave) soltarOpId(clave);
      if (!r.ok) { err.textContent = mensajeDe(r); err.hidden = false; return; }
      S.adminForm = null;
      S.guardado = { caso: c.id, texto: tipo === 'link' ? 'Guardado · Link de pago' : 'Guardado · Destrabado' };
      anunciar(S.guardado.texto, 'estado');
      siguienteCaso();
    });
  }

  // ── Arranque ────────────────────────────────────────────────────────────────────────────────
  function init() {
    var v = null;
    try { v = localStorage.getItem('cv-atajos'); } catch (e) { v = null; }
    S.atajosOn = v !== 'off';
    aplicarAtajosUI();
    if (window.innerWidth >= 1024) {
      $('#cv-btn-ayuda').hidden = false;
      $('#cv-switch-wrap').hidden = false;
    }
    window.addEventListener('resize', function () {
      var ancho = window.innerWidth >= 1024;
      $('#cv-btn-ayuda').hidden = !ancho;
      $('#cv-switch-wrap').hidden = !ancho;
    });
    bindEventos();
    // Un <div> vivo para anuncios (aria-live) que no cambia de nodo.
    var live = document.createElement('div');
    live.id = 'cv-live'; live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    if (!window.Api) return;
    Api.requirePermiso('matcher').then(function (d) {
      if (!d) return;
      Api.installAuth();
      Api.guardBfcache();
      S.isAdmin = !!d.is_admin || (d.scopes && d.scopes.indexOf('all') !== -1);
      S.canWrite = S.isAdmin || (d.permisos || []).some(function (p) { return p.herramienta === 'matcher' && p.nivel === 'write'; });
      document.body.classList.toggle('cv-admin', S.isAdmin);
      actualizarContadoresIniciales();
      activarTab('casos');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
