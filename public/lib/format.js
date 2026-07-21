/*
 * public/lib/format.js — Helpers de formato y escape compartidos.
 *
 * Se carga como <script src="../lib/format.js"></script> (script CLÁSICO, no module)
 * ANTES del script principal de cada página, de modo que estas funciones queden
 * disponibles como globales (window.esc, window.money, …) de forma síncrona.
 * También se agrupan en window.Fmt para quien prefiera el namespace.
 *
 * No usa `export` a propósito: debe poder cargarse como script clásico en páginas
 * que NO son módulos ESM. Para consumo desde módulos, usar window.Fmt / globales.
 */
(function (root) {
  'use strict';

  // Escapa & < > " (variante canónica: segura para texto y atributos HTML).
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Moneda ARS sin decimales (—) si es null/undefined.
  function money(x) {
    return x == null
      ? '—'
      : Number(x).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  }

  // Fecha/hora corta es-AR (día/mes hora:min). Robusta ante fechas inválidas.
  function fecha(s) {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return s;
    }
  }

  // Número entero es-AR (miles con punto). 0 por defecto.
  function n(x) {
    return (x || 0).toLocaleString('es-AR');
  }

  // Porcentaje con signo (− baja / + sube), 1 decimal. — si es null/undefined.
  function pct(x) {
    return x == null ? '—' : (x > 0 ? '−' : '+') + Math.abs(x * 100).toFixed(1) + '%';
  }

  // URL de publicación de MercadoLibre a partir del itemId (MLA123 → MLA-123).
  function mlUrl(itemId) {
    return 'https://articulo.mercadolibre.com.ar/' + String(itemId || '').replace(/^(ML[A-Z])/, '$1-');
  }

  // Nickname legible a partir de un JSON de vendedor/comprador ML.
  function nick(json) {
    try {
      var o = JSON.parse(json);
      return o && o.nickname ? o.nickname : (o && o.id ? 'ID ' + o.id : '—');
    } catch (e) {
      return '—';
    }
  }

  var Fmt = { esc: esc, money: money, fecha: fecha, n: n, pct: pct, mlUrl: mlUrl, nick: nick };

  // Namespace agrupado.
  root.Fmt = Fmt;
  // Globales sueltas para no reescribir los call-sites existentes (esc(…), money(…), …).
  root.esc = esc;
  root.money = money;
  root.fecha = fecha;
  root.n = n;
  root.pct = pct;
  root.mlUrl = mlUrl;
  root.nick = nick;
})(typeof window !== 'undefined' ? window : this);
