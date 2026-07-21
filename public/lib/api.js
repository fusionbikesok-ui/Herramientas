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
 * El manejo de 401 de cada página vive embebido en su "permission-gate" (/api/auth/me),
 * que hace más que un fetch simple, por eso NO se centraliza acá.
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
      return _fetch(url, o);
    };
  }

  root.Api = { installAuth: installAuth };
})(typeof window !== 'undefined' ? window : this);
