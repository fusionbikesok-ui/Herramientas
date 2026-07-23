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

  root.Api = { installAuth: installAuth };
})(typeof window !== 'undefined' ? window : this);
