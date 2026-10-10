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
    completada: 'aplicada', fallida: 'fallida', intervencion: 'frenada', bloqueada_impacto: 'espera' };
  // Cancelada NO es un rechazo de ML. identidad_operaciones no admite estado 'cancelada' (CHECK de la migración 082):
  // el backend la guarda como 'fallida' con ultimo_error 'cancelada: …'. Por eso se detecta por el texto.
  function esCancelada(o) {
    if (!o) return false;
    if (o.estado === 'cancelada') return true;
    return o.estado === 'fallida' && /^cancelada\b/i.test(String(o.ultimo_error || '').trim());
  }
  // Texto de una cancelación: el backend manda motivo_cancelacion ('sin_cambio_sku', texto libre o null).
  function cancelacionTxt(o) {
    var m = o && o.motivo_cancelacion;
    if (!m && o && /sku_anterior\s*==\s*sku_objetivo|no-op/i.test(String(o.ultimo_error || ''))) m = 'sin_cambio_sku';
    if (m === 'sin_cambio_sku') return 'Cancelada: no hacía falta cambiar el SKU';
    if (m) return sinNombres('Cancelada: ' + motivoTxt(m).charAt(0).toLowerCase() + motivoTxt(m).slice(1));
    return 'Cancelada';
  }
  // Estado visible de una operación/pausa: 'cancelada' tiene prioridad sobre 'fallida'.
  function estOp(o) { return esCancelada(o) ? 'cancelada' : (ESTADO_OP[o.estado] || o.estado); }
  // Contrato nuevo de /ejecucion: operaciones = solo accionables; completadas y canceladas = {total, items[]} paginadas;
  // fallidas y canceladas_total = números. Si completadas/canceladas no vienen como objeto (backend viejo), se degrada.
  function esNuevo(e) {
    return !!e && typeof e.completadas === 'object' && e.completadas !== null && typeof e.canceladas === 'object' && e.canceladas !== null;
  }
  // Fallidas reales: data.fallidas del backend ya excluye canceladas.
  // Si el backend no manda un conteo de canceladas (build anterior), se descuentan en el cliente.
  function fallidasReales(e) {
    var f = (e && e.fallidas) || 0;
    if (e && (typeof e.canceladas_total === 'number' || typeof e.canceladas === 'number')) return f;
    return f - ((e && e.operaciones) || []).filter(function (o) { return o.estado === 'fallida' && esCancelada(o); }).length;
  }
  function canceladasN(e) {
    if (e && typeof e.canceladas_total === 'number') return e.canceladas_total;
    if (e && typeof e.canceladas === 'number') return e.canceladas;
    if (esNuevo(e)) return e.canceladas.total || 0;
    return ((e && e.operaciones) || []).filter(esCancelada).length;
  }
  var MSG = {
    NOT_FOUND: 'Este caso ya no existe. Se resolvió o lo sacaron.',
    INVALID_INPUT: 'Falta completar un dato (por ejemplo, el motivo). Revisá lo marcado.',
    omitir_requiere_override: 'Esta publicación está en "no sincronizar". Quitalo antes de vincular.',
    INVALID_STATE: 'Este caso no admite esa acción en su estado actual.',
    OPERACION_DUPLICADA: 'Ya se mandó este cambio. Mirá su estado en Ejecución.',
    OPERACION_YA_INICIADA: 'Ya se empezó a aplicar en ML.',
    vista_vieja: 'El vínculo cambió. Se recarga el caso.'
  };
  // Mapa único código → texto humano. Lo usan la cola, el detalle, Ejecución, Retenidas e Historial.
  // Cubre los códigos que emiten lib/catalogoVinculos.js, lib/identidadProductos.js y lib/guardiaMl.js.
  // Un código no mapeado cae en motivoTxt() y se muestra en snake_case→texto (nunca el código crudo con guiones bajos).
  // Motivos de regla que arma el backend (lib/proteccionIdentidad.js): "sin_vinculo:<clasificación>", "hermana_user_product:<clave>", etc.
  var CLASIF_TXT = { sku_ausente: 'la publicación no tiene SKU', sku_vacio: 'el SKU de la publicación está vacío',
    sku_inexistente: 'el SKU no existe en Woo', sku_no_unico: 'el SKU está repetido en Woo',
    contradiccion_titulo: 'el título contradice el producto', gtin_contradictorio: 'el código de barras no coincide' };
  var MOTIVO_REGLA_TXT = { intervencion: 'caso en intervención', omitir: 'publicación marcada como no sincronizar',
    contradiccion_sku_distinto: 'el SKU de ML es distinto al de Woo', hermana_user_product: 'hay una variante con producto de usuario' };
  function motivoRegla(code) {
    if (code == null || code === '') return '';
    var k = String(code).trim();
    var m = /^sin_vinculo:(.+)$/.exec(k);
    if (m) return 'sin vínculo: ' + (CLASIF_TXT[m[1]] || motivoTxt(m[1]).toLowerCase());
    m = /^hermana_user_product:/.exec(k);
    if (m) return MOTIVO_REGLA_TXT.hermana_user_product;
    if (MOTIVO_REGLA_TXT[k]) return MOTIVO_REGLA_TXT[k];
    return motivoTxt(k);
  }
  // Ningún nombre propio de persona en motivos de sistema (cancelaciones, reglas): "por José" -> "por un usuario".
  function sinNombres(t) {
    return String(t).replace(/\bpor (?!ML\b|Woo\b|WooCommerce\b|Fusion\b|Mercado\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*/g, 'por un usuario');
  }
  var TIPO_IDENT_TXT = { ean_8: 'EAN-8', ean_13: 'EAN-13', upc_a: 'UPC-A', gtin_14: 'GTIN-14' };
  function tipoIdentTxt(t) {
    if (!t) return '';
    var k = String(t).trim().toLowerCase();
    return TIPO_IDENT_TXT[k] || k.replace(/_/g, '-').toUpperCase();
  }
  var MOTIVO_TXT = {
    sku_ausente: 'Sin SKU en la publicación',
    sku_vacio: 'La publicación no tiene SKU',
    sku_inexistente: 'Sin producto asignado',
    sku_no_unico: 'SKU repetido en Woo',
    sku_exacto: 'SKU coincide',
    gtin_contradictorio: 'El GTIN no coincide',
    contradiccion_titulo: 'El título no coincide',
    stock_no_verificado: 'Stock sin verificar',
    disponible: 'Disponible',
    no_disponible: 'Sin dato',
    bloqueado_contradiccion: 'Bloqueada por contradicción',
    sin_cobertura: 'Sin cobertura',
    cubierto_o_sin_exposicion: 'Cubierta o sin exposición',
    pedido_retenido: 'Pedido retenido',
    pedido_liberado: 'Pedido liberado',
    scan_sano: 'Sin problemas',
    identidad_contradiccion: 'Contradicción de identidad',
    cambio_identidad: 'Cambio de identidad',
    identidad_ml_archivada: 'Publicación archivada en ML',
    gtin_marcado_incorrecto: 'GTIN marcado como incorrecto',
    regla_proteccion: 'Regla de protección',
    proteccion_woo: 'Protección de Woo',
    decision_no_aplicada: 'Decisión no aplicada'
  };
  function motivoTxt(code) {
    if (code == null || code === '') return '';
    var k = String(code).trim();
    if (MOTIVO_TXT[k]) return MOTIVO_TXT[k];
    var t = k.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  // Único mapa de status de publicaciones ML (valores crudos de ML -> texto para la operadora).
  // Todas las vistas que muestran status de ML pasan por estadoMlTxt().
  var ESTADO_ML_TXT = {
    active: 'Activa',
    paused: 'Pausada',
    closed: 'Cerrada',
    under_review: 'En revisión',
    inactive: 'Inactiva',
    not_yet_active: 'Todavía no activa',
    payment_required: 'Pendiente de pago',
    banned: 'Bloqueada'
  };
  function estadoMlTxt(code) {
    if (code == null || code === '') return 'Sin dato';
    var k = String(code).trim();
    if (ESTADO_ML_TXT[k]) return ESTADO_ML_TXT[k];
    return motivoTxt(k) || 'Sin dato';
  }
  // "Reintenta José" pasa a ser "Lo reintenta un admin"; para un admin, "Reintentalo".
  function reintentaTxt() { return S.isAdmin ? 'Reintentalo.' : 'Lo reintenta un admin.'; }
  // Helper único de plural para toda la pantalla: cuenta(1,'fallida','fallidas') -> "1 fallida"; cuenta(2,…) -> "2 fallidas".
  function plural(n, uno, varios) { return n === 1 ? uno : varios; }
  function cuenta(n, uno, varios) { return n + ' ' + plural(n, uno, varios); }
  // Código de error de ML → texto humano. ultimo_error llega como "ML rechazó la escritura (ruta): <detalle>"
  // o como el código suelto. Sin mapeo cae a "Error de ML: <código>".
  var ERR_ML_TXT = {
    dup: 'SKU duplicado en ML', duplicate: 'SKU duplicado en ML', duplicated: 'SKU duplicado en ML',
    not_found: 'La publicación ya no existe en ML', forbidden: 'ML no permitió este cambio',
    unauthorized: 'La sesión con ML venció', rate_limited: 'ML limitó las consultas, reintentá más tarde'
  };
  function errMlTxt(raw) {
    var s = String(raw || '').trim().replace(/^ML rechazó la escritura \([^)]*\):\s*/, '').trim();
    if (!s || s === 'sin detalle') return 'Error de ML sin detalle';
    var k = s.toLowerCase();
    if (ERR_ML_TXT[k]) return ERR_ML_TXT[k];
    if (/duplicad|duplicate|\bdup\b/.test(k)) return ERR_ML_TXT.dup;
    return 'Error de ML: ' + s.slice(0, 80);
  }
  // Permalink de la publicación en ML: el de la API si viene; si no, la URL del artículo por clave (sin variación ni pipe).
  function urlML(pub, clave) {
    if (pub && pub.permalink) return pub.permalink;
    var item = normClave(clave).split('|')[0];
    return item ? 'https://articulo.mercadolibre.com.ar/' + encodeURIComponent(item) : null;
  }
  var MSG_ERROR_SIN_RED = 'Sin conexión. No se guardó nada.';
  var MSG_SIN_PERMISO = 'No tenés permiso para esto.';
  var PUNTO_CORTE_PC = 768;
  var MOTIVO_NINGUNO_TXT = { no_es_ninguno: 'No es ninguno de estos', no_existe_en_woo: 'No existe en Woo' };
  // Fechas para la excepción solo ML: el vencimiento es un día posterior a hoy (hora local) como mínimo.
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function minVence() { var d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); }
  function ddmm(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] : String(iso || ''); }
  // Error de lectura: código conocido en castellano; si no, el texto del backend recortado (sin el prefijo de escrituras).
  function lecturaErrTxt(raw) {
    var s = String(raw || '').trim();
    return ERR_ML_TXT[s.toLowerCase()] || (s ? s.slice(0, 120) : 'sin detalle');
  }
  // "hace 5 min" para la última lectura confiable; a partir de un día, la fecha absoluta.
  function relTxt(iso) {
    if (!iso) return 'sin registro';
    var t = Date.parse(iso);
    if (isNaN(t)) return String(iso);
    var min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'hace instantes';
    if (min < 60) return 'hace ' + min + ' min';
    var h = Math.round(min / 60);
    if (h < 24) return 'hace ' + h + (h === 1 ? ' hora' : ' horas');
    return fecha(iso);
  }

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
  function atajoTxt(k) { return '<kbd class="cv-kbd cv-kbd-accion" aria-hidden="true">' + k + '</kbd>'; }
  function cuentaCampos(motivos) {
    var campos = (motivos || []).map(function (m) { return CAMPO_TXT[m.campo] || m.etiqueta || m.campo; });
    return campos.length ? campos.join(', ') : 'los atributos marcados';
  }

  // ── Estado de la pantalla ──────────────────────────────────────────────────────────────────────
  var S = {
    isAdmin: false, canWrite: false,
    tab: 'casos', offline: false, busy: null,
    filtro: 'abiertos', conteos: {}, cola: [], colaTotal: 0, colaError: null, colaCargada: false,
    casoId: null, detalle: null, detalleError: null, ejec: null,
    candidatos: null, candidatosError: null, elegido: null, elegidoIdx: null, matrizError: null,
    queryCand: '', soloDif: false,
    guardado: null, conflictoVersion: null, hermanas: null, accionError: null, accionInfo: null, focoPendiente: null,
    nsOpId: null, nsVariante: null, nsConfirm: false, nsEnviando: false,
    deshacer: null, deshacerTimer: null,
    opIds: {}, dlgActivo: null, dlgDisparador: null,
    ejecEstados: null, ejecPoll: null, ejecError: null, ejecMsgs: {}, busyOp: null,
    ejecQ: '', ejecSnap: null, ejecTimer: null, ejecAbiertas: { completadas: false, canceladas: false }, ejecMasBusy: null, ejecMasError: null,
    retenidas: null, retError: null, retAbierta: null, retAviso: {},
    vincResultados: null, vincQ: '', vincPanel: null, identMsg: null,
    vincItems: [], vincTotal: 0, vincOffset: 0, vincConteos: null, vincCargandoMas: false,
    conflictos: null, conflictosError: null, conflictoAbierto: null, conflictoDetalle: null, confResolver: null,
    estadoRaw: null, adminForm: null, dispSel: null, notaTxt: '', notaError: null, histOpen: false, franjaLista: null,
    matrizSeq: 0, pubsCache: {}, confMotivo: null
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

  // Copy del veto: para José se le ofrece confirmar; para el operador, la razón es que lo confirma José.
  function textoVeto(motivos) {
    return 'No se puede vincular: difiere ' + cuentaCampos(motivos) + '. '
      + (S.isAdmin ? 'Podés confirmar igual (solo admin).' : 'Lo confirma un admin.');
  }

  // Escrituras solo en PC (>=768 px) y con permiso matcher:write. En celular la pantalla solo consulta (decisión de José).
  function puedeEscribir() {
    return !!S.canWrite && window.innerWidth >= PUNTO_CORTE_PC;
  }

  function mensajeDe(res) {
    if (res.red) return MSG_ERROR_SIN_RED;
    if (res.status === 403) return MSG_SIN_PERMISO;
    var d = res.data || {};
    if (d.code === 'contradiccion_titulo') return textoVeto(d.motivos);
    if (d.code === 'SIN_CAMBIO_SKU') {
      var pausada = S.detalle && S.detalle.caso && S.detalle.caso.publicacion && S.detalle.caso.publicacion.status === 'paused';
      return pausada ? 'Vínculo actualizado, ML ya tenía este SKU.' : 'Activa: ML ya tiene este SKU, no hay nada que cambiar.';
    }
    if (d.code === 'INVALID_INPUT' && d.error) return d.error;
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

  // Navegación de lectura: nunca se bloquea (ni offline ni con operación en curso).
  var NAV = ['tab', 'reintentar-carga', 'volver-cola', 'filtro', 'vinc-filtro', 'ver-mas', 'solo-dif', 'elegir', 'abrir', 'abrir-clave',
    'ver-conflicto', 'vinc-ml', 'vinc-historial', 'vinc-pubs-producto', 'ir-ejecucion', 'ir-retenidas', 'buscar-cand', 'reintentar-matriz', 'ejec-ver-mas'];
  // Única fuente del estado deshabilitado: la usan el render (accionesHtml) y aplicarBloqueo.
  // Offline bloquea escrituras; una operación en curso bloquea escrituras; la matriz en carga bloquea vincular.
  function bloqueado(accion) {
    if (NAV.indexOf(accion) !== -1) return false;
    if (S.busy) return true;
    if (S.offline) return true;
    if (S.matrizCargando && (accion === 'vincular' || accion === 'hermanas-si' || accion === 'conflicto-aplicar')) return true;
    if (accion === 'vincular') {
      var m = (S.detalle && S.detalle.matriz) || {};
      return !S.elegido || !!(S.elegido && m.veto) || !!S.matrizError;
    }
    return false;
  }

  // Acciones deshabilitadas (aria-disabled, no disabled). Se re-aplica tras cada cambio de estado.
  function aplicarBloqueo() {
    $$('[data-accion]').forEach(function (el) {
      el.setAttribute('aria-disabled', bloqueado(el.getAttribute('data-accion')) ? 'true' : 'false');
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
      S.estadoRaw = e;
      var salud = e.salud || {};
      var conc = e.conciliacion || {};
      var bolsa = cuentaLista(e.conflictos_bolsa);
      var sinRespaldo = cuentaLista(e.sin_respaldo_woo);
      var protec = cuentaLista(e.esperando_proteccion);
      var chips = [
        // lbl: etiqueta corta visible; largo: texto completo (title y aria-label).
        { lbl: 'Lectura', largo: 'Salud de lectura', txt: salud.sano ? 'Sana' : (salud.degradado ? 'Degradada' : 'Con observación'), alerta: !salud.sano, accion: 'ir-ejecucion' },
        { lbl: 'Conciliación', largo: 'Conciliación', txt: conc.exacta ? 'Exacta' : 'Sin conciliar', alerta: !conc.exacta, accion: 'ir-ejecucion' },
        { lbl: 'Bolsa compartida', largo: 'Conflictos de bolsa compartida', txt: String(bolsa), alerta: bolsa > 0, accion: 'franja-lista', lista: 'bolsa' },
        { lbl: 'Sin respaldo Woo', largo: 'Vendiendo sin respaldo en Woo', txt: String(sinRespaldo), critico: sinRespaldo > 0, accion: 'franja-lista', lista: 'sinrespaldo' },
        { lbl: 'Protección pendiente', largo: 'Protección pendiente', txt: String(protec), alerta: protec > 0, accion: 'franja-lista', lista: 'proteccion' }
      ];
      cont.innerHTML = chips.map(function (c) {
        var clase = c.critico ? ' cv-chip-salud--critico' : (c.alerta ? ' cv-chip-salud--alerta' : '');
        var icono = c.critico ? '✗ ' : (c.alerta ? '⚠ ' : '');
        var completo = c.largo + ': ' + c.txt;
        return '<button type="button" class="cv-chip-salud' + clase + '" data-accion="' + c.accion + '"'
          + ' title="' + esc(completo) + '" aria-label="' + esc(completo) + '"'
          + (c.lista ? ' data-lista="' + c.lista + '" aria-expanded="' + (S.franjaLista === c.lista) + '"' : '')
          + '><span class="cv-chip-salud__lbl">' + esc(c.lbl) + '</span>'
          + '<b class="cv-chip-salud__val">' + icono + esc(c.txt) + '</b></button>';
      }).join('');
      renderFranjaEstado(salud);
      renderFranjaLista();
    });
  }

  // Modo, escrituras, última lectura confiable y error de lectura (Fase D H5). El error va en role=alert.
  function renderFranjaEstado(salud) {
    var box = $('#cv-estado-detalle');
    var lineas = [];
    if (salud.modo === 'shadow') lineas.push('Modo prueba: no se escribe en ML');
    else if (salud.modo === 'enforced') lineas.push('Modo normal · ' + (salud.escrituras_remotas ? 'escribe en ML' : 'escrituras a ML pausadas'));
    lineas.push('Última lectura confiable de ML: ' + relTxt(salud.ultima_lectura_confiable));
    var error = salud.error_lectura
      ? '<div class="ui-aviso ui-aviso--critico" role="alert"><span class="cv-icono" aria-hidden="true">✗</span><span>La lectura de ML falló: ' + esc(lecturaErrTxt(salud.error_lectura)) + '</span></div>'
      : '';
    // Lectura incompleta (campo nuevo del backend). Si no viene, no se muestra nada (backend viejo).
    var incompleta = '';
    if (salud.observacion_incompleta === true) {
      var det = salud.observacion_incompleta_detalle ? ' (' + String(salud.observacion_incompleta_detalle).slice(0, 160) + ')' : '';
      incompleta = '<div class="ui-aviso ui-aviso--atencion" role="alert"><span class="cv-icono" aria-hidden="true">!</span><span>La lectura de ML está incompleta: no confíes en los vínculos hasta que se complete.' + esc(det) + '</span></div>';
    }
    box.innerHTML = '<p class="cv-franja-detalle__linea">' + lineas.map(esc).join(' · ') + '</p>' + incompleta + error;
  }

  // Listas de la franja: se resuelven con GET estado; cada caso se abre en Casos (abrirPorClave).
  function renderFranjaLista() {
    var box = $('#cv-franja-lista');
    var e = S.estadoRaw || {};
    var l = S.franjaLista;
    if (!l) { box.innerHTML = ''; return; }
    var items = [];
    if (l === 'bolsa') items = (e.conflictos_bolsa || []).map(function (x) {
      return { clave: String(x.claves || '').split(',')[0], texto: (x.skus || '') + ' comparten ' + (x.user_product_id || '') + ' · ' + (x.claves || '') };
    });
    if (l === 'sinrespaldo') items = (e.sin_respaldo_woo || []).map(function (x) {
      return { clave: x.clave, texto: (x.titulo || x.clave) + ' · SKU ' + (x.seller_sku || 'sin SKU') + ' · ML ' + (x.available_quantity == null ? 'sin dato' : x.available_quantity) };
    });
    if (l === 'proteccion') items = (e.esperando_proteccion || []).map(function (x) {
      return { clave: x.ml_key, texto: (x.titulo || x.ml_key) + ' · ' + (x.clasificacion || '') };
    });
    var titulo = { bolsa: 'Conflictos de bolsa compartida', sinrespaldo: 'Vendiendo sin respaldo en Woo', proteccion: 'Protección pendiente' }[l];
    box.innerHTML = '<section class="ui-aviso ui-aviso--atencion cv-bloque" aria-label="' + esc(titulo) + '"><h3 class="cv-h2">' + esc(titulo) + '</h3>'
      + (items.length
        ? '<ul class="cv-lista-hermanas">' + items.map(function (it) {
            return '<li>' + esc(it.texto) + (it.clave ? ' <button type="button" class="ui-btn" data-accion="abrir-clave" data-clave="' + esc(it.clave) + '">Abrir caso</button>' : '') + '</li>';
          }).join('') + '</ul>'
        : '<p class="ui-resumen">No hay casos en esta lista.</p>')
      + '</section>';
  }

  // Busca el caso abierto de una publicación probando las 4 colas (q filtra por clave en la API).
  function buscarCasoPorClave(clave) {
    var fs = ['abiertos', 'salteados', 'intervencion', 'pausadas'];
    var paso = function (i) {
      if (i >= fs.length) return Promise.resolve(null);
      return api('GET', '/cola?filtro=' + fs[i] + '&limit=200&q=' + enc(clave)).then(function (r) {
        var f = r.ok && (r.data.data || []).find(function (x) { return normClave(x.ml_key) === normClave(clave); });
        return f ? { id: f.caso_id, filtro: fs[i] } : paso(i + 1);
      });
    };
    return paso(0);
  }

  function abrirPorClave(clave) {
    return buscarCasoPorClave(clave).then(function (m) {
      if (!m) { anunciar('No hay un caso abierto para esa publicación.', 'alerta'); return; }
      S.filtro = m.filtro; S.colaCargada = false; S.guardado = null;
      var prep = S.tab !== 'casos' ? (activarTab('casos'), Promise.resolve()) : cargarCola({ seleccionar: false });
      return prep.then(function () { return abrirCaso(m.id, { foco: true }); });
    });
  }

  function irACaso(id, conHistorial) {
    S.histOpen = !!conHistorial; S.guardado = null;
    if (S.tab !== 'casos') activarTab('casos');
    return cargarCola({ seleccionar: false }).then(function () { return abrirCaso(id, { foco: true }); });
  }

  function renderFiltros() {
    $('#cv-filtros').innerHTML = FILTROS.map(function (f) {
      var n = S.conteos[f[0]];
      var on = S.filtro === f[0];
      return '<button type="button" class="ui-chip" data-accion="filtro" data-filtro="' + f[0] + '" aria-pressed="' + on + '">'
        + esc(f[1]) + (n != null ? ' · ' + n : '') + '</button>';
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
    var hayMas = S.colaTotal > S.cola.length;
    var salteados = S.conteos.salteados > 0;
    if (!S.cola.length) {
      cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>' + ({ salteados: 'No hay casos salteados.', intervencion: 'No hay casos en intervención.', pausadas: 'No hay casos pausados.' }[S.filtro] || 'No hay casos abiertos') + '</p>'
        + (S.filtro === 'abiertos' && salteados ? '<button type="button" class="ui-btn" data-accion="filtro" data-filtro="salteados">Ver salteados</button>' : '')
        + '</div>';
      $('#cv-cola-mas').innerHTML = '';
      return;
    }
    cont.classList.toggle('cv-cola--scroll', S.cola.length > 6);
    var titulo = $('#cola-titulo');
    if (titulo) titulo.textContent = hayMas
      ? 'Cola · ' + S.cola.length + ' de ' + S.colaTotal
      : 'Cola · ' + cuenta(S.cola.length, 'caso', 'casos');
    $('#cv-cola-mas').innerHTML = hayMas
      ? '<button type="button" class="ui-btn" data-accion="ver-mas" aria-disabled="' + !!S.busy + '">Ver más (quedan ' + (S.colaTotal - S.cola.length) + ')</button>'
      : '';
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
        + '<span class="cv-caso__motivo">' + esc(motivoTxt(f.motivo)) + (f.salteado_por ? ' <span class="cv-salteado">· ↷ Salteado por ' + esc(f.salteado_por) + '</span>' : '') + '</span>'
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
    return api('GET', '/cola?filtro=' + S.filtro + '&limit=' + LIMITE_COLA + '&offset=0').then(function (r) {
      S.colaCargada = true;
      if (!r.ok) { S.colaError = mensajeDe(r); S.cola = []; S.colaTotal = 0; renderCola(); return; }
      S.colaError = null;
      S.cola = r.data.data || [];
      S.colaTotal = r.data.total != null ? r.data.total : S.cola.length;
      $('#cnt-casos').textContent = '· ' + S.colaTotal;
      renderFiltros();
      renderCola();
      if (opts.seleccionar !== false) {
        var sigue = S.cola.some(function (f) { return f.caso_id === S.casoId; });
        if (!sigue && S.cola.length) abrirCaso(S.cola[0].caso_id, { foco: false });
        else if (!S.cola.length) { S.casoId = null; S.detalle = null; renderDetalleVacio(); }
      }
    });
  }

  // "Ver más": pide la página siguiente (offset = casos ya cargados) y la agrega al final de la cola.
  function verMasCola() {
    if (S.busy || S.cola.length >= S.colaTotal) return Promise.resolve();
    var desde = S.cola.length;
    S.busy = 'ver-mas';
    return api('GET', '/cola?filtro=' + S.filtro + '&limit=' + LIMITE_COLA + '&offset=' + desde).then(function (r) {
      S.busy = null;
      if (!r.ok) { anunciar(mensajeDe(r), 'alerta'); aplicarBloqueo(); return; }
      var nuevos = r.data.data || [];
      S.cola = S.cola.concat(nuevos);
      if (r.data.total != null) S.colaTotal = r.data.total;
      renderCola();
      var primero = $('#cv-cola [data-caso="' + (nuevos[0] && nuevos[0].caso_id) + '"]');
      if (primero) primero.focus();
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
    // Si la última acción fue la que vació la cola, su confirmación (y el deshacer) sigue visible aquí.
    d.innerHTML = (S.guardado ? barraGuardado() : '') + '<p class="cv-vacio-det">Elegí un caso de la cola.</p>';
    aplicarBloqueo();
  }

  // ── Detalle ────────────────────────────────────────────────────────────────────────────────────
  function abrirCaso(id, opts) {
    opts = opts || {};
    S.casoId = id;
    if (S.queryCandCaso !== id) { S.queryCand = ''; S.queryCandCaso = id; }
    S.candidatos = null; S.candidatosError = null; S.elegido = null; S.elegidoIdx = null; S.matrizError = null; S.matrizCargando = false;
    S.hermanas = null; S.accionError = null; S.accionInfo = null; S.conflictoVersion = null; S.retAbierta = null;
    var d = $('#cv-detalle');
    d.setAttribute('aria-busy', 'true');
    d.innerHTML = '<div class="cv-skeleton cv-skeleton--det"></div>';
    marcarSeleccionEnCola();
    return api('GET', '/casos/' + id).then(function (r) {
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
      // /ejecucion completo solo si el caso lo necesita (intervención, o hay fallidas que mirar); si no, sirve la copia cacheada.
      var necesitaEjec = !S.ejecSnap || fallidasReales(S.ejecSnap) > 0 || S.detalle.caso.estado === 'intervencion';
      var ej = necesitaEjec ? api('GET', '/ejecucion') : Promise.resolve(null);
      return ej.then(function (re) {
        // Sin q: la respuesta es el snapshot real del caso (nunca una caché filtrada por el buscador).
        if (re && re.ok) S.ejecSnap = re.data.data;
        if (S.casoId !== id) return;
        return (soloLecturaDetalle() ? Promise.resolve() : buscarCandidatos(S.queryCand || S.detalle.caso.publicacion?.titulo || '')).then(function () {
          renderDetalle();
          if (opts.foco) enfocarDetalle();
        });
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
    var casoAntes = S.casoId;
    S.candCargando = true; renderDetalle();
    var extra = (pub.gtin ? '&gtin_ml=' + enc(pub.gtin) : '') + (pub.seller_sku ? '&sku_ml=' + enc(pub.seller_sku) : '');
    return identidad('/productos/buscar?q=' + enc(S.queryCand.trim()) + extra).then(function (r) {
      if (S.casoId !== casoAntes) return; // respuesta tardía de otro caso: se descarta
      S.candCargando = false;
      if (!r.ok) { S.candidatosError = mensajeDe(r); S.candidatos = []; return; }
      S.candidatosError = null;
      S.candidatos = (r.data.data || []).slice(0, 3);
    });
  }

  function elegirCandidato(idx, porTeclado) {
    var c = (S.candidatos || [])[idx];
    if (!c || !S.detalle) return Promise.resolve();
    S.elegido = c; S.elegidoIdx = idx;
    S.accionError = null; S.accionInfo = null;
    // Por teclado el foco va al contenedor (no interactivo): así Enter vincula y no vuelve a elegir la candidata.
    S.focoPendiente = porTeclado ? '#cv-detalle' : '[data-accion="elegir"][data-idx="' + idx + '"]';
    return cargarMatriz(c);
  }

  // Matriz contra un candidato. Si falla, Vincular queda bloqueado hasta reintentar (no se decide a ciegas).
  function cargarMatriz(c) {
    // Contador de petición: solo la última vigente baja la bandera y aplica resultado; las viejas se descartan.
    var req = ++S.matrizSeq;
    S.matrizError = null; S.matrizCargando = true;
    aplicarBloqueo();
    return api('GET', '/casos/' + S.casoId + '?sku=' + enc(c.sku_woo || '')).then(function (r) {
      if (req !== S.matrizSeq) return;
      S.matrizCargando = false;
      if (S.elegido !== c) return;
      if (r.ok) { S.detalle.matriz = r.data.data.matriz; }
      else { S.detalle.matriz = null; S.matrizError = 'No pudimos comparar; reintentá.'; S.focoPendiente = '#err-matriz'; }
      renderDetalle();
    });
  }

  function skuDe(c) { return (c && (c.sku_woo || c.fusion_sku)) || ''; }

  function setErrorAccion(texto) {
    S.accionError = texto; S.accionInfo = null;
    S.focoPendiente = '#err-accion';
  }

  function opIdPara(clave) {
    if (!S.opIds[clave]) S.opIds[clave] = uuid();
    return S.opIds[clave];
  }
  function soltarOpId(clave) { delete S.opIds[clave]; }
  // Cuerpo común de las escrituras con versión: operation_id por intento, expected_version y evidence_fingerprint del caso.
  function cuerpoMutacion(clave, extra) {
    var c = caso();
    return Object.assign({ operation_id: opIdPara(clave), expected_version: c.expected_version, evidence_fingerprint: c.evidencia_fingerprint }, extra || {});
  }
  // Versión y evidencia actuales del caso, sin repintar la pantalla. Deshacer y revertir las leen antes de mandar.
  function versionActual(casoId) {
    return api('GET', '/casos/' + casoId).then(function (r) {
      if (!r.ok) return { error: mensajeDe(r) };
      var c = r.data.data && r.data.data.caso;
      return c ? { expected_version: c.expected_version, evidence_fingerprint: c.evidencia_fingerprint } : { error: MSG.NOT_FOUND };
    });
  }
  // Error de campo: texto junto al control, aria-invalid y foco en el control.
  function marcarError(campo, err, texto) {
    err.textContent = texto; err.hidden = false;
    if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
  }
  function limpiarError(campo, err) {
    err.hidden = true;
    if (campo) campo.removeAttribute('aria-invalid');
  }

  function caso() { return S.detalle && S.detalle.caso; }
  function casoEnCola() { return S.cola.find(function (f) { return f.caso_id === S.casoId; }) || null; }

  function operacionDelCaso() {
    var ops = (S.ejecSnap && S.ejecSnap.operaciones) || [];
    return ops.find(function (o) { return o.caso_id === S.casoId && !esCancelada(o) && ['fallida', 'intervencion', 'bloqueada_impacto'].indexOf(o.estado) !== -1; }) || null;
  }

  function tarjetaOperacion() {
    var o = operacionDelCaso();
    if (!o) return '';
    var esFallida = o.estado === 'fallida';
    var esEspera = o.estado === 'bloqueada_impacto';
    var titulo = esFallida ? '✗ ML la rechazó' : (esEspera ? '⏳ Espera tu confirmación' : '⏸ Frenada');
    var motivo = o.ultimo_error || (esFallida ? 'sin detalle' : 'regla de protección');
    var accion = esFallida ? reintentaTxt() : 'Stock en 0 hasta resolver.';
    var texto = esFallida ? errMlTxt(o.ultimo_error) + '. ' + accion
      : (esEspera ? 'La pausa de otras variaciones necesita confirmación de un admin.' : 'Frenada: ' + motivo + '. ' + accion);
    return '<section class="cv-tarjeta-op" role="region" aria-label="Operación con problema" tabindex="-1">'
      + '<h3>' + titulo + '</h3><p>' + esc(texto) + '</p>'
      + '<p><a href="#cv-ejec" data-accion="ir-ejecucion">Ver en Ejecución</a>'
      + (S.retenidasDelCaso ? ' · <a href="#cv-ret" data-accion="ir-retenidas">Ver ' + S.retenidasDelCaso + plural(S.retenidasDelCaso, ' venta retenida', ' ventas retenidas') + '</a>' : '')
      + '</p></section>';
  }

  function semaforoHtml(f) {
    var leve = f.campo === 'gtin' && f.semaforo === 'ambar' && f.texto === 'Difiere';
    return '<span class="cv-sem cv-sem--' + f.semaforo + '"><span aria-hidden="true">' + ICONO[f.semaforo] + '</span> ' + esc(f.texto) + '</span>'
      + (leve ? ' <span class="cv-sem cv-sem--leve">leve<span class="sr-only">: sigue vendiendo</span></span>' : '');
  }

  function matrizHtml() {
    var m = caso() && S.detalle.matriz;
    if (S.matrizError) {
      return '<div class="ui-aviso ui-aviso--critico cv-aviso-fijo cv-aviso-rojo" role="alert" tabindex="-1" id="err-matriz"><span class="cv-icono" aria-hidden="true">✗</span>'
        + '<span>' + esc(S.matrizError) + ' <button type="button" class="ui-btn" data-accion="reintentar-matriz">Reintentar</button></span></div>';
    }
    if (!S.elegido) return '<p class="ui-resumen cv-matriz-vacia">' + (soloLecturaDetalle() ? 'No hay candidato para comparar.' : 'La comparación aparece al elegir un candidato.') + '</p>';
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
    var estadoML = estadoMlTxt(obs.estado);
    var reglaTxt = regla.frena ? 'Stock 0 por ' + (motivoRegla(regla.motivo) || 'protección').toLowerCase() : ('Stock de Woo ' + (regla.stock_esperado != null ? regla.stock_esperado : 'sin dato'));
    var desfase = S.detalle.ml_no_refleja_regla
      ? '<div class="ui-aviso ui-aviso--atencion cv-aviso-desfase cv-aviso-fijo" role="note"><span class="cv-icono" aria-hidden="true">⚠</span><span>ML todavía no refleja la regla.</span></div>' : '';
    var vig = S.detalle.vinculo_vigente;
    var vigTxt = vig ? 'Vínculo vigente: SKU ' + vig.sku + ' · desde ' + fecha(vig.desde) : 'Vínculo vigente: sin vínculo activo';
    return '<div class="cv-datos">'
      + '<div class="cv-dato ui-panel"><h3 class="ui-label">Observado en ML</h3><p class="cv-dato__valor">' + esc(estadoML) + ' · cantidad ' + esc(obs.cantidad != null ? obs.cantidad : 'sin dato') + '</p></div>'
      + '<div class="cv-dato ui-panel"><h3 class="ui-label">Lo que manda la regla</h3><p class="cv-dato__valor">' + esc(reglaTxt) + '</p></div>'
      + '<div class="cv-dato ui-panel"><p class="cv-dato__valor" data-vig="1">' + esc(vigTxt) + '</p></div>'
      + '</div>' + desfase;
  }

  function candidatosHtml(soloLectura) {
    if (soloLectura) return '';
    var lista = S.candCargando ? [] : (S.candidatos || []);
    var filas = lista.map(function (p, i) {
      var sel = S.elegido && S.elegido.id === p.id;
      return '<button type="button" class="cv-cand" data-accion="elegir" data-idx="' + i + '" aria-pressed="' + !!sel + '">'
        + '<span class="cv-cand__num" aria-hidden="true">' + (i + 1) + '</span>'
        + (p.img ? '<img class="cv-cand__img" src="' + esc(p.img) + '" alt="" loading="lazy">'
          : '<span class="cv-cand__img cv-cand__img--vacia" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6"/></svg></span>')
        + '<span><span class="cv-cand__nombre">' + esc(p.nombre_canonico || p.nombre_woo || 'Producto') + '</span><br>'
        + '<span class="cv-cand__sku">SKU <span class="ui-id">' + esc(p.sku_woo || p.fusion_sku || '—') + '</span>'
        + (p.stock_woo != null ? ' · Stock Woo ' + esc(p.stock_woo) : '') + '</span>'
        + (p.precio != null ? '<br><span class="cv-cand__precio">' + esc(money(p.precio)) + '</span>' : '') + '</span>'
        + '<span class="cv-cand__estado">' + (sel ? '✓ Elegido' : '') + '</span></button>';
    }).join('');
    var error = S.candidatosError ? '<p class="cv-error">' + esc(S.candidatosError) + '</p>' : '';
    var vacio = S.candCargando ? '<p class="ui-resumen" role="status" aria-busy="true">Buscando candidatos…</p>'
      : ((!lista.length && !S.candidatosError) ? '<p class="ui-resumen">Sin candidatos para esa búsqueda. Probá con otro texto.</p>' : '');
    return '<section class="cv-bloque" aria-labelledby="cand-h">'
      + '<h3 id="cand-h" class="ui-label">Candidatos (1, 2 o 3 para elegir · sin preselección)</h3>'
      + '<form id="det-buscar" class="cv-buscador__fila" role="search" data-accion="buscar-cand">'
      + '<label class="sr-only" for="det-q">Buscar otra variante de producto</label>'
      + '<input id="det-q" class="ui-input" type="search" autocomplete="off" value="' + esc(S.queryCand) + '">'
      + '<button type="submit" class="ui-btn">Buscar</button></form>'
      + error + vacio
      + '<div class="cv-cands" role="group" aria-label="Candidatos">' + filas + '</div></section>';
  }

  // Disparador de paneles inline (Destrabar, Relevar, Confirmar igual, Link de pago): al abrir se guarda su selector
  // y Esc / Cancelar / éxito devuelven el foco ahí (o a #det-titulo si ya no existe).
  function selDe(el) {
    if (!el || !el.getAttribute) return '';
    var out = '';
    ['data-accion', 'data-admin', 'data-op', 'data-caso', 'data-orden', 'data-idx', 'data-tab', 'data-seccion'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v != null) out += '[' + a + '="' + String(v).replace(/"/g, '\\"') + '"]';
    });
    return out;
  }
  function recordarDisparador(el) { S.dispSel = selDe(el) || null; }
  function enfocarDisparador() {
    setTimeout(function () {
      var el = S.dispSel && $(S.dispSel);
      S.dispSel = null;
      (el || $('#det-titulo') || document.body).focus();
    }, 0);
  }
  // F3: un render del detalle no pisa el foco ni el texto que la persona está escribiendo.
  function renderDetalle() {
    var det = $('#cv-detalle'); var a = document.activeElement;
    var dentro = !!(det && a && a !== det && det.contains(a));
    var id = dentro ? a.id : '';
    var sel = dentro && !id ? selDe(a) : '';
    var val = dentro && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') ? a.value : null;
    var pendiente = !!S.focoPendiente;
    renderDetalleBase();
    if (!dentro || pendiente) return;
    var n = id ? document.getElementById(id) : (sel ? $(sel) : null);
    if (n) { if (val !== null && n.value !== val) n.value = val; n.focus(); }
  }
  function renderDetalleBase() {
    var d = $('#cv-detalle');
    d.setAttribute('aria-busy', 'false');
    if (S.detalleError && !S.detalle) { d.innerHTML = cajaError(S.detalleError, 'reabrirCaso'); return; }
    if (!S.detalle) return renderDetalleVacio();
    var c = caso(); var pub = c.publicacion || {};
    var enIntervencion = c.estado === 'intervencion';
    var soloLectura = soloLecturaDetalle();
    var en = casoEnCola();
    var chips = [];
    if (pub.status === 'paused') chips.push('<span class="ui-chip">⏸ PAUSADA</span>');
    if (en && en.chips && en.chips.hermanas > 0) chips.push('<span class="ui-chip">⧉ HERMANAS ' + en.chips.hermanas + '</span>');
    if (enIntervencion) chips.push('<span class="ui-chip ui-chip--urgente"><span aria-hidden="true">🔒</span> INTERVENCIÓN</span>');
    var guardado = S.guardado ? barraGuardado() : '';
    S.retenidasDelCaso = (S.retenidas || []).filter(function (f) { return (f.claves || []).indexOf(c.ml_key) !== -1; }).length;
    var lectura = enIntervencion
      ? '<p class="cv-lock">En intervención. ' + (S.isAdmin ? 'Lo destrabás vos.' : 'Lo destraba un admin.') + '</p>' : '';
    if (!puedeEscribir()) {
      lectura += '<p class="cv-leyenda-pc">' + (window.innerWidth < PUNTO_CORTE_PC ? 'Solo consulta en el celular. Para cambiar, usá la PC.' : 'Solo consulta: tu usuario no tiene permiso para cambiar casos.') + '</p>';
    }
    var html = guardado
      + '<button type="button" class="ui-btn cv-volver" data-accion="volver-cola">← Volver a la cola</button>'
      + '<div class="cv-det__cabecera"><h2 id="det-titulo" tabindex="-1">' + esc(pub.titulo || c.ml_key) + '</h2>'
      + '<div class="cv-det__meta">' + mlaHtml(pub, c.ml_key) + ' ' + chips.join(' ') + '</div>'
      + lectura + '</div>'
      + tarjetaOperacion()
      + (soloLectura ? '' : marcaNingunoHtml())
      + marcaExcepcionHtml()
      + datosHtml()
      + candidatosHtml(soloLectura)
      + (soloLectura ? '' : '<div class="cv-matriz-wrap"><div class="cv-matriz-cab"><button type="button" class="ui-btn" data-accion="solo-dif" aria-pressed="' + S.soloDif + '">Solo diferencias <kbd class="cv-kbd cv-kbd-pc" aria-hidden="true">d</kbd></button></div>' + matrizHtml() + '</div>')
      + (soloLectura ? '' : accionesHtml())
      + historialHtml()
      + (S.accionError ? '<div class="ui-aviso ui-aviso--critico cv-aviso-fijo cv-aviso-rojo" role="alert" tabindex="-1" id="err-accion"><span class="cv-icono" aria-hidden="true">✗</span><span>' + esc(S.accionError) + '</span></div>' : '')
      + (S.accionInfo ? '<div class="ui-aviso ui-aviso--info cv-aviso-fijo" role="status" id="info-accion"><span class="cv-icono" aria-hidden="true">ⓘ</span><span>' + esc(S.accionInfo.texto) + '</span>'
        + (S.accionInfo.ejecucion ? ' <button type="button" class="ui-btn" data-accion="ir-ejecucion">Ir a Ejecución</button>' : '') + '</div>' : '');
    d.innerHTML = html;
    aplicarBloqueo();
    if (S.focoPendiente) { var f = $(S.focoPendiente) || $('#det-titulo'); if (f) f.focus(); S.focoPendiente = null; }
    var q = $('#det-q'); if (q && S.queryCand) q.value = S.queryCand;
    var nt = $('#nota-txt'); if (nt) nt.value = S.notaTxt || '';
  }

  function mlaHtml(pub, clave) {
    var id = esc(pub.item_id || normClave(clave));
    var url = urlML(pub, clave);
    return url
      ? '<a class="ui-id" href="' + esc(url) + '" target="_blank" rel="noopener">' + id + '<span class="sr-only"> (abre la publicación en Mercado Libre, en otra pestaña)</span></a>'
      : '<span class="ui-id">' + id + '</span>';
  }

  function barraGuardado() {
    var g = S.guardado;
    var cuenta = '';
    if (S.deshacer && S.deshacer.caso === g.caso) {
      if (S.deshacer.tipo !== 'ns') {
        // Vincular, salteo y ninguno sirve: sin ventana de 10 s; el botón vive mientras la barra esté visible.
        cuenta = '<button type="button" class="ui-btn" data-accion="deshacer">' + esc(S.deshacer.etiqueta) + atajoTxt('z') + '</button>';
      } else {
        cuenta = S.deshacer.vencido
          ? '<span class="cv-deshacer">Ya no se puede deshacer</span>'
          : '<button type="button" class="ui-btn" data-accion="deshacer">Deshacer (10 s)' + atajoTxt('z') + ' · <span id="cv-deshacer-txt">' + esc(textoDeshacer()) + '</span></button>';
      }
    }
    // Operación ya iniciada en ML: no se deshace, se ofrece revertir (operación nueva, con motivo).
    if (g.revertirOp) cuenta += ' <button type="button" class="ui-btn" data-accion="revertir-caso" data-op="' + g.revertirOp + '" data-caso="' + g.caso + '">Revertir</button>';
    return '<div class="ui-aviso ui-aviso--' + (g.tono || 'ok') + ' cv-guardado" role="status" aria-live="polite">'
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
    var razonVeto = false;
    if (S.offline) razon = MSG_ERROR_SIN_RED;
    else if (!S.elegido) razon = 'Elegí un candidato para vincular.';
    else if (S.matrizError) razon = 'No pudimos comparar; reintentá.';
    else if (veto) { razon = textoVeto(m.motivos); razonVeto = true; }
    var bloq = bloqueado('vincular');
    var enviando = S.busy === 'vincular';
    var vinc = '<button type="button" class="ui-btn ui-btn--primario cv-btn-ancho" data-accion="vincular" aria-disabled="' + bloq + '"'
      + (razon ? ' aria-describedby="razon-vincular"' : '') + '>'
      + (enviando ? '<span class="cv-girando" aria-hidden="true">↻</span> Enviando…' : 'Vincular' + atajoTxt('Enter'))
      + '</button>';
    var razonHtml = razon ? '<p id="razon-vincular" class="cv-acciones__razon' + (razonVeto || S.offline || S.matrizError ? '' : ' cv-acciones__razon--neutra') + '">' + esc(razon) + '</p>' : '';
    var acciones = '<div class="cv-acciones__grid">'
      + '<button type="button" class="ui-btn" data-accion="saltear" aria-disabled="' + !!S.busy + '">Saltear' + atajoTxt('s') + '</button>'
      + '<button type="button" class="ui-btn" data-accion="no-sincronizar" aria-disabled="' + !!S.busy + '">No sincronizar' + atajoTxt('n') + '</button>'
      + '<button type="button" class="ui-btn" data-accion="excepcion" aria-disabled="' + !!S.busy + '">Excepción solo ML</button>'
      + '<button type="button" class="ui-btn" data-accion="ninguno" aria-disabled="' + !!S.busy + '">Ninguno sirve' + atajoTxt('x') + '</button>'
      + '</div>';
    var admin = '';
    if (S.isAdmin) {
      var destrabar = c.estado === 'intervencion'
        ? '<button type="button" class="ui-btn" data-accion="admin" data-admin="destrabar">Destrabar</button>' : '';
      admin = '<div class="cv-grupo-solo-jose"><p class="ui-label cv-lock">Solo admin</p><div class="cv-acciones__fila">'
        + (veto ? '<button type="button" class="ui-btn ui-btn--peligro" data-accion="admin" data-admin="confirmar">Confirmar igual</button>' : '')
        + destrabar
        + '<button type="button" class="ui-btn" data-accion="admin" data-admin="link">Link de pago</button>'
        + '</div>'
        + (S.adminForm && S.adminForm !== 'relevar' ? adminFormHtml() : '') + '</div>';
    }
    return '<div class="cv-acciones" role="group" aria-label="Acciones del caso">' + tomaHtml()
      + '<div class="cv-acciones__fila">' + vinc + '</div>' + razonHtml
      + acciones + admin + '</div>';
  }

  // Solo lectura del detalle: sin permiso de escritura, en celular, o caso en intervención para el operador.
  function soloLecturaDetalle() {
    var enIntervencion = !!(S.detalle && S.detalle.caso && S.detalle.caso.estado === 'intervencion');
    return !puedeEscribir() || (enIntervencion && !S.isAdmin);
  }

  function adminFormHtml() {
    var tipo = S.adminForm;
    var titulo = { relevar: 'Relevar · el caso pasa a vos. Motivo obligatorio.', confirmar: 'Confirmar igual · vincula pese a la contradicción', link: 'Link de pago · ignora stock y ventas', destrabar: 'Destrabar · vuelve a pendiente' }[tipo] || '';
    return '<form class="cv-cuadro-motivo" data-accion="admin-enviar" data-admin="' + tipo + '" novalidate>'
      + '<p class="ui-label">' + esc(titulo) + '</p>'
      + (tipo === 'link' && S.detalle && S.detalle.link_de_pago_sin_marketplace ? avisoSinMarketplaceHtml() : '')
      + '<label class="ui-label" for="adm-motivo">Motivo <span>(obligatorio)</span></label>'
      + '<textarea id="adm-motivo" class="ui-input" rows="2" aria-describedby="adm-err"></textarea>'
      + '<p id="adm-err" class="cv-error" hidden></p>'
      + '<div class="cv-acciones__fila"><button type="submit" class="ui-btn ui-btn--peligro">Confirmar</button>'
      + '<button type="button" class="ui-btn" data-accion="admin-cancelar">Cancelar</button></div></form>';
  }

  function hermanasHtml() {
    var n = S.hermanas.n;
    return '<div class="ui-aviso ui-aviso--atencion cv-foco-bloque" role="alert" tabindex="-1" id="bloque-hermanas">'
      + '<p><span aria-hidden="true">⚠</span> Esto cambia también ' + cuenta(n, 'publicación hermana', 'publicaciones hermanas') + '. ¿Seguimos?</p>'
      + listaHermanas(0)
      + '<div class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="hermanas-si">Vincular esta y ' + (n === 1 ? 'la hermana' : 'las ' + n + ' hermanas') + ' al SKU ' + esc(S.hermanas.sku || '—') + '</button>'
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
    if (!puedeEscribir() || !S.elegido || !caso() || S.busy || S.offline || S.matrizError || S.matrizCargando) return;
    var m = S.detalle.matriz || {};
    if (m.veto && !(extra && extra.override_contradiccion)) return; // Enter no hace nada con rojo
    var c = caso(); var cand = S.elegido;
    var body = cuerpoVincular(extra);
    S.busy = 'vincular'; S.accionError = null; S.accionInfo = null; S.hermanas = null;
    S.focoPendiente = '[data-accion="vincular"]';
    renderDetalle();
    api('POST', '/casos/' + c.id + '/decisiones', body).then(function (r) {
      S.busy = null;
      resultadoVincular(c, cand.id, body, r, null, cand);
    });
  }

  // Une las respuestas de cualquier decisión de vínculo (Vincular, hermanas, confirmar igual, reaplicar tras conflicto).
  // `cand` es el candidato con el que se vinculó (para el SKU que se muestra); se usa solo si viene.
  function resultadoVincular(c, productoId, body, r, textoOk, cand) {
    var clave = 'vincular:' + c.id + ':' + productoId;
    if (r.red) { setErrorAccion(MSG_ERROR_SIN_RED); return renderDetalle(); }
    if (r.ok) {
      soltarOpId(clave);
      var opV = r.data && r.data.operacion;
      guardadoOk(c, textoOk || 'Guardado · En cola para ML', 'vincular');
      // Deshacer solo si la operación se creó en este intento (un repetido no trae operación nueva).
      if (opV && opV.id && !r.data.repetido) setDeshacer({ tipo: 'vincular', caso: c.id, opId: opV.id, etiqueta: 'Deshacer vínculo' });
      return;
    }
    var code = r.data && r.data.code;
    if (r.status === 409 && code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED') {
      S.hermanas = { n: r.data.sibling_count, body: body, sku: skuDe(cand || S.elegido) };
      S.focoPendiente = '#bloque-hermanas';
      return renderDetalle();
    }
    if (r.status === 409 && (code === 'VERSION_CONFLICT' || code === 'EVIDENCE_CONFLICT')) {
      soltarOpId(clave);
      return recargarPorConflicto(c, productoId, body, cand || S.elegido);
    }
    soltarOpId(clave);
    // SIN_CAMBIO_SKU es un éxito informativo: ML ya tenía ese SKU. Pasa al siguiente caso con su texto.
    if (code === 'SIN_CAMBIO_SKU') return guardadoOk(c, mensajeDe(r), 'vincular');
    if (code === 'OPERACION_DUPLICADA') {
      S.accionInfo = { texto: mensajeDe(r), ejecucion: true };
      S.focoPendiente = '#info-accion';
      renderDetalle();
      return refrescarEjecucion();
    }
    setErrorAccion(mensajeDe(r));
    renderDetalle();
    refrescarEjecucion();
  }

  // Versión cambiada por otro: se recarga el caso, se avisa qué cambió y la decisión queda para reaplicar o descartar.
  function recargarPorConflicto(c, productoId, body, cand) {
    var viejo = { sku: skuVigente(S.detalle), estado: c.estado, responsable: c.responsable };
    return abrirCaso(c.id, { foco: false }).then(function () {
      if (S.casoId !== c.id || !S.detalle) return renderDetalle();
      var nuevo = { sku: skuVigente(S.detalle), estado: S.detalle.caso.estado, responsable: S.detalle.caso.responsable };
      S.elegido = cand || null;
      S.conflictoVersion = { body: body, cand: cand || null, diff: textoDiff(viejo, nuevo) };
      S.focoPendiente = '#bloque-conflicto';
      if (!cand) return renderDetalle();
      return cargarMatriz(cand);
    });
  }

  function skuVigente(det) { return det && det.vinculo_vigente ? det.vinculo_vigente.sku : null; }

  function textoDiff(viejo, nuevo) {
    var partes = [];
    if (viejo.sku !== nuevo.sku) partes.push('El SKU vigente pasó de ' + (viejo.sku || 'ninguno') + ' a ' + (nuevo.sku || 'ninguno') + '.');
    if (viejo.estado !== nuevo.estado) partes.push('El estado pasó de ' + viejo.estado + ' a ' + nuevo.estado + '.');
    if (viejo.responsable !== nuevo.responsable) partes.push('El responsable pasó de ' + (viejo.responsable || 'nadie') + ' a ' + (nuevo.responsable || 'nadie') + '.');
    return partes.length ? partes.join(' ') : 'Cambió la versión del caso.';
  }

  function guardadoOk(c, texto, accion) {
    S.guardado = { caso: c.id, texto: texto, titulo: c.publicacion && c.publicacion.titulo };
    S.elegido = null; S.candidatos = null; S.hermanas = null; S.adminForm = null; S.accionError = null;
    S.focoPendiente = '#det-titulo';
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
      var vacio = $('#cv-detalle'); if (vacio) vacio.focus();
    }).then(cargarEstado).then(cargarConteos);
  }

  function saltear() {
    var c = caso(); if (!puedeEscribir() || !c || S.busy || S.offline) return;
    S.busy = 'saltear';
    S.focoPendiente = '[data-accion="saltear"]';
    renderDetalle();
    api('POST', '/casos/' + c.id + '/saltear', { expected_version: c.expected_version }).then(function (r) {
      S.busy = null;
      if (r.ok) {
        S.guardado = { caso: c.id, texto: 'Salteado. Pasa al final de la cola.' };
        setDeshacer({ tipo: 'salteo', caso: c.id, etiqueta: 'Deshacer salteo' });
        S.focoPendiente = '#det-titulo'; cargarConteos(); return siguienteCaso();
      }
      if (r.status === 409 && r.data.code === 'VERSION_CONFLICT') return abrirCaso(c.id, { foco: false }).then(function () { setErrorAccion(mensajeDe(r)); renderDetalle(); });
      setErrorAccion(mensajeDe(r)); renderDetalle();
    });
  }

  function deshacerNS() {
    var d = S.deshacer; if (!d || d.vencido || Date.now() >= d.expira || S.busy) return;
    S.busy = 'deshacer'; renderDetalle();
    api('POST', '/claves/no-sincronizar/deshacer', { clave: d.clave, motivo: d.motivo }).then(function (r) {
      S.busy = null; limpiarDeshacer();
      if (r.ok) { S.guardado = { caso: d.caso, texto: 'Deshecho. La publicación vuelve a la cola.' }; anunciar('Deshecho.', 'estado'); return abrirCaso(d.caso, { foco: false }).then(cargarCola); }
      if (r.status === 409) { S.guardado = { caso: d.caso, texto: 'Ya se mandó a ML; mirá Ejecución' }; return renderDetalle(); }
      setErrorAccion(mensajeDe(r)); renderDetalle();
    });
  }

  // Un solo deshacer vigente a la vez. Limpia el temporizador de No sincronizar (si había).
  function setDeshacer(d) { limpiarDeshacer(); S.deshacer = d; }

  // Botón "Deshacer" (data-accion="deshacer"). Despacha según la acción que se puede deshacer.
  function deshacerAccion() {
    var d = S.deshacer; if (!d || S.busy) return;
    if (d.tipo === 'ns') return deshacerNS();
    if (d.tipo === 'vincular') return deshacerVincular(d);
    if (d.tipo === 'salteo') return deshacerSalteo(d);
    if (d.tipo === 'ninguno') return deshacerNinguno(d.caso);
  }

  // Cierre común de un deshacer/revertir. Éxito: vuelve el caso a la cola y se muestra el texto. Error: se avisa y el botón sigue.
  function finDeshacer(casoId, texto, error) {
    S.busy = null; aplicarBloqueo();
    if (error) { setErrorAccion(error); return renderDetalle(); }
    limpiarDeshacer();
    S.guardado = { caso: casoId, texto: texto };
    anunciar(texto, 'estado');
    S.focoPendiente = '#det-titulo';
    return abrirCaso(casoId, { foco: false }).then(function () { return cargarCola({ seleccionar: false }); }).then(cargarConteos);
  }

  // Deshacer un Vincular: POST /operaciones/:id/deshacer con la versión fresca del caso (la subió el propio vincular).
  function deshacerVincular(d) {
    var clave = 'deshacer-vinc:' + d.opId;
    S.busy = 'deshacer'; aplicarBloqueo(); renderDetalle();
    return versionActual(d.caso).then(function (v) {
      if (v.error) return finDeshacer(d.caso, null, v.error);
      var body = { operation_id: opIdPara(clave), expected_version: v.expected_version, evidence_fingerprint: v.evidence_fingerprint };
      return api('POST', '/operaciones/' + d.opId + '/deshacer', body).then(function (r) {
        if (r.ok) { soltarOpId(clave); return finDeshacer(d.caso, 'Vínculo deshecho. El caso vuelve a la cola.'); }
        if (r.status === 409 && r.data && r.data.code === 'OPERACION_YA_INICIADA') {
          // Ya salió hacia ML: no hay nada que deshacer. Se mira el estado real antes de ofrecer Revertir.
          return estadoOperacion(d.opId).then(function (est) {
            limpiarDeshacer(); S.busy = null; aplicarBloqueo();
            var txt = textoNoDeshacible(est);
            S.guardado = est === 'completada'
              ? { caso: d.caso, texto: MSG.OPERACION_YA_INICIADA, tono: 'atencion', revertirOp: d.opId }
              : { caso: d.caso, texto: MSG.OPERACION_YA_INICIADA + ' ' + txt, tono: 'atencion' };
            S.focoPendiente = est === 'completada' ? '[data-accion="revertir-caso"]' : '#det-titulo';
            anunciar(S.guardado.texto, 'alerta');
            return renderDetalle();
          });
        }
        return finDeshacer(d.caso, null, mensajeDe(r));
      });
    });
  }

  // Estado real de una operación (Ejecución trae accionables, completadas y canceladas). null si no aparece.
  function estadoOperacion(opId) {
    return api('GET', '/ejecucion').then(function (r) {
      if (!r.ok) return null;
      var e = r.data.data || {};
      var listas = [e.operaciones, e.completadas && e.completadas.items, e.canceladas && e.canceladas.items];
      for (var i = 0; i < listas.length; i++) {
        var hit = (listas[i] || []).find(function (x) { return x.id === opId; });
        if (hit) return hit.estado;
      }
      return null;
    });
  }
  // Texto cuando ya no se puede deshacer ni revertir desde acá, según el estado real.
  function textoNoDeshacible(est) {
    if (est === 'procesando' || est === 'verificando') return 'Se está aplicando en ML; esperá a que termine para revertir.';
    if (est === 'fallida' || est === 'intervencion') return 'Esta operación no se puede revertir desde acá.';
    if (est === 'completada') return 'Podés revertirla con Revertir.';
    return 'No pudimos ver el estado de la operación; revisalo en Ejecución.';
  }

  // Deshacer un Saltear: sin operación remota; la versión se lee fresca.
  function deshacerSalteo(d) {
    S.busy = 'deshacer'; aplicarBloqueo(); renderDetalle();
    return versionActual(d.caso).then(function (v) {
      if (v.error) return finDeshacer(d.caso, null, v.error);
      return api('POST', '/casos/' + d.caso + '/deshacer-salteo', { expected_version: v.expected_version }).then(function (r) {
        if (r.ok) return finDeshacer(d.caso, 'Salteo deshecho. El caso vuelve a la cola.');
        return finDeshacer(d.caso, null, mensajeDe(r));
      });
    });
  }

  // Deshacer "ninguno sirve" (tecla z o botón de la marca en el detalle).
  function deshacerNinguno(casoId) {
    var clave = 'deshacer-ning:' + casoId;
    if (S.busy) return;
    S.busy = 'deshacer'; aplicarBloqueo(); renderDetalle();
    return versionActual(casoId).then(function (v) {
      if (v.error) return finDeshacer(casoId, null, v.error);
      var body = { operation_id: opIdPara(clave), expected_version: v.expected_version, evidence_fingerprint: v.evidence_fingerprint };
      return api('POST', '/casos/' + casoId + '/ninguno-sirve/deshacer', body).then(function (r) {
        if (r.ok) { soltarOpId(clave); return finDeshacer(casoId, 'Ninguno sirve deshecho. El caso vuelve a la cola.'); }
        return finDeshacer(casoId, null, mensajeDe(r));
      });
    });
  }

  // Marca "Ninguno sirve" en el detalle del caso (vigente solo con la evidencia actual). Deshacer solo si puede escribir.
  function marcaNingunoHtml() {
    var n = S.detalle && S.detalle.ninguno_sirve; if (!n) return '';
    var m = MOTIVO_NINGUNO_TXT[n.motivo] || motivoTxt(n.motivo);
    return '<div class="ui-aviso ui-aviso--info cv-marca-ninguno" role="status"><span aria-hidden="true">ⓘ</span> <span><strong>Ninguno sirve (' + esc(m) + ')</strong> · reaparece si cambia la evidencia.'
      + (n.nota ? ' Nota: ' + esc(n.nota) : '') + '</span>'
      + (puedeEscribir() ? ' <button type="button" class="ui-btn" data-accion="deshacer-ninguno" data-caso="' + caso().id + '">Deshacer' + atajoTxt('z') + '</button>' : '')
      + '</div>';
  }

  // Marca "Excepción solo ML" vigente (GET /casos/:id → data.excepcion). Solo informa: no tiene acción.
  function fechaArgTxt(iso) {
    var s = String(iso || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ddmm(s) + '/' + s.slice(0, 4);
    var d = new Date(s); if (isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  }
  function marcaExcepcionHtml() {
    var x = S.detalle && S.detalle.excepcion; if (!x) return '';
    return '<div class="ui-aviso ui-aviso--info cv-marca-excepcion" role="status"><span aria-hidden="true">ⓘ</span> <span><strong>Excepción solo ML hasta ' + esc(fechaArgTxt(x.vence_en)) + '</strong>'
      + ' · motivo: ' + esc(x.motivo || '') + ' · por ' + esc(x.creada_por || '') + '</span></div>';
  }

  // Aviso de link de pago (solo admin, en el formulario de Link de pago, antes de confirmar).
  function avisoSinMarketplaceHtml() {
    return '<div class="ui-aviso ui-aviso--atencion cv-sin-mkt" role="note"><span class="cv-icono" aria-hidden="true">⚠</span>'
      + '<p><strong>Esta publicación no está en el marketplace.</strong> Su canal es Mercado Pago (link de pago): existe en la API y figura activa, '
      + 'pero no se encuentra buscando en MercadoLibre y no vende por el marketplace. Revisá si corresponde exigirle identidad de catálogo.</p></div>';
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
  // Los identificadores (a)/(b)/(c) son de la spec; en pantalla cada variante tiene su nombre.
  var VARIANTES = [
    { v: 'a', t: 'Solo marcar', l: 'Dejamos de tocarle el stock. Cualquiera lo revierte.', nombre: 'solo marcar' },
    { v: 'b', t: 'Marcar y pausar en ML', l: 'Además se pausa la publicación en ML.', nombre: 'marcar y pausar en ML' },
    { v: 'c', t: 'Marcar (solo admin revierte)', l: 'Un operador no puede revertirlo.', lock: true, nombre: 'marcar (solo admin revierte)' }
  ];

  function abrirNS(disparador) {
    var c = caso(); if (!c || !puedeEscribir() || S.busy || S.offline) return;
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
    // Al cerrar se busca el botón por selector estable: el detalle pudo re-renderizarse con el diálogo abierto.
    abrirDialogo($('#dlg-ns'), function () { return $('[data-accion="no-sincronizar"]') || disparador; }, $('#ns-variantes input'));
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
    var body = { variante: v, motivo: motivo, expected_sku: vinculoSku() };
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
        cerrarDialogo(true);
        var nombre = VARIANTES.find(function (x) { return x.v === v; }).nombre;
        var txt = v === 'b' ? 'En cola para ML · mirá Ejecución' : 'Guardado · No sincronizar: ' + nombre;
        S.guardado = { caso: c.id, texto: txt, titulo: pub.titulo };
        // Deshacer: (a) cualquier operador; (c) solo admin (la spec la trata como decisión compensatoria). (b) no tiene deshacer acá.
        if (v === 'a' || (v === 'c' && S.isAdmin)) iniciarDeshacer({ caso: c.id, clave: c.ml_key, motivo: motivo, expira: Date.now() + 10000 });
        S.focoPendiente = '#det-titulo';
        return siguienteCaso();
      }
      if (v === 'b' && r.status === 409 && r.data.code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED') {
        return mostrarAlcance(r.data.sibling_count);
      }
      S.nsOpId = null;
      if (r.data && r.data.code === 'vista_vieja') abrirCaso(c.id, { foco: false });
      estado.textContent = mensajeDe(r); estado.hidden = false;
    });
  }

  function mostrarAlcance(n) {
    var al = $('#ns-alcance');
    al.hidden = false;
    al.innerHTML = '<div class="ui-aviso ui-aviso--atencion cv-alcance"><p><span aria-hidden="true">⚠</span> La pausa es de la publicación entera. ' + (n === 1 ? 'Pausa también esta variación.' : 'Pausa también estas ' + n + ' variaciones.') + '</p>' + listaHermanas(6)
      + '<label class="cv-switch"><input type="checkbox" id="ns-conf"> <span>' + (n === 1 ? 'Entiendo, pausar la variación' : 'Entiendo, pausar las ' + n) + '</span></label>'
      + '<p id="ns-conf-razon" class="cv-acciones__razon">Marcá la confirmación para pausar ' + (n === 1 ? 'la variación' : 'las ' + n + ' variaciones') + '.</p></div>';
    var cb = $('#ns-conf');
    cb.focus();
    $('#ns-enviar').setAttribute('aria-disabled', 'true');
    $('#ns-enviar').setAttribute('aria-describedby', 'ns-conf-razon');
    S.nsConfirm = false;
  }

  // ── Excepción solo ML (H1): motivo y vencimiento obligatorios; POST /casos/:id/excepcion ──────
  function abrirExcepcion(disparador) {
    var c = caso(); if (!c || !puedeEscribir() || S.busy || S.offline) return;
    $('#exc-motivo').value = ''; $('#exc-vence').value = ''; $('#exc-vence').min = minVence();
    limpiarError($('#exc-motivo'), $('#exc-motivo-err')); limpiarError($('#exc-vence'), $('#exc-vence-err'));
    $('#exc-estado').hidden = true;
    $('#dlg-exc-titulo').textContent = 'Excepción solo ML · ' + (c.publicacion && c.publicacion.titulo || c.ml_key);
    abrirDialogo($('#dlg-exc'), disparador, $('#exc-motivo'));
  }

  // Un 409 cierra el diálogo y recarga el caso con el aviso (versión o evidencia cambiaron, o el caso ya no admite la acción).
  function recargarCaso(id, texto) {
    return abrirCaso(id, { foco: false }).then(function () { setErrorAccion(texto); renderDetalle(); });
  }

  function excepcionEnviar(ev) {
    ev.preventDefault();
    var c = caso(); if (!c || S.busy) return;
    var campoM = $('#exc-motivo'), errM = $('#exc-motivo-err'), campoV = $('#exc-vence'), errV = $('#exc-vence-err'), est = $('#exc-estado');
    limpiarError(campoM, errM); limpiarError(campoV, errV); est.hidden = true;
    var motivo = campoM.value.trim(), vence = campoV.value;
    if (!motivo) return marcarError(campoM, errM, 'Falta el motivo. Es obligatorio.');
    if (!vence) return marcarError(campoV, errV, 'Falta la fecha de vencimiento.');
    if (vence < minVence()) return marcarError(campoV, errV, 'La fecha tiene que ser posterior a hoy.');
    var clave = 'excepcion:' + c.id;
    // El backend parsea una fecha sola como medianoche UTC (21:00 del día anterior en Buenos Aires): se manda fin del día local.
    var body = cuerpoMutacion(clave, { motivo: motivo, expires_at: vence + 'T23:59:59-03:00' });
    var btn = $('#exc-enviar');
    S.busy = 'excepcion'; aplicarBloqueo(); btn.textContent = 'Guardando…';
    api('POST', '/casos/' + c.id + '/excepcion', body).then(function (r) {
      S.busy = null; aplicarBloqueo(); btn.textContent = 'Guardar excepción';
      if (r.red) { est.textContent = MSG_ERROR_SIN_RED; est.hidden = false; return; }
      if (r.ok) { soltarOpId(clave); cerrarDialogo(true); return guardadoOk(c, 'Excepción guardada hasta ' + ddmm(vence), 'excepcion'); }
      if (r.status === 409) { soltarOpId(clave); cerrarDialogo(true); return recargarCaso(c.id, mensajeDe(r)); }
      // 422 (fecha o motivo), 403 y otros: el aviso queda dentro del diálogo.
      est.textContent = mensajeDe(r); est.hidden = false;
    });
  }

  // ── Ninguno sirve (H4, tecla x): motivo enumerado y nota opcional; POST /casos/:id/ninguno-sirve ──
  function abrirNinguno(disparador) {
    var c = caso(); if (!c || !puedeEscribir() || S.busy || S.offline) return;
    $$('#ning-motivo input').forEach(function (i) { i.checked = false; });
    $('#ning-nota').value = '';
    limpiarError(null, $('#ning-motivo-err')); limpiarError($('#ning-nota'), $('#ning-nota-err'));
    $('#ning-estado').hidden = true;
    $('#dlg-ning-titulo').textContent = 'Ninguno sirve · ' + (c.publicacion && c.publicacion.titulo || c.ml_key);
    abrirDialogo($('#dlg-ning'), disparador, $('#ning-motivo input'));
  }

  function ningunoEnviar(ev) {
    ev.preventDefault();
    var c = caso(); if (!c || S.busy) return;
    var radio = $('#ning-motivo input:checked');
    var campoN = $('#ning-nota'), errN = $('#ning-nota-err'), errM = $('#ning-motivo-err'), est = $('#ning-estado');
    limpiarError(campoN, errN); est.hidden = true;
    if (!radio) { errM.textContent = 'Elegí el motivo. Es obligatorio.'; errM.hidden = false; $('#ning-motivo input').focus(); return; }
    errM.hidden = true;
    var nota = campoN.value.trim();
    if (nota.length > 500) return marcarError(campoN, errN, 'La nota no puede pasar de 500 caracteres.');
    var clave = 'ninguno:' + c.id;
    var body = cuerpoMutacion(clave, { motivo: radio.value, nota: nota });
    var btn = $('#ning-enviar');
    S.busy = 'ninguno'; aplicarBloqueo(); btn.textContent = 'Guardando…';
    api('POST', '/casos/' + c.id + '/ninguno-sirve', body).then(function (r) {
      S.busy = null; aplicarBloqueo(); btn.textContent = 'Marcar ninguno sirve';
      if (r.red) { est.textContent = MSG_ERROR_SIN_RED; est.hidden = false; return; }
      if (r.ok) {
        soltarOpId(clave); cerrarDialogo(true);
        guardadoOk(c, 'Ninguno sirve: ' + MOTIVO_NINGUNO_TXT[radio.value] + '. Sale de la cola hasta que cambie la evidencia.', 'ninguno');
        setDeshacer({ tipo: 'ninguno', caso: c.id, etiqueta: 'Deshacer' });
        return;
      }
      if (r.status === 409) { soltarOpId(clave); cerrarDialogo(true); return recargarCaso(c.id, mensajeDe(r)); }
      est.textContent = mensajeDe(r); est.hidden = false;
    });
  }

  // ── Revertir (H3): operación completada → vínculo nuevo al SKU anterior. Motivo obligatorio ──────
  // ctx 'caso' (barra tras Vincular) o 'ejec' (Ejecución). La versión se lee fresca antes de abrir.
  function abrirRevertir(opId, ctx, v, disparador) {
    S.rev = { op: opId, ctx: ctx, casoId: v.casoId, expected_version: v.expected_version, evidence_fingerprint: v.evidence_fingerprint, sib: false, veto: false };
    $('#dlg-rev-titulo').textContent = 'Revertir vínculo';
    $('#rev-motivo').value = '';
    limpiarError($('#rev-motivo'), $('#rev-motivo-err'));
    $('#rev-alcance').hidden = true; $('#rev-conf-sib').checked = false;
    $('#rev-veto').hidden = true; $('#rev-override').checked = false;
    $('#rev-estado').hidden = true;
    abrirDialogo($('#dlg-revertir'), disparador, $('#rev-motivo'));
  }

  function abrirRevertirCaso(opId, casoId, disparador) {
    if (!puedeEscribir() || S.busy) return;
    return versionActual(casoId).then(function (v) {
      if (v.error) { setErrorAccion(v.error); return renderDetalle(); }
      abrirRevertir(opId, 'caso', { casoId: casoId, expected_version: v.expected_version, evidence_fingerprint: v.evidence_fingerprint }, disparador);
    });
  }

  function abrirRevertirEjec(opId, disparador) {
    if (!puedeEscribir() || S.busy) return;
    var op = opEjec(opId); if (!op) return;
    return versionActual(op.caso_id).then(function (v) {
      if (v.error) { S.ejecMsgs[opId] = { error: v.error }; return renderEjecucion(); }
      abrirRevertir(opId, 'ejec', { casoId: op.caso_id, expected_version: v.expected_version, evidence_fingerprint: v.evidence_fingerprint }, disparador);
    });
  }

  function recargarRevertir(R, texto) {
    if (R.ctx === 'caso') return recargarCaso(R.casoId, texto);
    S.ejecMsgs[R.op] = { error: texto };
    anunciar(texto, 'alerta');
    S.focoPendiente = '.cv-ejec-fila[data-op="' + R.op + '"]';
    return cargarEjecucion();
  }

  function revertirEnviar(ev) {
    ev.preventDefault();
    var R = S.rev; if (!R || S.busy) return;
    var campo = $('#rev-motivo'), err = $('#rev-motivo-err'), est = $('#rev-estado');
    limpiarError(campo, err); est.hidden = true;
    var motivo = campo.value.trim();
    if (!motivo) return marcarError(campo, err, 'Falta el motivo. Es obligatorio.');
    var clave = 'revertir:' + R.op;
    var body = { operation_id: opIdPara(clave), expected_version: R.expected_version, evidence_fingerprint: R.evidence_fingerprint, motivo: motivo };
    if (R.sib && $('#rev-conf-sib').checked) body.confirm_sibling_impact = true;
    // La confirmación de contradicción es solo admin: el operador nunca manda override (el backend lo rechazaría con 403).
    if (R.veto && S.isAdmin && $('#rev-override').checked) body.override_contradiccion = true;
    var btn = $('#rev-enviar');
    S.busy = 'revertir'; aplicarBloqueo(); btn.textContent = 'Enviando…';
    api('POST', '/operaciones/' + R.op + '/revertir', body).then(function (r) {
      S.busy = null; aplicarBloqueo(); btn.textContent = 'Revertir';
      if (r.red) { est.textContent = MSG_ERROR_SIN_RED; est.hidden = false; return; }
      if (r.ok) {
        soltarOpId(clave); S.rev = null; cerrarDialogo(true);
        var txt = 'Revertido: se encoló un vínculo al SKU anterior. Mirá Ejecución.';
        anunciar(txt, 'estado');
        if (R.ctx === 'caso') {
          limpiarDeshacer(); S.guardado = { caso: R.casoId, texto: txt }; S.focoPendiente = '#det-titulo';
          return abrirCaso(R.casoId, { foco: false }).then(cargarConteos);
        }
        S.ejecMsgs[R.op] = { texto: 'Revertida. En cola para ML · se actualiza solo.' };
        S.focoPendiente = '.cv-ejec-fila[data-op="' + R.op + '"]';
        return cargarEjecucion();
      }
      var code = r.data && r.data.code;
      if (r.status === 409 && code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED') {
        R.sib = true;
        var n = r.data.sibling_count;
        $('#rev-alcance-txt').textContent = 'Esto cambia también ' + cuenta(n, 'publicación hermana', 'publicaciones hermanas') + '. ¿Seguimos?';
        $('#rev-alcance').hidden = false;
        est.textContent = 'Falta confirmar el impacto en las hermanas.'; est.hidden = false;
        $('#rev-conf-sib').focus();
        return;
      }
      if (r.status === 409 && code === 'contradiccion_titulo') {
        R.veto = true;
        est.textContent = mensajeDe(r); est.hidden = false;
        if (S.isAdmin) { $('#rev-veto').hidden = false; $('#rev-override').focus(); }
        return;
      }
      if (r.status === 409 && ['VERSION_CONFLICT', 'EVIDENCE_CONFLICT', 'INVALID_STATE', 'OPERACION_DUPLICADA'].indexOf(code) !== -1) {
        soltarOpId(clave); S.rev = null; cerrarDialogo(true);
        return recargarRevertir(R, mensajeDe(r));
      }
      est.textContent = mensajeDe(r); est.hidden = false;
    });
  }

  // ── Diálogos (foco atrapado, Esc, foco vuelve al disparador) ──────────────────────────────────
  // El disparador puede ser un nodo o una función que lo busca al cerrar (el nodo viejo puede haber sido re-renderizado).
  function resolverDisparador(x) { return typeof x === 'function' ? x() : x; }
  function abrirDialogo(el, disparador, enfocar) {
    S.dlgDisparador = disparador || null;
    S.dlgActivo = el;
    el.hidden = false;
    setTimeout(function () { (enfocar || focusables(el)[0] || el).focus(); }, 0);
  }
  function cerrarDialogo(exito) {
    if (!S.dlgActivo) return;
    S.dlgActivo.hidden = true;
    var d = resolverDisparador(S.dlgDisparador);
    S.dlgActivo = null; S.dlgDisparador = null;
    if (exito) return; // tras un éxito el foco lo toma el siguiente caso (S.focoPendiente)
    if (d && document.contains(d)) d.focus();
    else { var f = $('#cv-cola [aria-selected="true"]') || $('#cv-detalle'); if (f) f.focus(); }
  }

  // Confirmación propia (reemplaza el confirm nativo). Un solo diálogo genérico: #dlg-confirmar.
  // o: { titulo, texto, ok, volver, peligro, disparador, onOk, onCancel }. Foco inicial en Volver; Esc cancela.
  // Si había otro diálogo abierto (p. ej. No sincronizar), se guarda y se restaura al cerrar.
  function pedirConfirmacion(o) {
    if (S.confOnOk) return; // ya hay una confirmación abierta
    var dlg = $('#dlg-confirmar');
    S.confPrev = S.dlgActivo ? { el: S.dlgActivo, disp: S.dlgDisparador, foco: document.activeElement } : null;
    S.confOnOk = o.onOk || function () {}; S.confOnCancel = o.onCancel || null;
    S.confDisp = o.disparador || document.activeElement;
    $('#dlg-conf-titulo').textContent = o.titulo || 'Confirmar';
    $('#dlg-conf-texto').textContent = o.texto || '';
    $('#dlg-conf-ok').textContent = o.ok || 'Confirmar';
    $('#dlg-conf-ok').className = 'ui-btn ' + (o.peligro ? 'ui-btn--peligro' : 'ui-btn--primario');
    $('#dlg-conf-ok').setAttribute('aria-disabled', 'false');
    abrirDialogo(dlg, resolverDisparador(S.confDisp), $('#dlg-conf-volver'));
  }
  // ok=true ejecuta onOk; ok=false ejecuta onCancel. Antes de ejecutar, el foco vuelve al disparador (o al diálogo previo).
  function cerrarConfirmacion(ok) {
    if (!S.confOnOk) return;
    var cb = ok ? S.confOnOk : S.confOnCancel; var prev = S.confPrev; var disp = resolverDisparador(S.confDisp);
    S.confOnOk = null; S.confOnCancel = null; S.confPrev = null; S.confDisp = null;
    $('#dlg-confirmar').hidden = true;
    S.dlgActivo = null; S.dlgDisparador = null;
    if (prev) { S.dlgActivo = prev.el; S.dlgDisparador = prev.disp; if (prev.foco && document.contains(prev.foco)) prev.foco.focus(); }
    else if (disp && document.contains(disp)) disp.focus();
    else { var f = $('#cv-cola [aria-selected="true"]') || $('#cv-detalle'); if (f) f.focus(); }
    if (cb) cb();
  }

  // Versión grande de la foto ML (-I → -O en mlstatic https); helper en foto-ml.js. Sin helper, usa la URL tal cual.
  var fotoMlGrande = (window.CvFotoMl && window.CvFotoMl.fotoMlGrande) || function (u) { return u; };
  // Tecla f: fotos del candidato (ML y Woo) en un diálogo. Foto Woo = candidato del disparador o el elegido;
  // foto ML = caso.publicacion.thumbnail (GET /casos/:id, ya saneada en el backend).
  function abrirFotos(t) {
    var cand = null, disp = null;
    if (t && t.dataset && t.dataset.accion === 'elegir' && t.dataset.idx != null) {
      cand = (S.candidatos || [])[Number(t.dataset.idx)] || null; disp = t;
    } else if (S.elegido) {
      cand = S.elegido; disp = $('[data-accion="elegir"][aria-pressed="true"]');
    }
    if (!disp && t && t !== document.body) disp = t;
    var pub = (caso() && caso().publicacion) || {};
    var fotos = [];
    if (pub.thumbnail) fotos.push({ src: fotoMlGrande(pub.thumbnail), mini: pub.thumbnail, alt: 'Publicación ML', leyenda: 'Publicación ML' });
    if (cand && cand.img) fotos.push({ src: cand.img, mini: '', alt: 'Producto Woo: ' + (cand.nombre_canonico || cand.nombre_woo || 'producto'), leyenda: 'Producto Woo' });
    var cuerpo = $('#dlg-foto-cuerpo');
    cuerpo.innerHTML = fotos.length
      ? '<div class="cv-fotos">' + fotos.map(function (f) {
          return '<figure class="cv-foto"><img class="cv-foto__img" src="' + esc(f.src) + '"' + (f.mini && f.mini !== f.src ? ' data-mini="' + esc(f.mini) + '"' : '') + ' alt="' + esc(f.alt) + '" loading="lazy"><figcaption>' + esc(f.leyenda) + '</figcaption></figure>';
        }).join('') + '</div>'
      : '<p class="ui-resumen">Sin foto</p>';
    // Si la versión grande de ML falla, cae a la miniatura original (una sola vez, sin bucle).
    Array.prototype.forEach.call(cuerpo.querySelectorAll('img[data-mini]'), function (img) {
      img.addEventListener('error', function () {
        if (img.dataset.mini && img.getAttribute('src') !== img.dataset.mini) img.src = img.dataset.mini;
      });
    });
    abrirDialogo($('#dlg-foto'), disp, $('#dlg-foto-cerrar'));
  }

  // Esc o clic afuera: si hay un motivo escrito en No sincronizar, pide confirmación antes de descartarlo.
  function intentarCerrarDialogo() {
    if (S.dlgActivo === $('#dlg-confirmar')) { cerrarConfirmacion(false); return; }
    if (S.dlgActivo === $('#dlg-ns') && $('#ns-motivo').value.trim() && S.nsEnviando === false) {
      pedirConfirmacion({ titulo: 'Descartar el motivo', texto: 'Tenés un motivo escrito. ¿Descartarlo y cerrar?', ok: 'Descartar y cerrar', peligro: true,
        disparador: $('#ns-volver'), onOk: function () { cerrarDialogo(); } });
      return;
    }
    cerrarDialogo();
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
      if (ev.key === 'Escape') { ev.preventDefault(); intentarCerrarDialogo(); }
      else if (ev.key === 'f' && S.dlgActivo === $('#dlg-foto') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); cerrarDialogo(); }
      else if (ev.key === 'Tab') atraparTab(ev);
      return;
    }
    var hist = $('#det-hist');
    if (ev.key === 'Escape' && hist && hist.open) { ev.preventDefault(); hist.open = false; S.histOpen = false; hist.querySelector('summary').focus(); return; }
    if (ev.key === 'Escape' && S.hermanas) { ev.preventDefault(); S.hermanas = null; renderDetalle(); enfocarPorSelector('[data-accion="vincular"]'); return; }
    if (ev.key === 'Escape' && S.retAbierta) {
      ev.preventDefault();
      var ordAb = S.retAbierta; S.retAbierta = null; renderRetenidas();
      enfocarPorSelector('[data-accion="liberar-abrir"][data-orden="' + ordAb + '"]');
      return;
    }
    if (ev.key === 'Escape' && S.conflictoVersion) {
      ev.preventDefault(); S.conflictoVersion = null; renderDetalle();
      setTimeout(function () { (($('[data-accion="vincular"]')) || $('#det-titulo') || document.body).focus(); }, 0);
      return;
    }
    if (ev.key === 'Escape' && S.adminForm) {
      ev.preventDefault();
      S.adminForm = null; renderDetalle(); enfocarDisparador();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || !atajosActivos()) return;
    var t = ev.target;
    if (esCampo(t)) return;
    var enCaso = S.tab === 'casos' && S.detalle;
    var interactivo = t && (t.tagName === 'BUTTON' || t.tagName === 'A');
    switch (ev.key) {
      case '1': case '2': case '3':
        if (enCaso && S.candidatos && S.candidatos[Number(ev.key) - 1] && !soloLecturaActual()) { ev.preventDefault(); elegirCandidato(Number(ev.key) - 1, true); }
        break;
      case 'Enter':
        if (!interactivo && enCaso && !soloLecturaActual()) { ev.preventDefault(); vincular(); }
        break;
      case 's': if (enCaso && !soloLecturaActual()) { ev.preventDefault(); saltear(); } break;
      case 'n': if (enCaso && !soloLecturaActual()) { ev.preventDefault(); abrirNS($('[data-accion="no-sincronizar"]')); } break;
      case 'x': if (enCaso && !soloLecturaActual()) { ev.preventDefault(); abrirNinguno($('[data-accion="ninguno"]')); } break;
      // z actúa solo si hay un botón Deshacer visible y habilitado (la barra o la marca "Ninguno sirve").
      case 'z': {
        var bz = $('#cv-detalle [data-accion="deshacer"]:not([aria-disabled="true"]), #cv-detalle [data-accion="deshacer-ninguno"]:not([aria-disabled="true"])');
        if (bz) { ev.preventDefault(); bz.click(); }
        break;
      }
      case 'd': if (enCaso) { ev.preventDefault(); S.soloDif = !S.soloDif; renderDetalle(); } break;
      case 'f': if (enCaso) { ev.preventDefault(); abrirFotos(t); } break;
      case '/': ev.preventDefault(); if (S.tab === 'casos' && enCaso) { $('#det-q') && $('#det-q').focus(); } else { activarTab('vinculos'); $('#vinc-q').focus(); } break;
      case 'h': if (enCaso) { ev.preventDefault(); var hd = $('#det-hist'); if (hd) { hd.open = !hd.open; S.histOpen = hd.open; hd.querySelector('summary').focus(); } } break;
      case '?': ev.preventDefault(); abrirDialogo($('#dlg-atajos'), $('#cv-btn-ayuda'), $('#dlg-atajos-on')); break;
      default: break;
    }
  }
  // Si el foco ya está dentro del detalle, renderDetalle lo restaura solo; si no (p. ej. body), se pide foco explícito.
  function soloLecturaActual() {
    return soloLecturaDetalle();
  }

  // ── Ejecución ──────────────────────────────────────────────────────────────────────────────────
  function chipEstado(estado, o) {
    var k = o ? estOp(o) : (ESTADO_OP[estado] || estado);
    var m = {
      cancelada: ['cv-chip-estado cv-chip-estado--cancelada', '—', cancelacionTxt(o)],
      encolada: ['cv-chip-estado', '↻', 'En cola para ML'],
      aplicada: ['cv-chip-estado cv-chip-estado--aplicada', '✓', 'Aplicada en ML'],
      fallida: ['cv-chip-estado cv-chip-estado--fallida', '✗', errMlTxt(o.ultimo_error) + '. ' + reintentaTxt()],
      frenada: ['cv-chip-estado cv-chip-estado--frenada', '⏸', 'Frenada: ' + sinNombres(motivoRegla(o.ultimo_error) || 'regla de protección') + '. Stock en 0 hasta resolver.'],
      espera: ['cv-chip-estado cv-chip-estado--espera', '⏳', 'Espera tu confirmación']
    }[k];
    if (!m) return '<span class="cv-chip-estado">' + esc(estado) + '</span>';
    return '<span class="' + m[0] + '"><span aria-hidden="true">' + m[1] + '</span> ' + esc(m[2]) + '</span>';
  }

  // Query de /ejecucion: filtro de texto y offsets. Sin filtro no se manda q.
  var LIMITE_MAX_EJEC = 200; // tope del backend para limite
  function ejecQs(limite, offs) {
    var p = [];
    if (S.ejecQ) p.push('q=' + encodeURIComponent(S.ejecQ));
    p.push('limite=' + limite);
    p.push('completadas_offset=' + ((offs && offs.completadas) || 0));
    p.push('canceladas_offset=' + ((offs && offs.canceladas) || 0));
    return p.join('&');
  }
  // reiniciar: vuelve a la primera página (50) — usado al cambiar el filtro.
  // Sin reiniciar (polling, cambio de tab), se piden de nuevo todas las ya cargadas para no perder "Ver más".
  function cargarEjecucion(opts) {
    var cab = $('#ejec-cabecera');
    var reiniciar = !!(opts && opts.reiniciar);
    var cargadas = S.ejec && esNuevo(S.ejec) ? Math.max(S.ejec.completadas.items.length, S.ejec.canceladas.items.length) : 0;
    var limite = reiniciar ? 50 : Math.min(LIMITE_MAX_EJEC, Math.max(50, cargadas));
    var sinQ = !S.ejecQ;
    var previo = S.ejec;
    cab.setAttribute('aria-busy', 'true');
    return api('GET', '/ejecucion?' + ejecQs(limite)).then(function (r) {
      cab.setAttribute('aria-busy', 'false');
      if (!r.ok) { cab.innerHTML = cajaError(mensajeDe(r), 'cargarEjecucion'); $('#ejec-cuerpo').innerHTML = ''; return; }
      var e = r.data.data;
      // Histórico terminal (completadas/canceladas no vuelven a accionables): lo cargado más allá de la ventana de 200 se conserva.
      if (!reiniciar && previo && esNuevo(previo) && esNuevo(e)) {
        ['completadas', 'canceladas'].forEach(function (sec) {
          var ids = {};
          e[sec].items.forEach(function (o) { ids[o.id] = true; });
          previo[sec].items.forEach(function (o) { if (!ids[o.id]) e[sec].items.push(o); });
        });
      }
      if (sinQ) S.ejecSnap = e;
      S.ejec = e;
      S.ejecMasError = null;
      var anteriores = S.ejecEstados;
      var nuevos = {};
      var cambios = [];
      (e.operaciones || []).forEach(function (o) {
        var k = 'op' + o.id; var est = estOp(o);
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

  // Una fila de operación (Ejecución). Sirve para accionables, completadas y canceladas.
  function filaEjecHtml(o) {
    var est = estOp(o);
    var fallida = est === 'fallida';
    var cancelada = est === 'cancelada';
    var acciones = '';
    var enviandoEsta = S.busyOp === o.id;
    var dis = 'aria-disabled="' + !!S.busy + '"';
    if (S.isAdmin && puedeEscribir() && fallida) acciones += '<button type="button" class="ui-btn" data-accion="reintentar" data-op="' + o.id + '" ' + dis + '>'
      + (enviandoEsta && S.busy === 'reintentar' ? 'Enviando…' : 'Reintentar') + '</button> ';
    if (S.isAdmin && puedeEscribir() && o.estado === 'bloqueada_impacto') acciones += '<button type="button" class="ui-btn" data-accion="confirmar-impacto" data-op="' + o.id + '" ' + dis + '>'
      + (enviandoEsta && S.busy === 'confirmar-impacto' ? 'Enviando…' : 'Confirmar impacto') + '</button>';
    // Revertir: solo sobre completadas. /ejecucion no trae quién decidió la operación, así que por ahora solo el admin lo ve.
    if (S.isAdmin && puedeEscribir() && o.estado === 'completada' && !esCancelada(o)) acciones += '<button type="button" class="ui-btn" data-accion="revertir-abrir" data-op="' + o.id + '" ' + dis + '>Revertir</button> ';
    var msg = S.ejecMsgs[o.id];
    var msgHtml = msg ? '<p class="ui-resumen cv-ejec-msg' + (msg.error ? ' cv-ejec-msg--error' : '') + '" role="' + (msg.error ? 'alert' : 'status') + '">'
      + (msg.error ? '✗ ' : '') + esc(msg.error || msg.texto) + '</p>' : '';
    return '<article tabindex="-1" class="cv-ejec-fila' + (fallida ? ' cv-ejec-fila--fallida' : '') + (cancelada ? ' cv-ejec-fila--cancelada' : '') + '" data-op="' + o.id + '">'
      + '<div class="cv-ejec-fila__info">'
      + '<div class="cv-ejec-fila__cab"><strong class="cv-ejec-fila__titulo">' + esc(o.nombre_canonico || o.ml_key) + '</strong>' + chipEstado(o.estado, o) + '</div>'
      + '<p class="ui-resumen cv-ejec-fila__meta"><span class="ui-id">' + esc(o.sku_objetivo || '') + '</span> · ' + esc(fecha(o.actualizada_en || o.iniciada_en)) + '</p>'
      + (fallida && !S.isAdmin ? '<p class="ui-resumen">' + reintentaTxt() + '</p>' : '')
      + msgHtml
      + '</div>'
      + (acciones ? '<div class="cv-ejec-acciones">' + acciones + '</div>' : '')
      + '</article>';
  }

  // Sección colapsada (Completadas / Canceladas) con contador, filas acumuladas y "Ver más" de a 50.
  function seccionEjecHtml(sec, titulo) {
    var s = S.ejec[sec] || { items: [], total: 0 };
    var items = s.items || [];
    var total = s.total || 0;
    var pie = '';
    if (!items.length) pie = '<p class="ui-resumen">' + (S.ejecQ ? 'Ninguna coincide con «' + esc(S.ejecQ) + '».' : 'Todavía no hay operaciones ' + sec + '.') + '</p>';
    if (S.ejecMasError && S.ejecMasError.sec === sec) pie += '<p class="ui-resumen cv-ejec-msg cv-ejec-msg--error" role="alert">✗ ' + esc(S.ejecMasError.msg) + '</p>';
    if (items.length < total) {
      var cargando = S.ejecMasBusy === sec;
      pie += '<p class="cv-ejec-mas"><button type="button" class="ui-btn" data-accion="ejec-ver-mas" data-seccion="' + sec + '" aria-disabled="' + cargando + '">'
        + (cargando ? 'Cargando…' : 'Ver más (' + (total - items.length) + ' restantes)') + '</button> <span class="ui-resumen">Mostrando ' + items.length + ' de ' + total + '</span></p>';
    }
    var abierta = !!S.ejecAbiertas[sec];
    return '<details class="cv-ejec-seccion ui-card" data-seccion="' + sec + '"' + (abierta ? ' open' : '') + '>'
      + '<summary class="cv-ejec-seccion__sum" aria-expanded="' + abierta + '">' + titulo + ' · ' + total + '</summary>'
      + '<div class="cv-ejec-seccion__cuerpo">' + items.map(filaEjecHtml).join('') + pie + '</div></details>';
  }

  // Pausas en ML visibles: toda pausa no terminal (pendiente, procesando, fallida…) es accionable, no solo las de impacto.
  var PAUSA_TERMINAL = { completada: 1, aplicada: 1, cancelada: 1 };
  function pausasVisibles(e) {
    return (e.pausas || []).filter(function (p) { return !esCancelada(p) && !PAUSA_TERMINAL[p.estado]; });
  }
  // Variaciones de una pausa: título si viene, si no la clave. Pasa de 5, se pliega con "y N más".
  function pausaVariacionesHtml(vars) {
    var li = function (v) {
      return '<li><span class="ui-id">' + esc(v.clave || '') + '</span> ' + esc(v.titulo || '') + (v.status ? ' <span class="ui-label">' + esc(estadoMlTxt(v.status)) + '</span>' : '') + '</li>';
    };
    var vis = vars.slice(0, 5); var resto = vars.slice(5);
    return '<ul class="cv-lista-hermanas">' + vis.map(li).join('') + '</ul>'
      + (resto.length ? '<details class="ui-mas"><summary>y ' + resto.length + ' más</summary><ul class="cv-lista-hermanas">' + resto.map(li).join('') + '</ul></details>' : '');
  }
  function pausaEstadoTxt(p) { return p.estado === 'fallida' ? 'Pausa en ML fallida' : 'Pausa en ML pendiente'; }

  function renderEjecucion() {
    var e = S.ejec; if (!e) return;
    var nuevo = esNuevo(e);
    var fall = fallidasReales(e);
    var ops = e.operaciones || [];
    var pausas = pausasVisibles(e);
    var frenadas = ops.filter(function (o) { return estOp(o) === 'frenada'; }).length;
    var encoladas = ops.filter(function (o) { return estOp(o) === 'encolada'; }).length
      + pausas.filter(function (p) { return p.estado !== 'fallida'; }).length;
    $('#ejec-cabecera').innerHTML = '<div class="cv-cabecera-ejec">'
      + (fall > 0 ? '<span class="cv-contador cv-contador--critico"><span aria-hidden="true">✗</span> ' + cuenta(fall, 'fallida', 'fallidas') + '</span>' : '')
      + '<span class="ui-resumen"><span class="cv-frenadas">⏸ ' + cuenta(frenadas, 'frenada', 'frenadas') + '</span> · ↻ ' + encoladas + ' en cola'
      + (canceladasN(e) > 0 ? ' · <span class="cv-canceladas">' + canceladasN(e) + ' cancelada' + (canceladasN(e) === 1 ? '' : 's') + '</span>' : '') + '</span></div>'
      + saludHtml();
    var conRiesgo = pausas.filter(function (p) { return p.impacto_hermanas > 0; }).length;
    var bloquePausas = pausas.length
      ? '<section class="ui-aviso ui-aviso--' + (conRiesgo ? 'atencion' : 'info') + ' cv-bloque" aria-labelledby="pausas-h"><h3 id="pausas-h" class="cv-h2">'
        + (conRiesgo ? '<span aria-hidden="true">⚠</span> ' : '') + 'Pausas en ML</h3>'
        + pausas.map(function (p) {
          var clave = String(p.ml_key || '').replace(/\|.*$/, '');
          var titulo = p.titulo || p.nombre_canonico || '';
          var vars = Array.isArray(p.variaciones) ? p.variaciones : [];
          return '<p class="ui-resumen">' + (titulo ? '<strong>' + esc(titulo) + '</strong> · <span class="ui-id">' + esc(clave) + '</span>' : esc(clave))
            + ' · ' + esc(pausaEstadoTxt(p)) + ' · ' + esc(motivoTxt(p.motivo))
            + (p.impacto_hermanas > 0 ? ' · afecta ' + cuenta(p.impacto_hermanas, 'variación', 'variaciones') : '') + '</p>'
            + (vars.length ? pausaVariacionesHtml(vars) : '');
        }).join('') + '</section>'
      : '';
    var filas = ops.map(filaEjecHtml).join('');
    var vacio = S.ejecQ
      ? '<p class="ui-resumen">Sin pendientes que coincidan con «' + esc(S.ejecQ) + '».</p>'
      : '<p class="ui-resumen cv-ejec-vacio"><span aria-hidden="true">✓</span> Nada pendiente</p>';
    var secciones = nuevo ? seccionEjecHtml('completadas', 'Completadas') + seccionEjecHtml('canceladas', 'Canceladas') : '';
    $('#ejec-cuerpo').innerHTML = bloquePausas + (filas || (pausas.length ? '' : vacio)) + secciones;
    if (S.focoPendiente) {
      // Botón de la fila si sigue, si no la fila, si no el encabezado de Ejecución.
      var fp = S.focoPendiente; S.focoPendiente = null;
      var fe = $(fp + ' [data-accion="reintentar"]') || $(fp) || $('#ejec-cabecera');
      if (fe) { if (!fe.hasAttribute('tabindex') && fe.id === 'ejec-cabecera') fe.setAttribute('tabindex', '-1'); fe.focus(); }
    }
  }

  // "Ver más": pide la siguiente página (50) de la sección y acumula sin repetir filas.
  function verMasEjec(sec) {
    var e = S.ejec;
    if (!esNuevo(e) || S.ejecMasBusy) return;
    var offs = {}; offs[sec] = e[sec].items.length;
    var qAntes = S.ejecQ;
    S.ejecMasBusy = sec; S.ejecMasError = null; renderEjecucion();
    return api('GET', '/ejecucion?' + ejecQs(50, offs)).then(function (r) {
      if (qAntes !== S.ejecQ) { S.ejecMasBusy = null; return; }
      S.ejecMasBusy = null;
      if (!r.ok) {
        S.ejecMasError = { sec: sec, msg: r.red ? MSG_ERROR_SIN_RED : mensajeDe(r) };
        anunciar(S.ejecMasError.msg, 'alerta'); renderEjecucion(); return;
      }
      var nd = r.data.data;
      if (esNuevo(nd) && S.ejec && esNuevo(S.ejec)) {
        var vistos = {};
        S.ejec[sec].items.forEach(function (o) { vistos[o.id] = true; });
        nd[sec].items.forEach(function (o) { if (!vistos[o.id]) S.ejec[sec].items.push(o); });
        S.ejec[sec].total = nd[sec].total;
      }
      renderEjecucion();
      var btn = document.querySelector('.cv-ejec-seccion[data-seccion="' + sec + '"] [data-accion="ejec-ver-mas"]');
      var foco = btn || document.querySelector('.cv-ejec-seccion[data-seccion="' + sec + '"] > summary');
      if (foco) foco.focus();
    });
  }

  // Pestaña: "Ejecución" sin fallidas; con fallidas, "Ejecución · ✗ N".
  function actualizarContadoresTab() {
    var e = S.ejec; if (!e) return;
    var n = fallidasReales(e);
    $('#cnt-ejecucion').innerHTML = n > 0
      ? '<span class="cv-contador--critico" aria-hidden="true">· ✗ ' + n + '</span><span class="sr-only"> (' + cuenta(n, 'fallida', 'fallidas') + ')</span>'
      : '';
  }

  // Estado de la pantalla Ejecución: salud de lectura y conciliación (lo que muestran las pastillas de Casos).
  function saludHtml() {
    var e = S.estadoRaw || {};
    var salud = e.salud || {};
    var conc = e.conciliacion || {};
    var txtSalud = salud.sano ? 'Sana' : (salud.degradado ? 'Degradada' : 'Con observación');
    var txtConc = conc.exacta ? 'Exacta' : 'Sin conciliar';
    if (!S.estadoRaw) return '<p class="ui-resumen">Salud y conciliación: sin dato todavía.</p>';
    return '<section class="ui-panel cv-salud-bloque" aria-label="Salud de la identidad"><h2 class="cv-h2">Salud y conciliación</h2>'
      + '<p>Salud de lectura: <strong>' + esc(txtSalud) + '</strong></p>'
      + '<p>Conciliación: <strong>' + esc(txtConc) + '</strong></p></section>';
  }

  // Confirmar impacto (admin): la pausa de hermanas se confirma en un diálogo antes de encolarse.
  // La lista sale de /ejecucion (operaciones[].variaciones); si falta, cae a hermanas_item del caso abierto.
  // Sin lista no se puede confirmar: el botón queda aria-disabled y se ofrece Reintentar (recarga /ejecucion).
  function listaImpacto(o) {
    if (Array.isArray(o.variaciones) && o.variaciones.length) return o.variaciones;
    return (S.detalle && S.detalle.caso && S.detalle.caso.id === o.caso_id && S.detalle.hermanas_item) || [];
  }
  function pintarImpacto(id) {
    var o = ((S.ejec && S.ejec.operaciones) || []).find(function (x) { return x.id === id; });
    if (!o) return;
    var n = Number(o.impacto_hermanas) || 0;
    var lista = listaImpacto(o);
    var sinLista = n > 0 && !lista.length;
    var MAX_IMP = 10;
    var cuerpo = '<p>Esto pausa ' + cuenta(n, 'variación', 'variaciones') + ' en ML' + (lista.length ? ':' : '.') + '</p>'
      + (lista.length ? '<ul class="cv-impacto-lista">' + lista.slice(0, MAX_IMP).map(function (h) {
          return '<li><span class="ui-id">' + esc(h.clave) + '</span> ' + esc(h.titulo || '')
            + (h.status ? ' <span class="ui-label">' + esc(estadoMlTxt(h.status)) + '</span>' : '') + '</li>';
        }).join('') + (lista.length > MAX_IMP ? '<li class="ui-resumen">y ' + (lista.length - MAX_IMP) + ' más</li>' : '') + '</ul>' : '')
      + (sinLista ? '<div class="api-estado api-estado--error" role="alert"><p>No pudimos obtener la lista de variaciones.</p>'
        + '<button type="button" class="btn-reintentar cv-btn-44" data-accion="dlg-imp-reintentar" data-op="' + id + '">Reintentar</button></div>' : '')
      + '<p class="ui-resumen">La pausa va como operación en la cola de Identidad. Su resultado aparece en Ejecución.</p>';
    $('#dlg-imp-cuerpo').innerHTML = cuerpo;
    var ok = $('#dlg-imp-ok');
    ok.textContent = n === 1 ? 'Pausar la variación' : 'Pausar las ' + n;
    ok.setAttribute('data-op', String(id));
    ok.setAttribute('aria-disabled', String(sinLista));
  }
  function abrirConfirmarImpacto(id) {
    var o = ((S.ejec && S.ejec.operaciones) || []).find(function (x) { return x.id === id; });
    if (!o) return;
    pintarImpacto(id);
    abrirDialogo($('#dlg-impacto'), $('[data-accion="confirmar-impacto"][data-op="' + id + '"]'), $('#dlg-imp-volver'));
  }
  // Reintentar dentro del diálogo: recarga /ejecucion y vuelve a pintar la lista si el diálogo sigue abierto.
  function reintentarListaImpacto(id) {
    var cab = $('#dlg-imp-cuerpo');
    cab.setAttribute('aria-busy', 'true');
    cargarEjecucion().then(function () {
      cab.setAttribute('aria-busy', 'false');
      if (!$('#dlg-impacto').hidden) pintarImpacto(id);
    });
  }

  // Validadores del backend: expected_version y evidence_fingerprint del caso (vienen en cada operación de /ejecucion).
  // Operación por id en Ejecución: accionables, o las de las secciones Completadas / Canceladas (paginadas).
  function opEjec(id) {
    var e = S.ejec || {};
    var listas = [e.operaciones, e.completadas && e.completadas.items, e.canceladas && e.canceladas.items,
      (S.ejecSnap && S.ejecSnap.operaciones)];
    for (var i = 0; i < listas.length; i++) {
      var hit = (listas[i] || []).find(function (x) { return x.id === id; });
      if (hit) return hit;
    }
    return null;
  }
  function camposVersion(op) {
    return op ? { expected_version: op.caso_expected_version, evidence_fingerprint: op.evidencia_fingerprint } : {};
  }
  function reintentarOp(id, accion) {
    var clave = accion + ':' + id;
    if (S.busy || !puedeEscribir()) return;
    var op = opEjec(id);
    var body = Object.assign({ operation_id: opIdPara(clave) }, camposVersion(op));
    S.busy = accion; S.busyOp = id; S.ejecMsgs[id] = { texto: 'Enviando…' };
    renderEjecucion();
    api('POST', '/operaciones/' + id + '/' + (accion === 'reintentar' ? 'reintentar' : 'confirmar-impacto'), body).then(function (r) {
      S.busy = null; S.busyOp = null;
      S.focoPendiente = '.cv-ejec-fila[data-op="' + id + '"]';
      if (r.ok || (!r.red && r.status !== 409 && r.status !== 0)) soltarOpId(clave);
      if (r.red) { S.ejecMsgs[id] = { error: MSG_ERROR_SIN_RED }; anunciar(MSG_ERROR_SIN_RED, 'alerta'); return renderEjecucion(); }
      if (r.status === 409) {
        // Caso o evidencia cambiaron: se recarga Ejecución y se avisa claro.
        var aviso = mensajeDe(r) + ' Se recargó Ejecución: revisá la operación y volvé a intentar.';
        S.ejecMsgs[id] = { error: aviso }; anunciar(aviso, 'alerta');
        return cargarEjecucion();
      }
      if (!r.ok) { S.ejecMsgs[id] = { error: mensajeDe(r) }; anunciar(mensajeDe(r), 'alerta'); return renderEjecucion(); }
      S.ejecMsgs[id] = { texto: 'Enviado · En cola para ML. Se actualiza solo.' };
      anunciar('Enviado. Mirá el estado en Ejecución.', 'estado');
      cargarEjecucion();
    });
  }

  // ── Retenidas ─────────────────────────────────────────────────────────────────────────────────
  // Motivo en lenguaje humano (sin snake_case): "sin_cobertura_woo" -> "Sin cobertura woo".
  // Solo el motivo: la clave de la publicación ya se muestra en la línea "Publicación ...".
  function causaDe(f) {
    return f.motivo ? motivoTxt(f.motivo) : 'Sin cobertura';
  }

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
    var cabecera = '<div class="ui-aviso ui-aviso--info" role="note">Se liberan solas cada 5 minutos cuando la causa se resuelve. Las de publicaciones marcadas como no sincronizar se liberan solo a mano.</div>';
    if (!lista.length) { cont.innerHTML = cabecera + '<div class="api-estado api-estado--vacio" role="status"><p>No hay ventas retenidas.</p></div>'; return; }
    cont.innerHTML = cabecera + lista.map(function (f) {
      var abierta = S.retAbierta === f.ml_order_id;
      var aviso = S.retAviso[f.ml_order_id]
        ? '<div class="ui-aviso ui-aviso--atencion cv-ret__aviso" role="alert">⚠ Se va a volver a retener.</div> ' : '';
      var liberar = '';
      if (puedeEscribir() && !S.retAviso[f.ml_order_id]) {
        var avisoRecaida = f.se_vuelve_a_retener
          ? '<div class="ui-aviso ui-aviso--atencion cv-ret__aviso" role="note"><span aria-hidden="true">⚠</span> Al liberar, en la próxima sincronización se crea el pedido en la web. Si la causa sigue, se vuelve a retener.</div>' : '';
        liberar = abierta
          ? '<form class="cv-ret__form" data-accion="liberar-enviar" data-orden="' + esc(f.ml_order_id) + '" novalidate>' + avisoRecaida
            + '<label class="ui-label" for="ret-m-' + esc(f.ml_order_id) + '">Motivo <span>(obligatorio)</span></label>'
            + '<textarea id="ret-m-' + esc(f.ml_order_id) + '" class="ui-input" rows="2"></textarea>'
            + '<p class="cv-error" hidden></p>'
            + '<div class="cv-acciones__fila"><button type="submit" class="ui-btn ui-btn--primario" aria-disabled="' + !!S.busy + '">'
            + (S.busy === 'liberar' ? 'Liberando…' : 'Confirmar liberación') + '</button>'
            + '<button type="button" class="ui-btn" data-accion="liberar-cancelar">Cancelar</button></div></form>'
          : '<button type="button" class="ui-btn" data-accion="liberar-abrir" data-orden="' + esc(f.ml_order_id) + '" aria-expanded="false">Liberar</button>';
      }
      var titulo = f.titulo ? esc(f.titulo) : 'Sin dato del título';
      var importe = f.importe != null ? esc(money(f.importe)) : 'sin dato';
      return '<article class="cv-ret"><div class="cv-ret__info">'
        + '<div class="cv-ret__cab"><span><strong>' + titulo + '</strong> · pedido <span class="ui-id">' + esc(f.ml_order_id) + '</span></span>'
        + '<span class="ui-label">' + esc(fecha(f.creado_en)) + '</span></div>'
        + '<p class="ui-resumen">Publicación <span class="ui-id">' + esc(normClave((f.claves || [])[0]) || '—') + '</span> · importe ' + importe + '</p>'
        + '<p class="ui-resumen">Causa: ' + esc(causaDe(f)) + '</p>'
        + aviso + '</div>' + (liberar ? '<div class="cv-ret__accion">' + liberar + '</div>' : '') + '</article>';
    }).join('');
    actualizarContadoresTab();
  }

  function liberarRetenida(form) {
    if (S.busy || !puedeEscribir()) return; // doble envío: se ignora mientras hay una liberación en curso
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
    var boton = form.querySelector('button[type="submit"]');
    if (boton) { boton.setAttribute('aria-disabled', 'true'); boton.textContent = 'Liberando…'; }
    api('POST', '/retenidas/' + enc(orden) + '/liberar', { motivo: motivo }).then(function (r) {
      S.busy = null;
      if (!r.ok) {
        if (boton) { boton.setAttribute('aria-disabled', 'false'); boton.textContent = 'Confirmar liberación'; }
        err.textContent = mensajeDe(r); err.hidden = false; return;
      }
      S.retAbierta = null;
      if (sigueCausa) { S.retAviso[orden] = true; renderRetenidas(); anunciar('Liberada, pero se va a volver a retener.', 'alerta'); enfocarPorSelector('#tab-retenidas'); return; }
      anunciar('Venta liberada.', 'estado');
      cargarRetenidas().then(function () { enfocarPorSelector('#ret-cuerpo [data-accion="liberar-abrir"], #tab-retenidas'); });
    });
  }

  // ── Vínculos ──────────────────────────────────────────────────────────────────────────────────
  var VINC_FILTROS = [['all', 'Todos'], ['asignar', 'Asignar SKU'], ['verificar', 'Verificar'], ['conf-baja', 'Confianza baja'], ['color-talle', 'Color y talle correcto']];
  function modoVinc() { var r = document.querySelector('input[name="vinc-modo"]:checked'); return r ? r.value : 'producto'; }

  // Chips con los conteos que devuelve el servidor (con q aplicado). Si el chip enfocado se re-pinta, vuelve el foco a él.
  function renderVincFiltros() {
    var box = $('#vinc-filtros');
    box.hidden = modoVinc() !== 'ml';
    var enFoco = box.contains(document.activeElement) ? document.activeElement.getAttribute('data-filtro') : null;
    box.innerHTML = VINC_FILTROS.map(function (f) {
      var n = S.vincConteos ? S.vincConteos[f[0]] : null;
      return '<button type="button" class="ui-chip" data-accion="vinc-filtro" data-filtro="' + f[0] + '" aria-pressed="' + (S.vincFiltro === f[0]) + '">'
        + esc(f[1]) + (n != null ? ' · ' + n : '') + '</button>';
    }).join('');
    if (enFoco) { var b = box.querySelector('[data-filtro="' + enFoco + '"]'); if (b) b.focus(); }
  }

  // Paginado del Matcher: solo se piden q + filtro + limit + offset (nunca scope=all, ~21 MB).
  var VINC_PAGINA = 50;
  var VINC_DEBOUNCE_MS = 300;
  var vincTimer = null;
  // Matcher calculando (202 {computing:true}): reintento automático cada 1,5 s, tope ~60 s.
  var VINC_REINTENTO_MS = 1500;
  var VINC_REINTENTOS_MAX = 40;
  var vincRetryTimer = null;
  function cancelarReintentoML() { clearTimeout(vincRetryTimer); vincRetryTimer = null; }
  function vincUrl(offset) {
    return '/api/matcher/candidatos?q=' + enc(S.vincQ.trim()) + '&filtro=' + enc(S.vincFiltro || 'all')
      + '&limit=' + VINC_PAGINA + '&offset=' + (offset || 0);
  }

  // El Matcher trae `clave` (item|variación, sin pipe final si no hay variación). Se compara sin el pipe final.
  function claveDeMl(it) { return it.clave || (it.ml_item_id + (it.ml_variation_id ? '|' + it.ml_variation_id : '')); }
  function normClave(k) { return String(k || '').replace(/\|$/, ''); }

  // Buscador: producto Woo (identidad) o publicación ML (candidatos del Matcher, solo lectura, paginado en servidor).
  function buscarVinculos(q) {
    var cont = $('#vinc-resultados');
    var modo = modoVinc();
    S.vincQ = q || '';
    var req = S.vincReq = (S.vincReq || 0) + 1; // contador de petición: solo vale la última (también para "Ver más")
    clearTimeout(vincTimer);
    cancelarReintentoML(); // una búsqueda nueva descarta el reintento pendiente del Matcher
    if (!S.vincFiltro) S.vincFiltro = 'all';
    S.vincItems = []; S.vincTotal = 0; S.vincOffset = 0; S.vincCargandoMas = false;
    if (modo !== 'ml') S.vincConteos = null;
    renderVincFiltros();
    // Sin texto no se busca (no se pide la lista entera): se muestra el estado inicial con instrucciones.
    if (!S.vincQ.trim()) {
      cont.setAttribute('aria-busy', 'false');
      cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>'
        + (modo === 'producto' ? 'Escribí un nombre, SKU o GTIN del producto Woo para buscarlo.' : 'Escribí un título o una clave de publicación ML para buscarla.')
        + '</p></div>';
      return Promise.resolve();
    }
    cont.setAttribute('aria-busy', 'true');
    if (modo === 'ml') return pedirML(req, 0);
    return identidad('/productos/buscar?q=' + enc(S.vincQ.trim())).then(function (r) {
      if (req !== S.vincReq) return; // respuesta de una búsqueda o modalidad anterior
      cont.setAttribute('aria-busy', 'false');
      if (!r.ok) { cont.innerHTML = cajaError(mensajeDe(r), 'buscarVinculos'); return; }
      var lista = r.data.data || [];
      if (!lista.length) { cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>Sin resultados para “' + esc(S.vincQ) + '”.</p></div>'; return; }
      cont.innerHTML = '<p class="ui-resumen" role="status">' + cuenta(lista.length, 'resultado', 'resultados') + '</p>' + lista.map(tarjetaProducto).join('');
    });
  }

  // Pide la primera página ML. Si el Matcher está calculando (202 computing), muestra "Calculando candidatos…"
  // (anunciado con role=status) y reintenta solo. El DOM no se reescribe en cada reintento para no re-anunciar.
  function pedirML(req, intento) {
    var cont = $('#vinc-resultados');
    return llamar('GET', vincUrl(0)).then(function (r) {
      if (req !== S.vincReq) return; // búsqueda o modalidad distinta: descarta esta respuesta y su reintento
      if (r.ok && r.data.computing) {
        if (intento >= VINC_REINTENTOS_MAX) {
          cont.setAttribute('aria-busy', 'false');
          cont.innerHTML = cajaError('El Matcher tardó demasiado en calcular los candidatos. Probá de nuevo.', 'buscarVinculos');
          return;
        }
        if (intento === 0) cont.innerHTML = '<div class="api-estado api-estado--cargando" role="status" aria-live="polite"><p><span class="cv-girando" aria-hidden="true">◌</span> Calculando candidatos…</p></div>';
        vincRetryTimer = setTimeout(function () { vincRetryTimer = null; pedirML(req, intento + 1); }, VINC_REINTENTO_MS);
        return;
      }
      cont.setAttribute('aria-busy', 'false');
      if (!r.ok) { cont.innerHTML = cajaError(mensajeDe(r), 'buscarVinculos'); return; }
      S.vincConteos = r.data.conteos || null;
      S.vincTotal = Number(r.data.total) || 0;
      S.vincItems = r.data.items || [];
      S.vincOffset = S.vincItems.length;
      renderVincFiltros();
      if (!S.vincTotal) { cont.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>Sin resultados para “' + esc(S.vincQ) + '”.</p></div>'; return; }
      pintarML();
    });
  }

  // Pinta los ítems ML acumulados. Si `desde` viene, el foco pasa al primer ítem nuevo (Ver más).
  function pintarML(desde) {
    var cont = $('#vinc-resultados');
    var n = S.vincItems.length, t = S.vincTotal;
    var html = '<p class="ui-resumen" role="status">Mostrando ' + n + ' de ' + t + ' ' + plural(t, 'resultado', 'resultados') + '</p>'
      + S.vincItems.map(function (it, i) { return tarjetaML(it, i); }).join('');
    if (n < t) html += '<p><button type="button" class="ui-btn" data-accion="vinc-ver-mas">Ver más (' + Math.min(VINC_PAGINA, t - n) + ')</button></p>';
    cont.innerHTML = html;
    if (desde != null) { var primero = cont.querySelector('[data-idx="' + desde + '"]'); if (primero) primero.focus(); }
  }

  // "Ver más": pide la página siguiente y concatena. Si el usuario cambió la búsqueda en el medio, la respuesta se descarta.
  function verMasVinculos() {
    if (S.vincCargandoMas || S.vincItems.length >= S.vincTotal) return;
    var req = S.vincReq;
    var desde = S.vincItems.length;
    S.vincCargandoMas = true;
    llamar('GET', vincUrl(S.vincOffset)).then(function (r) {
      if (req !== S.vincReq) return;
      S.vincCargandoMas = false;
      if (!r.ok) { anunciar(mensajeDe(r), 'alerta'); return; }
      if (r.data.computing) { anunciar('El Matcher está calculando. Probá en un rato.', 'alerta'); return; }
      var nuevos = r.data.items || [];
      S.vincItems = S.vincItems.concat(nuevos);
      S.vincOffset += nuevos.length;
      S.vincTotal = Number(r.data.total) || S.vincTotal;
      pintarML(nuevos.length ? desde : null);
    });
  }

  function tarjetaProducto(p) {
    return '<article class="cv-tarjeta-vinc"><strong>' + esc(p.nombre_canonico || '—') + '</strong>'
      + '<p class="ui-resumen">SKU Fusion <span class="ui-id">' + esc(p.fusion_sku || '—') + '</span> · SKU Woo <span class="ui-id">' + esc(p.sku_woo || '—') + '</span></p>'
      + '<p class="ui-resumen">Stock Woo ' + esc(p.stock_woo == null ? 'sin dato' : p.stock_woo) + ' · publicaciones ML activas ' + esc(p.identidades_ml_activas || 0) + '</p>'
      + '<button type="button" class="ui-btn" data-accion="vinc-pubs-producto" data-id="' + esc(p.id) + '" aria-expanded="false">Ver publicaciones ML</button>'
      + '<div class="cv-pubs-producto" data-pubs="' + esc(p.id) + '"></div></article>';
  }

  // Publicaciones ML de un producto Woo. Endpoint: GET /api/catalogo-vinculos/productos/:id/publicaciones.
  // Toggle real: aria-expanded refleja si la caja está abierta. Cache por producto; un error queda
  // visible y el próximo clic (con la caja abierta) cierra; reabrir reintenta si la última fue error.
  function pintarPublicaciones(caja, entrada) {
    if (entrada.error) { caja.innerHTML = '<p class="cv-error">No pudimos listar las publicaciones de este producto. Volvé a tocar el botón para reintentar.</p>'; return; }
    var lista = entrada.lista;
    caja.innerHTML = lista.length
      ? '<ul class="cv-lista-hermanas">' + lista.map(function (x) {
          return '<li><span class="ui-id">' + esc(x.clave) + '</span> ' + esc(x.titulo || '') + ' <span class="ui-label">' + esc(estadoMlTxt(x.status)) + '</span>'
            + ' <button type="button" class="ui-btn" data-accion="vinc-ml" data-clave="' + esc(x.clave) + '">Ver vínculo</button></li>';
        }).join('') + '</ul>'
      : '<p class="ui-resumen">Este producto no tiene publicaciones ML.</p>';
  }

  function verPublicacionesProducto(id, boton) {
    var caja = $('[data-pubs="' + id + '"]');
    if (!caja) return;
    var abierta = boton && boton.getAttribute('aria-expanded') === 'true';
    if (abierta) {
      if (boton) boton.setAttribute('aria-expanded', 'false');
      caja.hidden = true; caja.innerHTML = '';
      return;
    }
    if (boton) boton.setAttribute('aria-expanded', 'true');
    caja.hidden = false;
    var previa = S.pubsCache[id];
    if (previa && !previa.error) { pintarPublicaciones(caja, previa); return; }
    caja.innerHTML = '<p class="ui-resumen">Buscando publicaciones…</p>';
    api('GET', '/productos/' + enc(id) + '/publicaciones').then(function (r) {
      // Si el usuario cerró mientras cargaba, no reabrimos la caja.
      if (!boton || boton.getAttribute('aria-expanded') !== 'true') return;
      S.pubsCache[id] = r.ok ? { lista: r.data.data || [] } : { error: true };
      pintarPublicaciones(caja, S.pubsCache[id]);
    });
  }

  function tarjetaML(it, idx) {
    var clave = claveDeMl(it);
    var conf = it.score_confianza < 0.7 ? 'Confianza baja' : 'Confianza alta';
    return '<article class="cv-tarjeta-vinc" tabindex="-1" data-idx="' + idx + '"><strong>' + esc(it.ml_title || clave) + '</strong>'
      + '<p class="ui-resumen"><span class="ui-id">' + esc(clave) + '</span> · ' + esc(it.modo || '') + ' · ' + conf + '</p>'
      + '<button type="button" class="ui-btn" data-accion="vinc-ml" data-clave="' + esc(clave) + '">Ver vínculo</button></article>';
  }

  // Panel de vínculo: vínculo vigente, hermanas por SKU y GTIN, marca, orden de identificadores y notas.
  function abrirVinculoML(clave) {
    var p = $('#vinc-vinculo');
    p.innerHTML = '<p class="ui-resumen">Buscando el vínculo…</p>';
    S.vincPanel = null; S.identMsg = null;
    return buscarCasoPorClave(clave).then(function (m) {
      if (!m) {
        // Sin caso abierto: consulta por clave (lectura). Endpoint pendiente: GET /api/catalogo-vinculos/claves/:clave.
        return api('GET', '/claves/' + enc(clave)).then(function (r) {
          S.vincPanel = { clave: clave, sinCaso: true, detalle: r.ok ? r.data.data : null };
          renderVincPanel();
        });
      }
      return Promise.all([api('GET', '/casos/' + m.id), identidad('/casos/' + m.id)]).then(function (rs) {
        if (!rs[0].ok) { p.innerHTML = cajaError(mensajeDe(rs[0]), 'cargarCola'); return; }
        S.vincPanel = { clave: clave, casoId: m.id, detalle: rs[0].data.data, ident: rs[1].ok ? rs[1].data.data : null };
        renderVincPanel();
      });
    });
  }

  function listaItems(arr) {
    return arr.map(function (h) {
      return '<li><span class="ui-id">' + esc(h.clave) + '</span> ' + esc(h.titulo || '') + ' <span class="ui-label">' + esc(motivoTxt(h.motivo)) + '</span></li>';
    }).join('');
  }

  function renderVincPanel() {
    var p = $('#vinc-vinculo');
    var v = S.vincPanel;
    if (!v) { p.innerHTML = ''; return; }
    // Sin caso y sin consulta por clave disponible: degradación explícita (no se inventa el vínculo).
    if (v.sinCaso && !v.detalle) {
      p.innerHTML = '<div class="api-estado api-estado--vacio" role="status"><p>Esta publicación no tiene un caso abierto, y todavía no podemos mostrar su vínculo desde acá.</p></div>';
      return;
    }
    var d = v.detalle; var id = v.ident || {};
    var escribe = puedeEscribir();
    var pub = (d.caso && d.caso.publicacion) || {};
    var vig = d.vinculo_vigente; var marca = d.marca;
    var hSku = id.hermanas_ml || []; var hGtin = id.ml_por_gtin_producto || [];
    var ids = id.producto && Array.isArray(id.producto.identificadores) ? id.producto.identificadores : null;
    var idsHtml = ids
      ? '<ol class="cv-hist__lista">' + ids.map(function (x, i) {
          var mover = escribe
            ? ' <button type="button" class="ui-btn" data-accion="ident-mover" data-idx="' + i + '" data-dir="-1" aria-label="Subir ' + esc(x.valor_normalizado) + '">↑</button> <button type="button" class="ui-btn" data-accion="ident-mover" data-idx="' + i + '" data-dir="1" aria-label="Bajar ' + esc(x.valor_normalizado) + '">↓</button>'
            : '';
          return '<li><span class="ui-id">' + esc(x.valor_normalizado) + '</span>' + mover + '</li>';
        }).join('') + '</ol>'
        + (escribe ? '<button type="button" class="ui-btn ui-btn--primario" data-accion="ident-guardar">Guardar orden</button>' : '')
        + (S.identMsg ? '<p class="ui-resumen" role="' + (S.identMsg.error ? 'alert' : 'status') + '">' + (S.identMsg.error ? '✗ ' : '') + esc(S.identMsg.texto) + '</p>' : '')
      : '<p class="ui-resumen">Orden de identificadores: no disponible en esta vista.</p>';
    var marcaTxt = !marca ? 'Sin marca.'
      : (marca.tipo === 'link_de_pago' ? 'Link de pago.' : 'No sincronizar (' + nombreVariante(marca.variante) + ') · por ' + (marca.por || '—') + '.');
    var revertir = '';
    if (marca && marca.tipo === 'no_sincronizar') {
      if (!escribe) revertir = '<p class="cv-leyenda-pc">Para revertir, usá la PC.</p>';
      else revertir = (marca.variante === 'c' && !S.isAdmin)
        ? '<p class="cv-lock">Lo revierte un admin.</p>'
        : '<form data-accion="vinc-revertir" class="cv-cuadro-motivo" novalidate><label class="ui-label" for="rev-motivo">Motivo <span>(obligatorio)</span></label>'
          + '<textarea id="rev-motivo" class="ui-input" rows="2"></textarea><p class="cv-error" hidden></p>'
          + '<div class="cv-acciones__fila"><button type="submit" class="ui-btn">Revertir no sincronizar</button></div></form>';
    }
    var acciones = v.casoId
      ? '<div class="cv-acciones__fila">' + (escribe ? '<button type="button" class="ui-btn ui-btn--primario" data-accion="vinc-revincular" data-caso="' + v.casoId + '">Revincular</button>' : '')
        + '<button type="button" class="ui-btn" data-accion="vinc-historial" data-caso="' + v.casoId + '">Ver historial</button></div>'
      : '';
    p.innerHTML = '<article class="ui-card cv-vinc-card"><h2 class="cv-h2">' + esc(pub.titulo || v.clave) + '</h2>'
      + '<p class="ui-resumen">Publicación <span class="ui-id">' + esc(v.clave) + '</span></p>'
      + '<p>Vínculo vigente: ' + (vig ? '<span class="ui-id">' + esc(vig.sku) + '</span> <span class="ui-label">' + esc(vig.accion) + ' · desde ' + esc(fecha(vig.desde)) + '</span>' : 'Sin vínculo activo.') + '</p>'
      + '<p>Marca: ' + esc(marcaTxt) + '</p>' + revertir
      + '<h3 class="ui-label">Hermanas por SKU</h3>' + (hSku.length ? '<ul class="cv-lista-hermanas">' + listaItems(hSku) + '</ul>' : '<p class="ui-resumen">Ninguna.</p>')
      + '<h3 class="ui-label">Hermanas por GTIN</h3>' + (hGtin.length ? '<ul class="cv-lista-hermanas">' + listaItems(hGtin) + '</ul>' : '<p class="ui-resumen">Ninguna.</p>')
      + '<h3 class="ui-label">Orden de identificadores</h3>' + idsHtml
      + '<h3 class="ui-label">Notas</h3>' + ((d.notas || []).length
        ? '<ol class="cv-hist__lista">' + d.notas.map(function (h) { return '<li><span class="ui-label">' + esc(fecha(h.creado_en)) + ' · ' + esc(h.actor || 'sistema') + '</span> ' + esc(h.evento) + '</li>'; }).join('') + '</ol>'
        : '<p class="ui-resumen">Sin notas.</p>')
      + acciones + '</article>';
  }

  function nombreVariante(v) {
    var f = VARIANTES.find(function (x) { return x.v === v; });
    return f ? f.nombre : 'variante ' + (v || '—');
  }

  function revertirNS(f) {
    var v = S.vincPanel;
    var ta = f.querySelector('textarea');
    var err = f.querySelector('.cv-error');
    var motivo = (ta.value || '').trim();
    if (!motivo) { err.textContent = 'Falta el motivo. Es obligatorio.'; err.hidden = false; ta.focus(); return; }
    api('POST', '/claves/no-sincronizar/deshacer', { clave: v.clave, motivo: motivo }).then(function (r) {
      if (!r.ok) { err.textContent = mensajeDe(r); err.hidden = false; return; }
      anunciar('No sincronizar revertido.', 'estado');
      abrirVinculoML(v.clave);
    });
  }

  function identMover(idx, dir) {
    var arr = S.vincPanel && S.vincPanel.ident && S.vincPanel.ident.producto && S.vincPanel.ident.producto.identificadores;
    if (!arr) return;
    var j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    var t = arr[idx]; arr[idx] = arr[j]; arr[j] = t;
    renderVincPanel();
    enfocarPorSelector('[data-accion="ident-mover"][data-idx="' + j + '"][data-dir="' + dir + '"]');
  }

  function identGuardar() {
    var prod = S.vincPanel && S.vincPanel.ident && S.vincPanel.ident.producto;
    if (!prod || !puedeEscribir()) return;
    var valores = prod.identificadores.map(function (x) { return x.valor_normalizado; });
    S.identMsg = { texto: 'Guardando…' };
    renderVincPanel();
    llamar('PUT', IDENT + '/productos/' + prod.id + '/identificadores/orden', { valores: valores }).then(function (r) {
      S.identMsg = r.ok ? { texto: 'Orden guardado.' } : { texto: mensajeDe(r), error: true };
      anunciar(S.identMsg.texto, r.ok ? 'estado' : 'alerta');
      renderVincPanel();
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
          + '<span class="ui-label">' + esc(tipoIdentTxt(x.subtipo)) + ' · ' + esc(cuenta(Number(x.productos) || 0, 'producto', 'productos')) + '</span></span>'
          + '<button type="button" class="ui-btn" data-accion="ver-conflicto" data-valor="' + esc(x.valor_normalizado) + '" aria-expanded="' + abierto + '">'
          + (abierto ? 'Cerrar' : 'Ver y resolver') + '</button></div>'
          + (abierto ? conflictoDetalleHtml() : '') + '</article>';
      }).join('');
    });
  }

  function conflictoDetalleHtml() {
    var d = S.conflictoDetalle;
    if (!d) return '<p class="ui-resumen">Cargando…</p>';
    var escribe = puedeEscribir();
    var filas = (d.productos || []).map(function (p) {
      var botones = escribe
        ? '<span class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="resolver" data-ganador="' + p.id + '" data-valor="' + esc(d.valor_normalizado) + '">Es de este</button>'
          + '<button type="button" class="ui-btn ui-btn--peligro" data-accion="incorrecto" data-producto="' + p.id + '" data-valor="' + esc(d.valor_normalizado) + '">No le corresponde</button></span>'
        : '';
      return '<div class="cv-prod-conf__fila"><span><strong>' + esc(p.fusion_sku) + '</strong> ' + esc((p.nombre_canonico || '').slice(0, 70))
        + '<br><span class="ui-label">Stock Woo ' + esc(p.stock_woo == null ? '—' : p.stock_woo) + ' · Stock ML ' + esc(p.stock_ml) + '</span></span>'
        + botones + '</div>';
    }).join('');
    // "Es de este" marca a todos los demás como incorrectos: pide confirmación con la cantidad antes de enviar.
    var cr = S.confResolver;
    var confirmar = (cr && cr.valor === d.valor_normalizado)
      ? '<div class="ui-aviso ui-aviso--atencion cv-foco-bloque" role="alert" tabindex="-1" id="bloque-conf-resolver"><p>¿Marcar ' + cuenta(cr.n, 'producto', 'productos') + ' como ' + plural(cr.n, 'incorrecto', 'incorrectos') + '? El código queda en «' + esc(cr.nombre) + '».</p>'
        + '<div class="cv-acciones__fila"><button type="button" class="ui-btn ui-btn--primario" data-accion="resolver-ok">Sí, marcar ' + cr.n + '</button>'
        + '<button type="button" class="ui-btn" data-accion="resolver-cancelar">Cancelar</button></div></div>'
      : '';
    return '<div class="cv-prod-conf">'
      + '<p class="ui-resumen">«Es de este» le deja el código a ese producto y marca a todos los demás como incorrectos. «No le corresponde» descarta sólo a ese.</p>'
      + (escribe ? '<div class="cv-campo"><label class="ui-label" for="conf-motivo">Motivo <span>(obligatorio)</span></label>'
      + '<input id="conf-motivo" class="ui-input" type="text" autocomplete="off" value="' + esc(cr && cr.valor === d.valor_normalizado ? cr.motivo : (S.confMotivo && S.confMotivo.valor === d.valor_normalizado ? S.confMotivo.motivo : '')) + '"><p id="conf-err" class="cv-error" hidden></p></div>' : '<p class="cv-leyenda-pc">Para resolver conflictos, usá la PC.</p>')
      + confirmar
      + filas + (d.truncado ? '<p class="ui-resumen">Se muestran los ' + esc((d.productos || []).length) + ' con más stock, de ' + esc(d.total_productos) + '.</p>' : '')
      + '</div>';
  }

  // "Es de este": primero pide confirmación con la cantidad de productos que se marcan como incorrectos.
  function pedirConfirmacionResolver(el) {
    var motivo = (($('#conf-motivo') || {}).value || '').trim();
    if (!motivo) { var e = $('#conf-err'); e.textContent = 'Falta el motivo. Es obligatorio.'; e.hidden = false; $('#conf-motivo').focus(); return; }
    var d = S.conflictoDetalle || {};
    var total = Number(d.total_productos) || (d.productos || []).length;
    var gan = (d.productos || []).find(function (p) { return String(p.id) === el.getAttribute('data-ganador'); });
    var nombreGan = gan ? (gan.fusion_sku || gan.nombre_canonico || el.getAttribute('data-valor')) : el.getAttribute('data-valor');
    S.confResolver = { valor: el.getAttribute('data-valor'), ganador: el.getAttribute('data-ganador'), n: Math.max(total - 1, 0), nombre: nombreGan, motivo: motivo };
    cargarConflictos().then(function () { enfocarPorSelector('#bloque-conf-resolver'); });
  }

  // spec: { accion: 'resolver' | 'incorrecto', valor, producto }
  function resolverConflicto(spec) {
    if (S.busy) return;
    var motivo = (($('#conf-motivo') || {}).value || '').trim();
    if (!motivo) { var e = $('#conf-err'); e.textContent = 'Falta el motivo. Es obligatorio.'; e.hidden = false; $('#conf-motivo').focus(); return; }
    var valor = spec.valor;
    var ruta; var body;
    if (spec.accion === 'resolver') {
      ruta = '/identificadores/conflictos/resolver'; body = { valor_normalizado: valor, producto_id: Number(spec.producto), motivo: motivo };
    } else {
      ruta = '/identificadores/incorrecto'; body = { valor_normalizado: valor, producto_id: Number(spec.producto), motivo: motivo };
    }
    // Si el producto tiene un único GTIN activo, el backend responde requiere_confirmacion:'permitir_unico'.
    // Se pregunta y se reenvía con permitir_unico:true solo si la persona confirma; cancelar no envía nada.
    var enviar = function (extra) {
      S.busy = 'conflicto'; aplicarBloqueo();
      return llamar('POST', IDENT + ruta, Object.assign({}, body, extra || {})).then(function (r) {
        S.busy = null; aplicarBloqueo();
        if (!r.ok && spec.accion === 'incorrecto' && !extra && r.data && r.data.requiere_confirmacion === 'permitir_unico') {
          // Volver devuelve el foco al "No le corresponde" del mismo producto, buscado al cerrar (no el nodo viejo ni body).
          var botonIncorrecto = function () {
            return $$('[data-accion="incorrecto"]').filter(function (b) { return b.getAttribute('data-producto') === String(spec.producto) && b.getAttribute('data-valor') === valor; })[0] || null;
          };
          pedirConfirmacion({ titulo: 'Es el único código del producto', texto: 'Va a quedar sin GTIN; ¿confirmás igual?', ok: 'Confirmar igual', peligro: true,
            disparador: botonIncorrecto,
            onCancel: function () { anunciar('No se marcó el código.', 'estado'); },
            onOk: function () { enviar({ permitir_unico: true }); } });
          return;
        }
        if (!r.ok) { var e2 = $('#conf-err'); if (e2) { e2.textContent = mensajeDe(r); e2.hidden = false; } return; }
        S.conflictoAbierto = null; S.conflictoDetalle = null; S.confResolver = null; S.confMotivo = null;
        anunciar('Código resuelto: ' + valor, 'estado');
        cargarConflictos();
      });
    };
    return enviar();
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
    if (nombre === 'vinculos' && !$('#vinc-resultados').innerHTML) buscarVinculos($('#vinc-q').value);
    if (nombre === 'ejecucion') {
      S.ejecMsgs = {};
      cargarEjecucion();
      S.ejecPoll = setInterval(function () { if (!document.hidden) cargarEjecucion(); }, 20000);
    }
    if (nombre === 'retenidas') cargarRetenidas();
  }

  // Conteos de pestañas (fallidas y retenidas) al abrir la pantalla.
  function actualizarContadoresIniciales() {
    api('GET', '/ejecucion').then(function (r) { if (r.ok) { S.ejecSnap = r.data.data; S.ejec = r.data.data; actualizarContadoresTab(); } });
    // Las retenidas se guardan acá (no solo al abrir la tab) para que el link del caso aparezca sin visitarla.
    api('GET', '/retenidas').then(function (r) {
      if (!r.ok) return;
      S.retenidas = r.data.data || [];
      $('#cnt-retenidas').textContent = '· ' + S.retenidas.length;
      if (S.detalle) renderDetalle();
    });
  }

  // ── Eventos (delegación) ──────────────────────────────────────────────────────────────────────
  function bindEventos() {
    document.addEventListener('keydown', teclado);

    $('#cv-atajos-on').addEventListener('change', function (e) { guardarAtajos(e.target.checked); });
    $('#dlg-atajos-on').addEventListener('change', function (e) { guardarAtajos(e.target.checked); });
    $('#cv-btn-ayuda').addEventListener('click', function (e) { abrirDialogo($('#dlg-atajos'), e.currentTarget, $('#dlg-atajos-on')); });
    $('#dlg-atajos-cerrar').addEventListener('click', function () { cerrarDialogo(); });
    $('#ns-volver').addEventListener('click', intentarCerrarDialogo);
    $('#dlg-imp-volver').addEventListener('click', function () { cerrarDialogo(); });
    $('#dlg-conf-volver').addEventListener('click', function () { cerrarConfirmacion(false); });
    $('#dlg-conf-ok').addEventListener('click', function () {
      if (S.busy || !S.confOnOk) return; // doble clic: la primera pulsación ya consumió la confirmación
      cerrarConfirmacion(true);
    });
    $('#exc-volver').addEventListener('click', function () { cerrarDialogo(); });
    $('#ning-volver').addEventListener('click', function () { cerrarDialogo(); });
    $('#rev-volver').addEventListener('click', function () { S.rev = null; cerrarDialogo(); });
    $('#dlg-foto-cerrar').addEventListener('click', function () { cerrarDialogo(); });
    $('#dlg-imp-cuerpo').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-accion="dlg-imp-reintentar"]');
      if (b) reintentarListaImpacto(Number(b.getAttribute('data-op')));
    });
    $('#dlg-imp-ok').addEventListener('click', function () {
      if (this.getAttribute('aria-disabled') === 'true') return;
      var id = Number(this.getAttribute('data-op'));
      cerrarDialogo();
      reintentarOp(id, 'confirmar-impacto');
    });
    $('#ns-form').addEventListener('submit', nsEnviar);
    $('#ns-form').addEventListener('change', function (e) {
      if (e.target.name === 'ns-variante') {
        S.nsVariante = e.target.value;
        if (S.nsVariante !== 'b') { $('#ns-alcance').hidden = true; $('#ns-alcance').innerHTML = ''; S.nsConfirm = false; S.nsOpId = null; }
        $('#ns-enviar').removeAttribute('aria-disabled');
        $('#ns-enviar').removeAttribute('aria-describedby');
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

    // Ejecución: filtro por texto con debounce (300 ms); cada cambio reinicia la paginación.
    $('#ejec-q').addEventListener('input', function (ev) {
      var v = ev.target.value.trim();
      clearTimeout(S.ejecTimer);
      S.ejecTimer = setTimeout(function () {
        if (v === S.ejecQ) return;
        S.ejecQ = v; S.ejecMasError = null;
        cargarEjecucion({ reiniciar: true });
      }, 300);
    });
    // Recuerda qué secciones colapsadas quedaron abiertas (el cuerpo se repinta en cada refresco).
    $('#ejec-cuerpo').addEventListener('toggle', function (ev) {
      var sec = ev.target.getAttribute && ev.target.getAttribute('data-seccion');
      if (sec) { S.ejecAbiertas[sec] = ev.target.open; ev.target.querySelector('summary').setAttribute('aria-expanded', String(ev.target.open)); }
    }, true);
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
      if (el.tagName === 'A') ev.preventDefault();
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
        case 'deshacer': deshacerAccion(); break;
        case 'deshacer-ninguno': deshacerNinguno(Number(el.getAttribute('data-caso'))); break;
        case 'excepcion': abrirExcepcion(el); break;
        case 'ninguno': abrirNinguno(el); break;
        case 'revertir-caso': abrirRevertirCaso(Number(el.getAttribute('data-op')), Number(el.getAttribute('data-caso')), el); break;
        case 'revertir-abrir': abrirRevertirEjec(Number(el.getAttribute('data-op')), el); break;
        case 'solo-dif': S.soloDif = !S.soloDif; renderDetalle(); break;
        case 'hermanas-si':
          if (!S.hermanas || !caso() || !puedeEscribir()) break;
          var h = S.hermanas; S.hermanas = null;
          var cH = caso(); var bodyH = Object.assign({}, h.body, { confirm_sibling_impact: true });
          S.busy = 'vincular'; S.focoPendiente = '[data-accion="vincular"]'; renderDetalle();
          api('POST', '/casos/' + cH.id + '/decisiones', bodyH).then(function (r) {
            S.busy = null;
            resultadoVincular(cH, bodyH.product_id, bodyH, r, null, null);
          });
          break;
        case 'hermanas-no': S.hermanas = null; S.focoPendiente = '[data-accion="vincular"]'; renderDetalle(); break;
        case 'conflicto-aplicar':
          // Reaplica la misma decisión (mismo producto) sobre la versión nueva del caso, con un operation_id nuevo.
          var cv = S.conflictoVersion; var cA = caso();
          if (!cv || !cA || !puedeEscribir() || S.busy) break;
          var nuevo = Object.assign({}, cv.body, { operation_id: uuid(), expected_version: cA.expected_version, evidence_fingerprint: cA.evidencia_fingerprint });
          S.conflictoVersion = null;
          S.busy = 'vincular'; S.focoPendiente = '[data-accion="vincular"]'; renderDetalle();
          api('POST', '/casos/' + cA.id + '/decisiones', nuevo).then(function (r) {
            S.busy = null;
            resultadoVincular(cA, nuevo.product_id, nuevo, r, null, cv.cand);
          });
          break;
        case 'conflicto-descartar': S.conflictoVersion = null; S.focoPendiente = '[data-accion="vincular"]'; renderDetalle(); break;
        case 'reintentar-matriz': if (S.elegido) { S.matrizError = null; cargarMatriz(S.elegido); } break;
        case 'ver-mas': verMasCola(); break;
        case 'vinc-pubs-producto': verPublicacionesProducto(el.getAttribute('data-id'), el); break;
        case 'admin': recordarDisparador(el); S.adminForm = el.getAttribute('data-admin'); renderDetalle(); enfocarPorSelector('#adm-motivo'); break;
        case 'admin-cancelar': S.adminForm = null; renderDetalle(); enfocarDisparador(); break;
        case 'reintentar-carga':
          var rc = el.getAttribute('data-reintento');
          if (rc === 'cargarCola') { S.colaCargada = false; cargarCola(); }
          else if (rc === 'cargarEstado') cargarEstado();
          else if (rc === 'cargarEjecucion') cargarEjecucion();
          else if (rc === 'cargarRetenidas') cargarRetenidas();
          else if (rc === 'cargarConflictos') cargarConflictos();
          else if (rc === 'reabrirCaso' && S.casoId) abrirCaso(S.casoId);
          else if (rc === 'buscarVinculos') buscarVinculos($('#vinc-q').value);
          break;
        case 'reintentar': reintentarOp(Number(el.getAttribute('data-op')), 'reintentar'); break;
        case 'confirmar-impacto': abrirConfirmarImpacto(Number(el.getAttribute('data-op'))); break;
        case 'liberar-abrir': S.retAbierta = el.getAttribute('data-orden'); renderRetenidas(); enfocarPorSelector('#ret-cuerpo textarea'); break;
        case 'liberar-cancelar':
          var ordCan = el.closest('[data-orden]').getAttribute('data-orden');
          S.retAbierta = null; renderRetenidas();
          enfocarPorSelector('[data-accion="liberar-abrir"][data-orden="' + ordCan + '"]');
          break;
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
        case 'tomar': accionCaso('/casos/' + caso().id + '/tomar', { operation_id: opIdPara('tomar:' + caso().id), expected_version: caso().expected_version, evidence_fingerprint: caso().evidencia_fingerprint }, 'Caso tomado por vos.', 'tomar:' + caso().id); break;
        case 'relevar-abrir': recordarDisparador(el); S.adminForm = 'relevar'; renderDetalle(); enfocarPorSelector('#adm-motivo'); break;
        case 'nota-enviar': enviarNota(); break;
        case 'franja-lista':
          var lst = el.getAttribute('data-lista');
          S.franjaLista = S.franjaLista === lst ? null : lst;
          $$('[data-lista]').forEach(function (b) { b.setAttribute('aria-expanded', String(b.getAttribute('data-lista') === S.franjaLista)); });
          renderFranjaLista(); break;
        case 'ir-ejecucion': activarTab('ejecucion'); break;
        case 'ir-retenidas': activarTab('retenidas'); break;
        case 'ejec-ver-mas': verMasEjec(el.getAttribute('data-seccion')); break;
        case 'abrir-clave': abrirPorClave(el.getAttribute('data-clave')); break;
        case 'vinc-ml': abrirVinculoML(el.getAttribute('data-clave')); break;
        case 'vinc-revincular': irACaso(Number(el.getAttribute('data-caso')), false); break;
        case 'vinc-historial': irACaso(Number(el.getAttribute('data-caso')), true); break;
        case 'vinc-filtro': S.vincFiltro = el.getAttribute('data-filtro'); buscarVinculos($('#vinc-q').value); break;
        case 'vinc-ver-mas': verMasVinculos(); break;
        case 'ident-mover': identMover(Number(el.getAttribute('data-idx')), Number(el.getAttribute('data-dir'))); break;
        case 'ident-guardar': identGuardar(); break;
        case 'resolver': pedirConfirmacionResolver(el); break;
        case 'resolver-ok': if (S.confResolver) resolverConflicto({ accion: 'resolver', valor: S.confResolver.valor, producto: S.confResolver.ganador }); break;
        case 'resolver-cancelar':
          // Cancelar la confirmación no borra el motivo que ya escribió.
          if (S.confResolver) S.confMotivo = { valor: S.confResolver.valor, motivo: S.confResolver.motivo };
          S.confResolver = null; cargarConflictos(); break;
        case 'incorrecto':
          pedirConfirmacion({ titulo: 'Descartar este código', texto: '¿Descartar este código para ese producto? Los demás productos no cambian.', ok: 'Descartar', peligro: true, disparador: el,
            onOk: function () { resolverConflicto({ accion: 'incorrecto', valor: el.getAttribute('data-valor'), producto: el.getAttribute('data-producto') }); } });
          break;
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
        buscarCandidatos(q).then(function () { renderDetalle(); enfocarPorSelector('#det-q'); });
      } else if (f.getAttribute('data-accion') === 'admin-enviar') {
        ev.preventDefault();
        adminEnviar(f);
      } else if (f.getAttribute('data-accion') === 'liberar-enviar') {
        ev.preventDefault();
        liberarRetenida(f);
      } else if (f.getAttribute('data-accion') === 'vinc-revertir') {
        ev.preventDefault();
        revertirNS(f);
      } else if (f.id === 'exc-form') {
        excepcionEnviar(ev);
      } else if (f.id === 'ning-form') {
        ningunoEnviar(ev);
      } else if (f.id === 'rev-form') {
        revertirEnviar(ev);
      } else if (f.id === 'vinc-form') {
        ev.preventDefault();
        var v = $('#vinc-q').value.trim();
        buscarVinculos(v);
      }
    });

    // Diálogo: clic fuera cierra (solo en el fondo).
    $$('.cv-dialogo-fondo').forEach(function (fondo) {
      fondo.addEventListener('click', function (ev) { if (ev.target === fondo) intentarCerrarDialogo(); });
    });

    // Campo de motivo de admin: marca error al escribir.
    document.body.addEventListener('input', function (ev) {
      if (ev.target.id === 'adm-motivo' && ev.target.value.trim()) { $('#adm-err').hidden = true; }
    });

    $('#cv-detalle').addEventListener('toggle', function (e) { if (e.target.id === 'det-hist') S.histOpen = e.target.open; }, true);
    document.body.addEventListener('input', function (ev) { if (ev.target.id === 'nota-txt') S.notaTxt = ev.target.value; });
    document.body.addEventListener('change', function (ev) {
      if (ev.target.name === 'vinc-modo') { S.vincFiltro = 'all'; buscarVinculos($('#vinc-q').value); }
    });
    // Modo ML: búsqueda en vivo con debounce (Enter sigue buscando al instante). Producto Woo sigue solo con submit.
    document.body.addEventListener('input', function (ev) {
      if (ev.target.id !== 'vinc-q' || modoVinc() !== 'ml') return;
      clearTimeout(vincTimer);
      vincTimer = setTimeout(function () { buscarVinculos(ev.target.value.trim()); }, VINC_DEBOUNCE_MS);
    });
    window.addEventListener('offline', function () { setOffline(true); });
    window.addEventListener('online', function () { setOffline(false); cargarCola({ seleccionar: false }); });
    window.addEventListener('resize', function () { aplicarBloqueo(); aplicarModoLectura(); });
  }

  // Modo de escritura según ancho y permiso. Si cambia (p. ej. girar el celular), se vuelve a pintar lo que tiene acciones.
  function aplicarModoLectura() {
    $('#cv-leyenda-pc').hidden = window.innerWidth >= PUNTO_CORTE_PC;
    var ahora = puedeEscribir();
    if (S.modoEscribe === ahora) return;
    S.modoEscribe = ahora;
    if (S.detalle) renderDetalle();
    if (S.retenidas) renderRetenidas();
    if (S.ejec) renderEjecucion();
    if (S.vincPanel) renderVincPanel();
    if (S.conflictos) cargarConflictos();
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
    if (tipo === 'relevar') return accionCaso('/casos/' + c.id + '/relevar', { operation_id: opIdPara('relevar:' + c.id), expected_version: c.expected_version, evidence_fingerprint: c.evidencia_fingerprint, motivo: motivo }, 'Relevado: el caso pasó a vos.', 'relevar:' + c.id);
    var body; var ruta; var clave = null;
    if (tipo === 'confirmar') {
      if (!S.elegido) { err.textContent = 'Elegí un candidato antes de confirmar.'; err.hidden = false; return; }
      body = cuerpoVincular({ override_contradiccion: true, motivo: motivo });
      ruta = '/casos/' + c.id + '/decisiones';
      S.busy = 'vincular'; S.focoPendiente = '[data-accion="vincular"]'; renderDetalle();
      var candC = S.elegido;
      api('POST', ruta, body).then(function (r) {
        S.busy = null;
        if (r.ok) S.adminForm = null;
        resultadoVincular(c, candC.id, body, r, 'Guardado · Vinculado pese a la contradicción', candC);
      });
      return;
    }
    if (tipo === 'link') {
      body = { clave: c.ml_key, motivo: motivo, expected_sku: vinculoSku() };
      ruta = '/claves/link-de-pago';
    } else {
      // Destrabar: la operación en intervención es la que se destraba.
      var op = (S.ejecSnap && S.ejecSnap.operaciones || []).find(function (o) { return o.caso_id === c.id && o.estado === 'intervencion'; });
      if (!op) { err.textContent = 'No hay una operación en intervención para este caso.'; err.hidden = false; return; }
      body = Object.assign({ operation_id: opIdPara('destrabar:' + op.id), motivo: motivo }, camposVersion(op));
      ruta = '/operaciones/' + op.id + '/destrabar';
      clave = 'destrabar:' + op.id;
    }
    S.busy = tipo;
    api('POST', ruta, body).then(function (r) {
      S.busy = null;
      if (r.red) { err.textContent = MSG_ERROR_SIN_RED; err.hidden = false; return; }
      if (clave && r.status !== 409) soltarOpId(clave);
      if (r.status === 409) {
        err.textContent = mensajeDe(r) + ' Se recargó el caso: revisá y volvé a intentar.'; err.hidden = false;
        cargarEjecucion();
        return abrirCaso(c.id, { foco: false });
      }
      if (!r.ok) { err.textContent = mensajeDe(r); err.hidden = false; return; }
      S.adminForm = null;
      S.guardado = { caso: c.id, texto: tipo === 'link' ? 'Guardado · Link de pago' : 'Guardado · Destrabado' };
      anunciar(S.guardado.texto, 'estado');
      siguienteCaso();
    });
  }

  // expected_sku del servidor: el SKU del vínculo vigente (o null si no hay). Si no coincide, responde 409 vista_vieja.
  function vinculoSku() { return S.detalle && S.detalle.vinculo_vigente ? S.detalle.vinculo_vigente.sku : null; }

  // ── Toma, relevo, notas e historial ────────────────────────────────────────────────────────────
  function tomaHtml() {
    var c = caso(); var resp = c.responsable;
    var out;
    if (!resp) out = '<button type="button" class="ui-btn" data-accion="tomar">Tomar caso</button>';
    else if (resp !== S.usuario) out = '<span class="ui-label">Lo tiene ' + esc(resp) + '.</span> <button type="button" class="ui-btn" data-accion="relevar-abrir">Relevar</button>';
    else out = '<span class="ui-label">Lo tenés vos.</span>';
    if (S.adminForm === 'relevar') out += adminFormHtml();
    return '<div class="cv-acciones__fila">' + out + '</div>';
  }

  // Eventos de identidad_historial (lib/identidadProductos.js, lib/proteccionIdentidad.js…) en castellano.
  var EVENTO_TXT = { caso_salteado: 'Caso salteado', tomado: 'Caso tomado', relevado: 'Caso relevado', nota_agregada: 'Nota agregada',
    confirmar_igual: 'Confirmado igual', operacion_reintentada: 'Operación reintentada', operacion_destrabada: 'Operación destrabada',
    operacion_confirmada: 'Impacto confirmado', operacion_cancelada_por_omitir: 'Operación cancelada por no sincronizar',
    operacion_shadow_obsoleta_por_cambio_identidad: 'Operación obsoleta por cambio de identidad',
    identidad_verificada: 'Identidad verificada', identidad_no_sincronizar: 'Marcada como no sincronizar',
    identidad_ml_archivada: 'Publicación ML archivada', identidad_contradiccion: 'Contradicción de identidad',
    reactivada_con_identidad_invalida: 'Reactivada con identidad inválida', desvinculado: 'Desvinculado',
    vinculado_auto_seller_sku: 'Vinculado automáticamente por SKU', pedido_liberado: 'Pedido liberado',
    modo_cambiado: 'Modo cambiado', investigacion_iniciada: 'Investigación iniciada', impacto_hermanas_confirmado: 'Impacto en variaciones confirmado',
    contradiccion_titulo: 'Contradicción de título', gtin_en_conflicto: 'Código en conflicto', conflicto_gtin_resuelto: 'Conflicto de código resuelto',
    gtin_contradictorio_post_verificacion: 'Código contradictorio tras verificar', conflicto_post_ml: 'Conflicto tras escribir en ML',
    conflicto_pre_ml: 'Conflicto antes de escribir en ML', woo_baja_protegida: 'Baja en Woo protegida', stock_devuelto_por_contradiccion: 'Stock devuelto por contradicción',
    stock_no_devuelto_por_contradiccion: 'Stock no devuelto por contradicción', excepcion_vencida: 'Excepción vencida', excepcion_solo_ml: 'Excepción solo ML',
    reintento_solicitado: 'Reintento solicitado', matcher_push: 'Enviado al Matcher', lease_recuperado: 'Ejecución recuperada', cerrado_fuera_de_universo: 'Cerrado fuera de alcance' };
  function eventoTxt(e) {
    if (!e) return 'Movimiento';
    if (EVENTO_TXT[e]) return EVENTO_TXT[e];
    var t = String(e).replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function historialHtml() {
    var notas = (S.detalle && S.detalle.notas) || [];
    var filas = notas.map(function (h) {
      // Contrato: {evento, actor, creado_en, detalle}; en 'nota_agregada' trae nota_texto (string|null).
      // Si nota_texto es null, cae al texto que venga en el detalle. Todo sale escapado.
      var det = h.detalle;
      if (typeof det === 'string') { try { det = JSON.parse(det); } catch (e) { det = { texto: det }; } }
      det = det && typeof det === 'object' ? det : {};
      var texto = typeof h.nota_texto === 'string' && h.nota_texto ? h.nota_texto
        : (typeof det.nota_texto === 'string' && det.nota_texto ? det.nota_texto : (det.nota || det.texto || ''));
      return '<li><span class="ui-label">' + esc(fecha(h.creado_en)) + ' · ' + esc(h.actor || 'sistema') + '</span> ' + esc(eventoTxt(h.evento))
        + (texto ? '<p class="cv-hist__nota">' + esc(texto) + '</p>' : '') + '</li>';
    }).join('');
    return '<details id="det-hist" class="ui-mas cv-hist"' + (S.histOpen ? ' open' : '') + '><summary>Historial <kbd class="cv-kbd cv-kbd-pc" aria-hidden="true">h</kbd></summary>'
      + '<ol class="cv-hist__lista">' + (filas || '<li class="ui-resumen">Sin movimientos.</li>') + '</ol>'
      + (puedeEscribir()
        ? '<div class="cv-campo"><label class="ui-label" for="nota-txt">Agregar nota</label>'
          + '<textarea id="nota-txt" class="ui-input" rows="2"></textarea>'
          + (S.notaError ? '<p class="cv-error" role="alert">' + esc(S.notaError) + '</p>' : '')
          + '<div class="cv-acciones__fila"><button type="button" class="ui-btn" data-accion="nota-enviar" aria-disabled="' + !!S.busy + '">Guardar nota</button></div></div>'
        : '')
      + '</details>';
  }

  function listaHermanas(max) {
    var l = (S.detalle && S.detalle.hermanas_item) || [];
    if (!l.length) return '';
    var vis = max ? l.slice(0, max) : l;
    var resto = l.slice(vis.length);
    var li = function (h) {
      return '<li><span class="ui-id">' + esc(h.clave) + '</span> ' + esc(h.titulo || '') + ' <span class="ui-label">' + esc(estadoMlTxt(h.status)) + ' · '
        + esc(h.available_quantity == null ? 'sin stock' : h.available_quantity + ' en stock') + '</span></li>';
    };
    return '<ul class="cv-lista-hermanas">' + vis.map(li).join('') + '</ul>'
      + (resto.length ? '<details class="ui-mas"><summary>y ' + resto.length + ' más</summary><ul class="cv-lista-hermanas">' + resto.map(li).join('') + '</ul></details>' : '');
  }

  // Acción sobre el caso con operation_id: "Guardado" solo tras la respuesta exitosa.
  function accionCaso(ruta, body, texto, clave) {
    var c = caso(); if (!c || !puedeEscribir() || S.busy || S.offline) return Promise.resolve();
    S.busy = 'accion'; S.accionError = null; renderDetalle();
    return api('POST', ruta, body).then(function (r) {
      S.busy = null;
      if (r.red) { setErrorAccion(MSG_ERROR_SIN_RED); return renderDetalle(); }
      if (clave) soltarOpId(clave);
      if (r.ok) { limpiarDeshacer(); S.guardado = { caso: c.id, texto: texto }; S.adminForm = null; S.notaTxt = ''; S.notaError = null; S.focoPendiente = S.dispSel || '#det-titulo'; S.dispSel = null; cargarConteos(); return abrirCaso(c.id, { foco: false }); }
      if (r.status === 409 && (r.data.code === 'VERSION_CONFLICT' || r.data.code === 'EVIDENCE_CONFLICT')) {
        return abrirCaso(c.id, { foco: false }).then(function () { setErrorAccion(mensajeDe(r)); renderDetalle(); });
      }
      // Nota sin matcher:write (llegó igual el 403): el error va junto al campo de la nota.
      if (r.status === 403 && clave && clave.indexOf('nota:') === 0) {
        S.notaError = MSG_SIN_PERMISO; S.accionError = null; S.focoPendiente = '#nota-txt'; return renderDetalle();
      }
      setErrorAccion(mensajeDe(r)); renderDetalle();
    });
  }

  function enviarNota() {
    var c = caso(); if (!c) return;
    var txt = (S.notaTxt || '').trim();
    if (!txt) { S.notaError = 'Falta el texto de la nota.'; return renderDetalle(); }
    S.notaError = null;
    return accionCaso('/casos/' + c.id + '/notas', { operation_id: opIdPara('nota:' + c.id), nota: txt, expected_version: c.expected_version, evidence_fingerprint: c.evidencia_fingerprint }, 'Nota guardada.', 'nota:' + c.id);
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
      S.usuario = d.user || null;
      S.canWrite = S.isAdmin || (d.permisos || []).some(function (p) { return p.herramienta === 'matcher' && p.nivel === 'write'; });
      document.body.classList.toggle('cv-admin', S.isAdmin);
      aplicarModoLectura();
      actualizarContadoresIniciales();
      activarTab('casos');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
