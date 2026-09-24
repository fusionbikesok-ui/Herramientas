/**
 * public/bandeja-identidad/bandeja.js — pantalla de la bandeja de identidad (E3).
 * Spec: docs/superpowers/specs/2026-09-24-e3-bandeja-interfaz.md y ...-flujo-ux.md.
 * Todo dato de la API entra al DOM con textContent (nunca innerHTML). La lógica pura vive en logica.js.
 */
(function () {
  'use strict';
  var L = window.BandejaLogica;
  var API = '/api/bandeja-identidad';
  var PAGINA = 50;

  // ───────────────────────── estado ─────────────────────────
  var S = {
    grupo: null,            // filtro activo: null o 0..4
    cola: [], siguiente: null, cargandoMas: false,
    contadores: {}, totalInicial: 0, hechos: 0,
    idx: -1, detalle: null, sel: null, busqueda: [], buscando: false, soloDif: false,
    conflicto: null,        // { entry, details } tras un 409
    cache: new Map(),       // id de caso → Promise del detalle
    pendientes: new Map(),  // Idempotency-Key → entry (guardado en segundo plano)
    ultima: null,           // { entry, ts, consumida } para deshacer
    atajos: leerAtajos(), navToken: 0, timerDeshacer: null, timerBusqueda: null
  };

  function leerAtajos() { try { return localStorage.getItem('bandeja-atajos') !== 'false'; } catch (e) { return true; } }
  function guardarAtajos(v) { try { localStorage.setItem('bandeja-atajos', v ? 'true' : 'false'); } catch (e) { /* sin storage */ } }

  // ───────────────────────── DOM utilitario ─────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, texto, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texto !== undefined && texto !== null) n.textContent = texto;
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function vaciar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function anunciar(texto) { var a = $('anuncio'); if (a) a.textContent = texto; }

  // Avisos persistentes (no son toasts): quedan hasta que se resuelven o se cierran.
  function aviso(clave, texto, acciones) {
    quitarAviso(clave);
    var n = el('div', 'aviso-persistente', null, { role: 'alert', 'data-clave': clave });
    n.appendChild(el('span', 'aviso-texto', texto));
    (acciones || []).forEach(function (a) {
      var b = el('button', 'btn', a.texto, { type: 'button' });
      b.addEventListener('click', a.alClick);
      n.appendChild(b);
    });
    var x = el('button', 'btn', 'Cerrar', { type: 'button', 'aria-label': 'Cerrar aviso' });
    x.addEventListener('click', function () { quitarAviso(clave); });
    n.appendChild(x);
    $('avisos').appendChild(n);
    return n;
  }
  function quitarAviso(clave) {
    var v = $('avisos').querySelector('[data-clave="' + clave + '"]');
    if (v) v.parentNode.removeChild(v);
  }

  // ───────────────────────── red ─────────────────────────
  // Devuelve siempre {status, data}; status 0 = sin red. El 401 lo redirige el override de Api.installAuth().
  function http(metodo, ruta, cuerpo, clave) {
    var h = {};
    var o = { method: metodo, credentials: 'include', headers: h };
    if (cuerpo !== undefined) { h['Content-Type'] = 'application/json'; o.body = JSON.stringify(cuerpo); }
    if (clave) h['Idempotency-Key'] = clave;
    return fetch(API + ruta, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; });
    }, function () { return { status: 0, data: {} }; });
  }
  function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esperarRed() {
    if (navigator.onLine) return Promise.resolve();
    return new Promise(function (r) { window.addEventListener('online', function f() { window.removeEventListener('online', f); r(); }); });
  }

  // ───────────────────────── cola y detalle ─────────────────────────
  function rutaCola(cursor) {
    var p = new URLSearchParams();
    p.set('limit', String(PAGINA));
    if (S.grupo !== null) p.set('grupo', String(S.grupo));
    if (cursor) p.set('cursor', cursor);
    return '/casos?' + p.toString();
  }

  function cargarCola() {
    S.navToken++;
    quitarAviso('carga');
    mostrarEstado('Cargando casos…', 'status');
    return http('GET', rutaCola(null)).then(function (r) {
      if (r.status !== 200) return falloCarga(r);
      S.cola = r.data.casos || []; S.siguiente = r.data.siguiente || null; S.contadores = r.data.contadores || {};
      S.totalInicial = L.totalFiltro(S.contadores, S.grupo); S.hechos = 0;
      pintarChips();
      if (!S.cola.length) return vacio();
      return abrirCaso(0, { foco: true });
    });
  }

  function falloCarga(r) {
    var msg = r.status === 0 ? 'Sin conexión.' : L.copyError((r.data && r.data.code) || 'plataforma_no_responde');
    vaciar($('root'));
    var b = aviso('carga', 'No pudimos cargar los casos. ' + msg, [{ texto: 'Reintentar', alClick: function () { cargarCola(); } }]);
    var btn = b.querySelector('.btn'); if (btn) btn.focus();
    if (r.data && r.data.code === 'bandeja_apagada') anunciar('La bandeja está apagada por ahora');
  }

  function vacio() {
    S.idx = -1; S.detalle = null;
    var root = $('root'); vaciar(root);
    var d = el('div', 'api-estado api-estado--vacio', null, { role: 'status', tabindex: '-1', id: 'caso-focus' });
    d.appendChild(el('p', null, 'No quedan casos en este filtro'));
    root.appendChild(d);
    var primero = null;
    document.querySelectorAll('.chip-pri[data-filtro]').forEach(function (c) {
      if (!primero && c.getAttribute('aria-pressed') !== 'true' && Number(c.querySelector('.contador').textContent) > 0) primero = c;
    });
    (primero || d).focus();
    banda();
  }

  function mostrarEstado(texto, rol) {
    var root = $('root'); vaciar(root);
    var d = el('div', 'api-estado api-estado--cargando', null, { role: rol });
    d.appendChild(el('p', null, texto));
    root.appendChild(d);
  }

  function traerMas() {
    if (!S.siguiente || S.cargandoMas) return;
    S.cargandoMas = true;
    var grupoAlPedir = S.grupo;
    http('GET', rutaCola(S.siguiente)).then(function (r) {
      S.cargandoMas = false;
      if (r.status !== 200 || grupoAlPedir !== S.grupo) return;
      var ya = {}; S.cola.forEach(function (c) { ya[c.id] = true; });
      (r.data.casos || []).forEach(function (c) { if (!ya[c.id]) S.cola.push(c); });
      S.siguiente = r.data.siguiente || null;
      banda();
    });
  }

  function detalleDe(id) {
    if (!S.cache.has(id)) {
      var p = http('GET', '/casos/' + encodeURIComponent(id)).then(function (r) {
        if (r.status !== 200) { S.cache.delete(id); var e = new Error('detalle'); e.res = r; throw e; }
        return r.data;
      });
      p.catch(function () { S.cache.delete(id); });
      S.cache.set(id, p);
    }
    return S.cache.get(id);
  }

  // Precarga: detalle de los vecinos, fotos del siguiente, y la próxima página de la cola cuando quedan pocos.
  function precargar() {
    [S.idx + 1, S.idx + 2, S.idx - 1].forEach(function (i, n) {
      var c = S.cola[i];
      if (!c) return;
      detalleDe(c.id).then(function (d) {
        if (n === 0) (d.candidatos || []).forEach(function (o) { if (o.foto) { var im = new Image(); im.src = o.foto; } });
      }, function () { /* se reintenta al abrir */ });
    });
    if (S.siguiente && S.cola.length - S.idx <= 10) traerMas();
  }

  function abrirCaso(i, opts) {
    opts = opts || {};
    var caso = S.cola[i];
    if (!caso) return Promise.resolve();
    var token = ++S.navToken;
    S.idx = i;
    var listo = S.cache.has(caso.id);
    if (!listo) mostrarEstado('Cargando caso…', 'status');
    return detalleDe(caso.id).then(function (d) {
      if (token !== S.navToken) return;
      if (d.cerrado_en) { anunciar('Ese caso ya se resolvió. Pasamos al siguiente.'); S.cola.splice(i, 1); return S.cola.length ? abrirCaso(Math.min(i, S.cola.length - 1), opts) : vacio(); }
      S.detalle = d; S.busqueda = []; S.buscando = false;
      if (opts.sel !== undefined) S.sel = opts.sel; else S.sel = null;
      if (!opts.conservarConflicto) S.conflicto = null;
      render();
      var activo = document.activeElement;
      var escribiendo = activo && (activo.tagName === 'INPUT' || activo.tagName === 'TEXTAREA');
      if (opts.foco && !escribiendo) { var h = $('caso-focus'); if (h) h.focus(); }
      anunciar('Caso ' + (S.hechos + 1) + ' de ' + Math.max(S.totalInicial, S.hechos + 1));
      banda();
      precargar();
    }, function (e) {
      if (token !== S.navToken) return;
      failDetalle(e, i);
    });
  }

  function failDetalle(e, i) {
    vaciar($('root'));
    var r = (e && e.res) || { status: 0, data: {} };
    var msg = r.status === 404 ? L.copyError('caso_inexistente') : 'No pudimos cargar este caso.';
    var acc = r.status === 404
      ? [{ texto: 'Ir al siguiente', alClick: function () { quitarAviso('detalle'); S.cola.splice(i, 1); S.cola.length ? abrirCaso(Math.min(i, S.cola.length - 1), { foco: true }) : vacio(); } }]
      : [{ texto: 'Reintentar', alClick: function () { quitarAviso('detalle'); abrirCaso(i, { foco: true }); } }];
    var b = aviso('detalle', msg, acc);
    var btn = b.querySelector('.btn'); if (btn) btn.focus();
  }

  function ir(delta) {
    var i = S.idx + delta;
    if (i < 0 || i >= S.cola.length) return;
    abrirCaso(i, { foco: true });
  }

  function avanzar() {
    if (S.idx + 1 < S.cola.length) return abrirCaso(S.idx + 1, { foco: true });
    if (S.siguiente) {
      return http('GET', rutaCola(S.siguiente)).then(function (r) {
        if (r.status !== 200) return falloCarga(r);
        S.cola = S.cola.concat(r.data.casos || []); S.siguiente = r.data.siguiente || null;
        return S.idx + 1 < S.cola.length ? abrirCaso(S.idx + 1, { foco: true }) : vacio();
      });
    }
    return vacio();
  }

  // ───────────────────────── decidir (segundo plano) ─────────────────────────
  function marcasDe(o) {
    var e = (o && o.explicacion) || {};
    return (e.atributos || []).concat(e.otros_atributos || []).map(function (a) { return a.nombre + ':' + a.marca; }).sort().join('|');
  }

  // Reintenta red/5xx/429 con backoff y jitter hasta L.MAX_INTENTOS; devuelve la última respuesta (definitiva o agotada).
  function conReintentos(hacer, alReintentar) {
    function intento(n) {
      return hacer().then(function (r) {
        if (!L.esReintentable(r.status) || n + 1 >= L.MAX_INTENTOS) return r;
        if (alReintentar) alReintentar(n + 1);
        return esperar(L.demora(n)).then(esperarRed).then(function () { return intento(n + 1); });
      });
    }
    return intento(0);
  }

  function enviar(entry) {
    var ruta = '/casos/' + encodeURIComponent(entry.casoId) + '/decisiones';
    return conReintentos(function () { return http('POST', ruta, entry.cuerpo, entry.key); },
      function (n) { entry.reintentos = n; banda(); });
  }

  function decidir(eleccion, variantId, motivo, confirmar) {
    var d = S.detalle;
    if (!d) return;
    if (eleccion === 'vincular' && !variantId) {
      aviso('elegir', 'Elegí un candidato antes de vincular.');
      return;
    }
    quitarAviso('elegir'); quitarAviso('rechazo');
    var opcion = variantId ? L.opcionesDe(d.candidatos, S.busqueda).filter(function (o) { return o.variant_id === variantId; })[0] : null;
    // Confirmar (punto A): la variante no está en candidatos/búsqueda — el SKU viene de cs.confirmar, guardado
    // al armar el botón (ver disparaConfirmar). Sin esto, el chip de "vinculado a" en el aviso de deshacer
    // quedaría con SKU null aunque la decisión en sí es correcta.
    var skuConfirmado = confirmar && !opcion ? (S.cola[S.idx] && S.cola[S.idx].confirmar && S.cola[S.idx].confirmar.sku) : null;
    var cuerpo = { expected_version: d.version, eleccion: eleccion };
    if (eleccion === 'vincular') cuerpo.variant_id = variantId;
    if (motivo) cuerpo.motivo = motivo;
    if (confirmar) cuerpo.confirmar = true;
    var entry = {
      key: crypto.randomUUID(), casoId: d.id, cuerpo: cuerpo, eleccion: eleccion, variantId: variantId || null,
      marcas: opcion ? marcasDe(opcion) : '', sku: opcion ? opcion.sku : skuConfirmado, estado: 'pendiente', reintentos: 0
    };
    // Sin `actor`: el usuario y es_admin los pone el proxy desde la sesión, nunca el cliente.
    S.pendientes.set(entry.key, entry);
    entry.promise = enviar(entry).then(function (r) { alTerminar(entry, r); return entry; });
    S.ultima = { entry: entry, ts: Date.now(), consumida: false };
    S.hechos++;
    mostrarDeshacer(textoDecision(entry));
    banda();
    avanzar();
  }

  // Punto A: confirmar el SKU que el caso ya trae vinculado (grupo 5), sin pasar por el buscador de
  // candidatos. cs.confirmar viene de la fila de cola (GET /casos), no del detalle.
  function confirmarCasoActual() {
    var cs = S.cola[S.idx];
    if (!cs || !cs.confirmar) return;
    decidir('vincular', cs.confirmar.variant_id, undefined, true);
  }

  function textoDecision(e) {
    if (e.eleccion === 'vincular') return 'Vinculado a ' + (e.sku || 'la variante elegida') + '.';
    if (e.eleccion === 'omitir') return 'Caso omitido.';
    if (e.eleccion === 'mantener_omision') return 'Se mantiene la omisión.';
    return 'Marcado como «no existe en el catálogo».';
  }

  function alTerminar(entry, r) {
    if (r.status === 200 || !L.esReintentable(r.status)) S.pendientes.delete(entry.key);
    if (r.status === 200) {
      entry.estado = 'ok'; entry.decisionId = r.data.decision_id; entry.versionNueva = r.data.version;
      anunciar('Guardado'); banda(); return;
    }
    if (L.esReintentable(r.status)) return fallido(entry);
    entry.estado = 'error';
    S.hechos = Math.max(0, S.hechos - 1);
    banda();
    var code = (r.data && r.data.code) || 'plataforma_no_responde';
    if (code === 'caso_cerrado') { aviso('rechazo', L.copyError(code)); return; }
    var i = S.cola.findIndex(function (c) { return c.id === entry.casoId; });
    S.cache.delete(entry.casoId);
    if (code === 'version_conflict') {
      aviso('rechazo', L.copyError(code));
      if (i >= 0) { S.conflicto = { entry: entry, details: r.data.details || null }; abrirCaso(i, { foco: true, conservarConflicto: true, sel: entry.variantId }); }
      return;
    }
    aviso('rechazo', L.copyError(code) + (i >= 0 ? ' Volvemos a ese caso.' : ''));
    if (i >= 0) abrirCaso(i, { foco: true, sel: entry.variantId });
  }

  // Estado terminal tras agotar los reintentos: la decisión sigue pendiente (con su misma clave) y el operador decide.
  function fallido(entry) {
    entry.estado = 'fallido'; entry.reintentos = 0; banda();
    var b = aviso('fallo-' + entry.key, 'No se pudo guardar la decisión (' + textoDecision(entry).replace(/\.$/, '') + '). Tu elección se conserva.', [{
      texto: 'Reintentar', alClick: function () {
        quitarAviso('fallo-' + entry.key); entry.estado = 'pendiente';
        entry.promise = enviar(entry).then(function (r) { alTerminar(entry, r); return entry; });
        banda();
      }
    }]);
    var btn = b.querySelector('.btn'); if (btn) btn.focus();
  }

  function aplicarSobreNueva() {
    var c = S.conflicto; if (!c) return;
    var e = c.entry, d = S.detalle;
    quitarAviso('rechazo');
    if (e.eleccion === 'vincular') {
      var o = L.opcionesDe(d.candidatos, S.busqueda).filter(function (x) { return x.variant_id === e.variantId; })[0];
      if (!o || marcasDe(o) !== e.marcas) {
        S.conflicto = null; S.sel = o ? o.variant_id : null; render();
        aviso('rechazo', 'El candidato elegido cambió o ya no está. Revisá de nuevo la matriz.');
        var h = $('caso-focus'); if (h) h.focus();
        return;
      }
    }
    S.conflicto = null;
    decidir(e.eleccion, e.variantId);
  }

  // ───────────────────────── deshacer ─────────────────────────
  function mostrarDeshacer(texto) {
    var a = $('aviso-deshacer');
    $('aviso-deshacer-texto').textContent = texto + ' Podés deshacerlo unos segundos.';
    a.classList.remove('aviso-deshacer--oculto');
    var barra = a.querySelector('.aviso-deshacer-barra');
    if (barra) { barra.style.animation = 'none'; void barra.offsetWidth; barra.style.animation = ''; }
    clearTimeout(S.timerDeshacer);
    S.timerDeshacer = setTimeout(function () { a.classList.add('aviso-deshacer--oculto'); }, L.VENTANA_DESHACER_MS);
  }

  function deshacer() {
    var u = S.ultima;
    if (!L.puedeDeshacer(u, Date.now())) { aviso('deshacer', 'No hay nada para deshacer.'); return; }
    quitarAviso('deshacer');
    u.consumida = true;
    $('aviso-deshacer').classList.add('aviso-deshacer--oculto');
    anunciar('Deshaciendo…');
    // P3: el revierte necesita el decision_id, que llega con el 200; si el guardado sigue en vuelo, se espera.
    u.entry.promise.then(function (e) {
      if (e.estado === 'fallido') { u.consumida = false; aviso('rechazo', 'No se pudo deshacer: la decisión todavía no se guardó.'); return; }
      if (e.estado !== 'ok') return; // ya se avisó el rechazo y se volvió a ese caso
      if (Date.now() - u.ts > L.VENTANA_DESHACER_MS) { aviso('rechazo', 'No se pudo deshacer: el guardado tardó más que el tiempo para deshacer.'); return; }
      u.claveDeshacer = u.claveDeshacer || crypto.randomUUID(); // una sola clave por intento de deshacer: el reintento devuelve lo mismo
      var cuerpo = { expected_version: e.versionNueva, eleccion: 'sin_candidato', revierte: e.decisionId };
      return conReintentos(function () { return http('POST', '/casos/' + encodeURIComponent(e.casoId) + '/decisiones', cuerpo, u.claveDeshacer); })
        .then(function (r) {
          var i = S.cola.findIndex(function (c) { return c.id === e.casoId; });
          if (r.status === 200) {
            S.hechos = Math.max(0, S.hechos - 1); S.cache.delete(e.casoId);
            anunciar('Decisión deshecha');
            if (i >= 0) return abrirCaso(i, { foco: true, sel: e.variantId });
            return;
          }
          if (L.esReintentable(r.status)) { u.consumida = false; aviso('rechazo', 'No se pudo deshacer: sin respuesta de la plataforma. Probá de nuevo con z.'); return; }
          aviso('rechazo', L.copyError((r.data && r.data.code) || 'plataforma_no_responde'));
        });
    });
  }

  // ───────────────────────── búsqueda de otra variante ─────────────────────────
  function abrirBusqueda() {
    S.buscando = true; render();
    $('input-buscar').focus();
    anunciar('Buscar variante. Escribí SKU o título; Esc vuelve al caso.');
  }
  function cerrarBusqueda() {
    S.buscando = false; S.busqueda = []; render();
    var h = $('caso-focus'); if (h) h.focus();
  }
  function buscar(q) {
    clearTimeout(S.timerBusqueda);
    if (q.trim().length < 2) { S.busqueda = []; render(); return; }
    S.timerBusqueda = setTimeout(function () {
      http('GET', '/variantes?q=' + encodeURIComponent(q.trim())).then(function (r) {
        if ($('input-buscar') && $('input-buscar').value.trim() !== q.trim()) return;
        S.busqueda = r.status === 200 ? (r.data.variantes || []) : [];
        render();
        anunciar(S.busqueda.length + ' resultados');
        if (r.status !== 200) aviso('busqueda', 'No pudimos buscar. Probá de nuevo.');
      });
    }, 250);
  }

  // ───────────────────────── render ─────────────────────────
  function celdaAtributo(opcion, nombre) {
    var c = el('div', 'celda');
    var a = L.atributoDe(opcion, nombre);
    if (!a) { c.textContent = '—'; return c; }
    var m = L.marca(a.marca);
    var s = el('span', 'mk ' + m.clase);
    s.appendChild(el('span', null, m.simbolo, { 'aria-hidden': 'true' }));
    s.appendChild(el('span', null, ' ' + m.texto));
    c.appendChild(s);
    var orig = a.valorCandidatoOriginal !== undefined ? a.valorCandidatoOriginal : a.valorCandidato;
    var origMl = a.valorMlOriginal !== undefined ? a.valorMlOriginal : a.valorMl;
    if (orig) c.appendChild(el('div', 'valor', orig));
    if ((a.marca === 'difiere' || a.marca === 'equivalente') && origMl) c.appendChild(el('div', 'valor-ml', 'ML dice: ' + origMl));
    return c;
  }

  function celdaFija(opcion, tipo, esMl, caso) {
    var c = el('div', 'celda');
    var src = esMl ? { titulo: caso.publicacion.titulo, sku: caso.publicacion.sku_observado, precio: caso.publicacion.precio, moneda: caso.publicacion.moneda, stock: caso.publicacion.stock, foto: null } : opcion;
    if (tipo === 'foto') {
      if (src.foto) {
        var b = el('button', 'foto-btn', null, { type: 'button', 'data-foto-url': src.foto, 'data-foto-titulo': src.titulo || '', 'data-foto-sku': src.sku || '', 'aria-label': 'Ampliar foto de ' + (src.titulo || 'la variante') });
        var im = el('img', null, null, { alt: '', loading: 'lazy' }); im.src = src.foto; b.appendChild(im); c.appendChild(b);
      } else c.appendChild(el('div', 'foto-sin-disponible', esMl ? 'Sin foto ML' : 'Sin foto'));
    } else if (tipo === 'titulo') c.appendChild(el('strong', null, src.titulo || 'Sin título'));
    else if (tipo === 'sku') c.appendChild(el('code', 'sku', src.sku || 'Sin SKU'));
    else { c.appendChild(el('span', null, L.formatoPrecio(src.precio, src.moneda))); c.appendChild(el('br')); c.appendChild(el('small', null, L.formatoStock(src.stock))); }
    return c;
  }

  function renderMatriz(caso, opciones) {
    var m = el('div', 'matriz', null, { role: 'table', 'aria-label': 'Comparación de la publicación con cada candidato' });
    // Columnas exactas (etiqueta + ML + una por opción): con auto-fit sobraban pistas vacías y se corrían las celdas.
    m.style.gridTemplateColumns = 'minmax(min(8rem, 100%), 0.6fr) repeat(' + (opciones.length + 1) + ', minmax(min(var(--col-min), 100%), 1fr))';
    var enc = el('div', 'fila fila-encabezado', null, { role: 'row' });
    enc.appendChild(el('div', 'celda', 'Atributo', { role: 'columnheader' }));
    enc.appendChild(el('div', 'celda', 'Publicación ML', { role: 'columnheader' }));
    var nCand = (caso.candidatos || []).length;
    opciones.forEach(function (o, i) {
      enc.appendChild(el('div', 'celda', i < nCand ? 'Candidato ' + (i + 1) : 'Búsqueda ' + (i - nCand + 1), { role: 'columnheader' }));
    });
    m.appendChild(enc);
    var fijos = [['foto', 'Foto'], ['titulo', 'Título'], ['sku', 'SKU'], ['precio', 'Precio y stock']];
    fijos.forEach(function (f) {
      var fila = el('div', 'fila', null, { role: 'row' });
      fila.appendChild(el('div', 'celda-etiqueta', f[1], { role: 'rowheader' }));
      fila.appendChild(celdaFija(null, f[0], true, caso));
      opciones.forEach(function (o) { fila.appendChild(celdaFija(o, f[0], false, caso)); });
      m.appendChild(fila);
    });
    L.nombresAtributos(opciones).forEach(function (n) {
      if (!L.filaVisible(opciones, n, S.soloDif)) return;
      var fila = el('div', 'fila', null, { role: 'row' });
      fila.appendChild(el('div', 'celda-etiqueta', n, { role: 'rowheader' }));
      var pub = caso.publicacion.atributos && caso.publicacion.atributos[n];
      fila.appendChild(el('div', 'celda', pub ? String(pub) : '—'));
      opciones.forEach(function (o) { fila.appendChild(celdaAtributo(o, n)); });
      m.appendChild(fila);
    });
    var titulos = Array.prototype.map.call(enc.children, function (c) { return c.textContent; });
    m.querySelectorAll('.fila:not(.fila-encabezado)').forEach(function (f) {
      Array.prototype.forEach.call(f.children, function (c, i) { if (i >= 1) c.setAttribute('data-col', titulos[i]); });
    });
    m.querySelectorAll('.celda:not([role])').forEach(function (c) { c.setAttribute('role', 'cell'); });
    return m;
  }

  function render() {
    var d = S.detalle, root = $('root');
    var enfocado = document.activeElement && document.activeElement.id;
    vaciar(root);
    if (!d) return;

    if (S.conflicto) {
      var av = el('div', 'aviso-conflicto', null, { role: 'alert' });
      av.appendChild(el('span', null, '⚠ Este caso cambió mientras lo revisabas; tu elección se conserva.'));
      var bt = el('button', 'btn btn--primary', 'Aplicar mi decisión sobre la versión nueva', { type: 'button', id: 'btn-aplicar' });
      av.appendChild(bt); root.appendChild(av);
    }

    var opciones = L.opcionesDe(d.candidatos, S.busqueda);
    var head = el('div', 'caso-header', null, { tabindex: '-1', id: 'caso-focus' });
    head.appendChild(el('div', 'caso-id', 'Caso ' + Math.min(S.hechos + 1, Math.max(S.totalInicial, S.hechos + 1)) + ' de ' + Math.max(S.totalInicial, S.hechos + 1) + ' · ' + (d.candidatos || []).length + ' candidatos'));
    head.appendChild(el('h1', 'caso-titulo', (d.publicacion && d.publicacion.titulo) || 'Sin título'));
    var cs = S.cola[S.idx];
    var grupoTxt = cs && cs.grupo !== undefined ? L.GRUPO_NOMBRE[cs.grupo] : 'Resto';
    head.appendChild(el('p', 'caso-prioridad', 'Prioridad: ' + grupoTxt));
    if (d.publicacion && d.publicacion.link_ml) {
      var lk = el('a', null, 'Ver publicación en MercadoLibre', { href: d.publicacion.link_ml, target: '_blank', rel: 'noopener noreferrer' });
      head.appendChild(lk);
    }
    root.appendChild(head);

    if (!d.publicacion) { root.appendChild(el('div', 'api-estado api-estado--error', L.copyError('caso_sin_publicacion'))); return; }

    if (S.buscando) {
      var b = el('div', 'buscador-variantes');
      var inp = el('input', 'buscador-input', null, { type: 'search', id: 'input-buscar', placeholder: 'Buscar por SKU o título (Esc vuelve al caso)', 'aria-label': 'Buscar otra variante' });
      inp.value = S.consulta || '';
      b.appendChild(inp); root.appendChild(b);
    }

    root.appendChild(renderMatriz(d, opciones));

    if (opciones.length) {
      var fs = el('fieldset', 'candidatos');
      fs.appendChild(el('legend', 'candidatos-legend', 'Elegí la variante (teclas 1, 2, 3…)'));
      opciones.forEach(function (o, i) {
        var box = el('div', 'cand');
        var h = el('div', 'cand-header');
        var rid = 'radio-' + i;
        var r = el('input', null, null, { type: 'radio', id: rid, name: 'candidato', 'aria-keyshortcuts': String(i + 1) });
        r.value = o.variant_id; r.checked = S.sel === o.variant_id;
        h.appendChild(r);
        var lb = el('label', null, null, { for: rid });
        lb.appendChild(el('span', 'cand-rank', i < (d.candidatos || []).length ? (i + 1) + '.º sugerido' : 'De la búsqueda'));
        lb.appendChild(el('br'));
        lb.appendChild(el('span', 'cand-titulo', o.titulo || 'Sin título'));
        lb.appendChild(el('br'));
        lb.appendChild(el('code', 'sku', o.sku || 'Sin SKU'));
        lb.appendChild(el('span', 'cand-sel', ' — Seleccionado'));
        h.appendChild(lb); box.appendChild(h);
        if (d.auto_sku_en_sombra && d.auto_sku_en_sombra.sku && d.auto_sku_en_sombra.sku === o.sku) {
          box.appendChild(el('p', 'sugerencia-sistema', '✓ Sugerencia del sistema (SKU exacto en sombra)'));
        }
        fs.appendChild(box);
      });
      root.appendChild(fs);
    }

    var ac = el('div', 'acciones');
    // Punto A: caso confirmable (grupo 5, cs.confirmar trae variant_id/sku de la fila de cola) — un solo
    // botón, sin buscar candidatos. Si por algo raro también hubiera candidatos, "Vincular" sigue disponible;
    // Enter dispara "Confirmar" primero (ver disparaAtajo), porque es la acción principal de ese caso.
    if (cs && cs.confirmar) {
      var btnConf = el('button', 'btn btn--primary', 'Confirmar ' + (cs.confirmar.sku || 'SKU vinculado') + ' (Enter)',
        { type: 'button', id: 'btn-confirmar' });
      ac.appendChild(btnConf);
    }
    if (opciones.length) ac.appendChild(el('button', 'btn btn--primary', 'Vincular al seleccionado (Enter)', { type: 'button', id: 'btn-vincular' }));
    var omisionVigente = d.detalle && d.detalle.d5 === true;
    if (omisionVigente) ac.appendChild(el('button', 'btn', 'Mantener la omisión', { type: 'button', id: 'btn-mantener' }));
    ac.appendChild(el('button', 'btn', 'Omitir (s)', { type: 'button', id: 'btn-omitir' }));
    ac.appendChild(el('button', 'btn', 'No existe en el catálogo (n)', { type: 'button', id: 'btn-no-existe' }));
    ac.appendChild(el('button', 'btn', 'Buscar otra variante (/)', { type: 'button', id: 'btn-buscar' }));
    ac.appendChild(el('button', 'btn', S.soloDif ? 'Mostrar todas las filas (d)' : 'Sólo diferencias (d)', { type: 'button', id: 'btn-dif', 'aria-pressed': S.soloDif ? 'true' : 'false' }));
    root.appendChild(ac);

    var hist = d.historial || [];
    if (hist.length) {
      var dh = el('details', 'historial', null, { id: 'historial' });
      dh.appendChild(el('summary', 'historial-titulo', 'Historial (h)'));
      hist.forEach(function (h) {
        var it = el('div', 'historial-item');
        var meta = el('div', 'historial-meta');
        meta.appendChild(el('span', 'historial-actor', h.actor || h.origen));
        meta.appendChild(el('span', 'historial-fecha', new Date(h.creado_en).toLocaleString('es-AR')));
        it.appendChild(meta);
        it.appendChild(el('div', 'historial-accion', [h.origen, h.efecto, h.eleccion, h.sku].filter(Boolean).join(' · ') + (h.motivo ? ' — ' + h.motivo : '')));
        dh.appendChild(it);
      });
      root.appendChild(dh);
    }
    var evid = d.evidencia || [];
    if (evid.length) {
      var de = el('details', 'evidencia');
      de.appendChild(el('summary', 'evidencia-titulo', 'Evidencia'));
      evid.forEach(function (ev) {
        var it = el('div', 'evidencia-item');
        it.appendChild(el('span', 'evidencia-fuente', ev.fuente));
        it.appendChild(el('span', 'evidencia-fecha', ' ' + new Date(ev.observado_en).toLocaleString('es-AR')));
        it.appendChild(el('div', 'evidencia-campos', JSON.stringify(ev.campos)));
        de.appendChild(it);
      });
      root.appendChild(de);
    }
    if (enfocado === 'input-buscar' && $('input-buscar')) $('input-buscar').focus();
  }

  function banda() {
    var b = $('banda'); if (!b) return;
    var pend = S.pendientes.size;
    var partes = [];
    partes.push(pend ? pend + (pend === 1 ? ' decisión sin guardar' : ' decisiones sin guardar') : 'Todo guardado');
    var reint = 0; S.pendientes.forEach(function (e) { if (e.reintentos) reint++; });
    if (reint) partes.push('reintentando…');
    b.textContent = partes.join(' · ');
    b.classList.toggle('indicador-guardado--guardando', pend > 0);
  }

  function pintarChips() {
    Object.keys(L.GRUPOS).forEach(function (k) {
      var chip = document.querySelector('.chip-pri[data-filtro="' + k + '"]');
      if (!chip) return;
      chip.querySelector('.contador').textContent = String(S.contadores[k] || 0);
      chip.setAttribute('aria-pressed', S.grupo === L.GRUPOS[k] ? 'true' : 'false');
    });
    var nd = $('chip-no-decidibles');
    if (nd) nd.querySelector('.contador').textContent = String(S.contadores.no_decidibles || 0);
  }

  // ───────────────────────── eventos ─────────────────────────
  function seleccionarPorNumero(n) {
    var opciones = L.opcionesDe(S.detalle && S.detalle.candidatos, S.busqueda);
    var o = opciones[n - 1]; if (!o) return;
    S.sel = o.variant_id; quitarAviso('elegir');
    var r = document.querySelector('input[name="candidato"][value="' + (window.CSS && CSS.escape ? CSS.escape(o.variant_id) : o.variant_id) + '"]');
    if (r) r.checked = true;
    anunciar('Seleccionado: ' + (o.titulo || o.sku));
  }

  function abrirVisor(btn) {
    var dlg = $('visor-foto-dialog'); if (!dlg) return;
    $('visor-titulo').textContent = btn.getAttribute('data-foto-titulo');
    var im = $('visor-imagen'); im.src = btn.getAttribute('data-foto-url'); im.alt = 'Foto de ' + btn.getAttribute('data-foto-titulo');
    $('visor-sku').textContent = btn.getAttribute('data-foto-sku');
    dlg.showModal();
  }

  function conectarUnaVez() {
    var root = $('root');
    root.addEventListener('click', function (ev) {
      var t = ev.target.closest('button, input[type="radio"]'); if (!t) return;
      if (t.id === 'btn-confirmar') confirmarCasoActual();
      else if (t.id === 'btn-vincular') decidir('vincular', S.sel);
      else if (t.id === 'btn-omitir') decidir('omitir');
      else if (t.id === 'btn-mantener') decidir('mantener_omision');
      else if (t.id === 'btn-no-existe') decidir('sin_candidato');
      else if (t.id === 'btn-buscar') abrirBusqueda();
      else if (t.id === 'btn-dif') { S.soloDif = !S.soloDif; render(); $('btn-dif').focus(); }
      else if (t.id === 'btn-aplicar') aplicarSobreNueva();
      else if (t.classList.contains('foto-btn')) abrirVisor(t);
      else if (t.type === 'radio') { S.sel = t.value; quitarAviso('elegir'); }
    });
    root.addEventListener('input', function (ev) {
      if (ev.target.id === 'input-buscar') { S.consulta = ev.target.value; buscar(ev.target.value); }
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.target.id === 'input-buscar' && ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrarBusqueda(); }
    });

    document.addEventListener('keydown', function (ev) {
      if (!L.puedeDispararAtajo(ev, S.atajos)) return;
      var k = ev.key;
      if (ev.target.closest && ev.target.closest('button, a, summary') && (k === 'Enter' || k === ' ')) return; // el botón enfocado manda
      var enRadio = ev.target.type === 'radio';
      if ((k === 'ArrowDown' || k === 'ArrowUp') && enRadio) return; // en un radio, las flechas cambian la opción
      if (k === 'j' || k === 'ArrowDown') { ev.preventDefault(); ir(1); }
      else if (k === 'k' || k === 'ArrowUp') { ev.preventDefault(); ir(-1); }
      else if (/^[1-9]$/.test(k)) { ev.preventDefault(); seleccionarPorNumero(Number(k)); }
      else if (k === 'Enter') { ev.preventDefault(); if (S.cola[S.idx] && S.cola[S.idx].confirmar) confirmarCasoActual(); else decidir('vincular', S.sel); }
      else if (k === 's') { ev.preventDefault(); if (S.detalle) decidir('omitir'); }
      else if (k === 'n') { ev.preventDefault(); if (S.detalle) decidir('sin_candidato'); }
      else if (k === '/') { ev.preventDefault(); if (S.detalle) abrirBusqueda(); }
      else if (k === 'd') { ev.preventDefault(); S.soloDif = !S.soloDif; render(); }
      else if (k === 'f') { ev.preventDefault(); var fb = document.querySelector('.foto-btn'); if (fb) abrirVisor(fb); }
      else if (k === 'z') { ev.preventDefault(); deshacer(); }
      else if (k === 'h') { ev.preventDefault(); var hh = $('historial'); if (hh) hh.open = !hh.open; }
      else if (k === '?') { ev.preventDefault(); $('ayuda-dialog').showModal(); }
    });

    document.querySelectorAll('.chip-pri[data-filtro]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var g = L.GRUPOS[chip.getAttribute('data-filtro')];
        S.grupo = S.grupo === g ? null : g;
        cargarCola();
      });
    });

    var dlgV = $('visor-foto-dialog');
    $('btn-cerrar-visor').addEventListener('click', function () { dlgV.close(); });
    var dlgA = $('ayuda-dialog');
    $('btn-ayuda').addEventListener('click', function () { dlgA.showModal(); });
    $('btn-cerrar-ayuda').addEventListener('click', function () { dlgA.close(); });
    var tg = $('toggle-atajos');
    tg.checked = S.atajos;
    tg.addEventListener('change', function () { S.atajos = tg.checked; guardarAtajos(S.atajos); });
    $('btn-deshacer-aviso').addEventListener('click', deshacer);

    window.addEventListener('beforeunload', function (ev) {
      if (S.pendientes.size) { ev.preventDefault(); ev.returnValue = ''; }
    });
    function red() {
      if (navigator.onLine) quitarAviso('red');
      else aviso('red', 'Sin conexión. Tus decisiones sin guardar se reintentan solas.');
    }
    window.addEventListener('online', red); window.addEventListener('offline', red);
    if (!navigator.onLine) red();
  }

  function montarContenedores() {
    var wrap = document.querySelector('.bandeja-wrap');
    var banda = el('div', 'indicador-guardado', 'Todo guardado', { id: 'banda', role: 'status' });
    var avisos = el('div', 'avisos', null, { id: 'avisos' });
    var anuncio = el('div', 'sr-only-status', null, { id: 'anuncio', role: 'status' });
    wrap.parentNode.insertBefore(banda, wrap);
    wrap.parentNode.insertBefore(avisos, wrap);
    document.body.appendChild(anuncio);
  }

  function inicializar() {
    window.Api.installAuth();
    window.Api.requirePermiso('matcher').then(function () {
      montarContenedores();
      conectarUnaVez();
      return cargarCola();
    }, function () { window.location.href = '/herramientas/home/'; });
  }

  document.addEventListener('DOMContentLoaded', inicializar);
})();
