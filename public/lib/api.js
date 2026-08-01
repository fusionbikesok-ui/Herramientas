/*
 * public/lib/api.js — Fetch autenticado + manejo de 401 compartido.
 *
 * Se carga como <script src="../lib/api.js"></script> (script CLÁSICO, no module)
 * ANTES del script principal de la página, de modo que window.Api quede disponible
 * de forma síncrona. No usa `export`: debe cargarse como script clásico.
 *
 * Esquema de auth real del proyecto: la sesión viaja por COOKIE (same-origin). El
 * header `Authorization: 'Basic ' + token` es un placeholder constante ('cookie-session')
 * que las páginas venían inyectando sobre todos los fetch. `installAuth()` reproduce
 * EXACTAMENTE ese override.
 *
 * El manejo de 401 SÍ se centraliza acá: el override de window.fetch de installAuth()
 * detecta cualquier respuesta 401 (sesión vencida o sin login) y redirige a
 * /herramientas/login/?next=... . Así ninguna página necesita su propio handler de 401.
 */
(function (root) {
  'use strict';

  // Override global de window.fetch que inyecta el header Authorization en cada request.
  // Reproduce 1:1 el IIFE que cada página traía en su <script>.
  function installAuth(opts) {
    opts = opts || {};
    var token = opts.token || 'cookie-session';
    if (!token) {
      window.location.href = '/herramientas/login/?next=' + encodeURIComponent(window.location.pathname);
      throw new Error('redirect');
    }
    var _fetch = window.fetch;
    window.fetch = function (url, o) {
      o = o || {};
      o.headers = Object.assign({ 'Authorization': 'Basic ' + token }, o.headers || {});
      return _fetch(url, o).then(function (r) {
        // Manejo de 401 centralizado: si la sesión venció (o no hay login), redirigimos
        // a login en vez de dejar que cada página muestre un error de "HTTP 401".
        if (r.status === 401) {
          window.location.href = '/herramientas/login/?next=' +
            encodeURIComponent(window.location.pathname + window.location.search);
          // Cortamos la cadena: la navegación descarga la página; evita el flash de error.
          return new Promise(function () {});
        }
        return r;
      });
    };
  }

  // --- Contrato de estado explícito para fetch de datos -------------------
  //
  // Problema que resuelve: api.js devolvía datos crudos, así que "vacío" (0
  // resultados reales) y "error" (fetch falló) terminaban siendo el mismo
  // array de longitud 0 en cada página, y cada pantalla decidía por su
  // cuenta cómo comunicarlo — la mayoría, no lo comunicaba. Ver hallazgo
  // "El fallo silencioso" del relevamiento E2E (recepcion, codigos,
  // etiquetas, usuarios).
  //
  // fetchState(url, opts) devuelve SIEMPRE uno de estos 4 estados:
  //   'cargando' → nunca se devuelve como resultado final, solo existe como
  //                valor de paso si se usa el callback onEstado.
  //   'ok'      → fetch 2xx y el payload tiene datos (según opts.esVacio).
  //   'vacio'   → fetch 2xx pero el payload está vacío (0 resultados reales).
  //   'error'   → fetch falló (status no-2xx, error de red, JSON inválido).
  //
  // No es opcional: renderLista() más abajo obliga a resolver el estado
  // antes de pintar nada, para que sea imposible repetir el bug de
  // "Sin resultados" cuando en realidad el fetch falló.
  function fetchState(url, opts) {
    opts = opts || {};
    var onEstado = opts.onEstado; // opcional: notifica 'cargando' antes del fetch
    if (typeof onEstado === 'function') onEstado('cargando');
    return fetch(url, opts.fetchOpts || {}).then(function (r) {
      if (!r.ok) {
        return r.text().catch(function () { return ''; }).then(function (txt) {
          var mensaje = 'Error HTTP ' + r.status;
          try {
            var j = JSON.parse(txt);
            if (j && j.error) mensaje = j.error;
          } catch (e) { /* respuesta no-JSON, dejamos el mensaje genérico */ }
          return { state: 'error', data: null, error: mensaje, status: r.status };
        });
      }
      return r.json().then(function (data) {
        var vacio = typeof opts.esVacio === 'function' ? opts.esVacio(data) : esVacioPorDefecto(data);
        return { state: vacio ? 'vacio' : 'ok', data: data, error: null, status: r.status };
      }, function () {
        return { state: 'error', data: null, error: 'Respuesta inválida del servidor', status: r.status };
      });
    }, function (err) {
      return { state: 'error', data: null, error: (err && err.message) || 'Fallo de red', status: 0 };
    });
  }

  function esVacioPorDefecto(data) {
    if (Array.isArray(data)) return data.length === 0;
    if (data && Array.isArray(data.data)) return data.data.length === 0;
    if (data && Array.isArray(data.items)) return data.items.length === 0;
    return false;
  }

  // renderState(container, resultado, opciones): helper de render que no
  // permite pintar una lista sin haber resuelto el estado. `opciones.ok`
  // recibe (data, container) y es la única forma de pintar filas reales.
  // Los otros 3 estados los resuelve el helper con un mensaje consistente
  // (mismo look que la tab "Buscar en catálogo" de /etiquetas/, que ya lo
  // hacía bien: texto claro + botón reintentar).
  function renderState(container, resultado, opciones) {
    opciones = opciones || {};
    if (!container) return;
    if (resultado.state === 'ok') {
      opciones.ok && opciones.ok(resultado.data, container);
      return;
    }
    var mensaje, mostrarReintentar = true;
    if (resultado.state === 'vacio') {
      mensaje = opciones.mensajeVacio || 'No hay resultados.';
      mostrarReintentar = false;
    } else if (resultado.state === 'error') {
      mensaje = (opciones.prefijoError || 'No se pudo cargar: ') + (resultado.error || 'error desconocido');
    } else {
      mensaje = 'Cargando…';
      mostrarReintentar = false;
    }
    var btn = (mostrarReintentar && opciones.onReintentar)
      ? '<button type="button" class="btn-reintentar" data-api-reintentar>Reintentar</button>'
      : '';
    container.innerHTML = '<div class="api-estado api-estado--' + resultado.state + '">' +
      '<p>' + mensaje.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</p>' + btn + '</div>';
    if (mostrarReintentar && opciones.onReintentar) {
      var btnEl = container.querySelector('[data-api-reintentar]');
      if (btnEl) btnEl.addEventListener('click', opciones.onReintentar);
    }
  }

  // requirePermiso(tool): guard de permisos unificado. Criterio elegido para
  // TODA la suite (18 herramientas): si no hay permiso, redirigir siempre a
  // /herramientas/home/ ANTES de pintar el shell de la página. Es el patrón
  // que ya usaban la mayoría de las páginas; se descartó "cargar shell y
  // mostrar 403 inline" (preparacion) y "cargar página vacía sin aviso"
  // (codigos) por inconsistentes y porque el segundo es indistinguible de
  // "no hay datos".
  function requirePermiso(tool) {
    return fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return false;
      var isAdmin = !!d.is_admin || (d.scopes && d.scopes.indexOf('all') !== -1);
      if (isAdmin || !tool) return true;
      var ok = (d.permisos || []).some(function (p) { return p.herramienta === tool; });
      if (!ok) {
        window.location.href = '/herramientas/home/';
        return false;
      }
      return true;
    }, function () { return false; });
  }

  // guardBfcache(): defensa en profundidad contra el bug de "logout + botón atrás".
  // El backend ya manda Cache-Control: no-store en /api/auth/me, pero cuando el navegador
  // restaura la página completa desde bfcache (evento pageshow con persisted=true) ni
  // siquiera vuelve a ejecutar el JS de carga inicial — la UI queda mostrando el estado
  // logueado congelado de antes del logout. Este listener fuerza una revalidación real
  // (fetch con cache:'no-store') apenas se restaura la página, y redirige a login si la
  // sesión ya no es válida.
  function guardBfcache() {
    window.addEventListener('pageshow', function (ev) {
      if (!ev.persisted) return;
      fetch('/api/auth/me', { cache: 'no-store' }).then(function (r) {
        if (r.status === 401) throw new Error('no-session');
        return r.json();
      }).then(function (d) {
        if (!d || !d.ok) throw new Error('no-session');
      }).catch(function () {
        window.location.href = '/herramientas/login/?next=' +
          encodeURIComponent(window.location.pathname + window.location.search);
      });
    });
  }

  root.Api = {
    installAuth: installAuth,
    fetchState: fetchState,
    renderState: renderState,
    requirePermiso: requirePermiso,
    guardBfcache: guardBfcache
  };
})(typeof window !== 'undefined' ? window : this);
