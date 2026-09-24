/**
 * public/bandeja-identidad/logica.js — lógica pura de la bandeja (sin DOM, sin fetch).
 * Script clásico en el navegador (window.BandejaLogica) y CommonJS/ESM-interop en vitest.
 */
(function (root) {
  'use strict';

  var MARCAS = {
    coincide: { clase: 'mk--ok', simbolo: '✓', texto: 'coincide' },
    difiere: { clase: 'mk--diff', simbolo: '≠', texto: 'difiere' },
    falta: { clase: 'mk--miss', simbolo: '—', texto: 'falta' },
    equivalente: { clase: 'mk--eq', simbolo: '≈', texto: 'equivalente' }
  };

  var COPY = {
    version_conflict: 'Este caso cambió mientras lo revisabas; tu elección se conserva.',
    caso_cerrado: 'Este caso ya se resolvió. Pasamos al siguiente.',
    revierte_no_vigente: 'Esa decisión ya no es la vigente, no se puede deshacer.',
    solo_admin: 'Sólo un administrador puede revertir esto.',
    variante_invalida: 'Esa variante ya no está disponible. Elegí otra.',
    caso_sin_publicacion: 'Este caso no tiene una publicación única para decidir.',
    idempotency_mismatch: 'Se cambió la decisión mientras se reintentaba. Volvé a decidir.',
    caso_inexistente: 'Este caso ya no existe.',
    bandeja_apagada: 'La bandeja está apagada por ahora.',
    plataforma_no_responde: 'La plataforma no responde. Reintentamos solos.'
  };

  // Chip → grupo de prioridad de la API (0 conflicto … 6 sin título). Punto A (decisión de José vía
  // opt-16 2026-09-24): confirmable (5, SKU ya vinculado — un click, sin candidatos) va después de los
  // decidibles; sin_titulo (6) al fondo de todos, hasta que el punto B les dé una fuente.
  var GRUPOS = { conflictos: 0, d5: 1, sku_exacto: 2, activas_con_stock: 3, resto: 4, confirmable: 5, sin_titulo: 6 };
  var GRUPO_NOMBRE = ['Conflicto', 'D5', 'SKU exacto en sombra', 'Activa con stock', 'Resto', 'Confirmar', 'Sin título'];

  function marca(m) { return MARCAS[m] || { clase: 'mk--miss', simbolo: '?', texto: String(m) }; }

  function copyError(codigo) {
    return COPY[codigo] || 'No se pudo completar la acción (' + codigo + ').';
  }

  // Atajos de una sola letra: nunca con modificadores, ni escribiendo, ni dentro de un diálogo, y sólo si están activos.
  function puedeDispararAtajo(evt, atajosActivos) {
    if (!atajosActivos) return false;
    if (evt.ctrlKey || evt.altKey || evt.metaKey) return false;
    var t = evt.target;
    if (t && t.tagName) {
      var tag = t.tagName;
      if (tag === 'INPUT' && !/^(radio|checkbox|button)$/.test(t.type || '')) return false; // los radios no son campos de texto
      if (tag === 'TEXTAREA' || tag === 'SELECT') return false;
      if (t.isContentEditable) return false;
      if (t.closest && t.closest('dialog')) return false;
    }
    return true;
  }

  // Sólo se reintenta lo que puede arreglarse solo: red caída (status 0), 5xx y 429. Un 4xx es una respuesta definitiva.
  function esReintentable(status) { return status === 0 || status === 429 || status >= 500; }

  // Backoff exponencial con jitter (±25 %), tope de 15 s por espera y de 5 intentos en total: con la plataforma
  // caída el operador ve el error en ~30 s en vez de esperar para siempre.
  var MAX_INTENTOS = 5;
  function demora(intento, azar) {
    var rnd = typeof azar === 'function' ? azar() : Math.random();
    var base = Math.min(1000 * Math.pow(2, intento), 15000);
    return Math.round(base * (0.75 + rnd * 0.5));
  }

  var VENTANA_DESHACER_MS = 10000;
  function puedeDeshacer(ultima, ahora) {
    return !!ultima && !ultima.consumida && ahora - ultima.ts <= VENTANA_DESHACER_MS;
  }

  // Total del filtro para «Caso N de M»: la suma de los contadores de la cola (sin no_decidibles). Confirmable
  // y sin_titulo SÍ suman al total general: a diferencia de no_decidibles, esos casos aparecen en `casos`.
  function totalFiltro(contadores, grupo) {
    var c = contadores || {};
    if (grupo === null || grupo === undefined) {
      return (c.conflictos || 0) + (c.d5 || 0) + (c.sku_exacto || 0) + (c.activas_con_stock || 0) + (c.resto || 0)
        + (c.confirmable || 0) + (c.sin_titulo || 0);
    }
    var clave = Object.keys(GRUPOS).filter(function (k) { return GRUPOS[k] === grupo; })[0];
    return c[clave] || 0;
  }

  function formatoPrecio(precio, moneda) {
    if (precio === null || precio === undefined || precio === '') return 'Sin precio';
    return String(precio) + (moneda ? ' ' + moneda : '');
  }
  function formatoStock(stock) {
    if (stock === null || stock === undefined) return 'Stock sin dato';
    return stock + ' en stock';
  }

  // Opciones de la matriz = candidatos del motor + variantes traídas por la búsqueda (sin repetir).
  function opcionesDe(candidatos, busqueda) {
    var vistos = {};
    var out = [];
    (candidatos || []).concat(busqueda || []).forEach(function (o) {
      if (!o || vistos[o.variant_id]) return;
      vistos[o.variant_id] = true;
      out.push(o);
    });
    return out;
  }

  // Filas de atributos de la matriz: fijas primero, luego las que traiga cualquier opción.
  function nombresAtributos(opciones) {
    var vistos = {};
    var out = [];
    (opciones || []).forEach(function (o) {
      var e = o.explicacion || {};
      (e.atributos || []).concat(e.otros_atributos || []).forEach(function (a) {
        if (!vistos[a.nombre]) { vistos[a.nombre] = true; out.push(a.nombre); }
      });
    });
    return out;
  }

  function atributoDe(opcion, nombre) {
    var e = (opcion && opcion.explicacion) || {};
    var lista = (e.atributos || []).concat(e.otros_atributos || []);
    for (var i = 0; i < lista.length; i++) if (lista[i].nombre === nombre) return lista[i];
    return null;
  }

  // «Sólo diferencias»: una fila se oculta si ninguna opción difiere ni le falta el dato.
  function filaVisible(opciones, nombre, soloDiferencias) {
    if (!soloDiferencias) return true;
    return (opciones || []).some(function (o) {
      var a = atributoDe(o, nombre);
      return !!a && a.marca !== 'coincide';
    });
  }

  var api = {
    marca: marca, copyError: copyError, puedeDispararAtajo: puedeDispararAtajo, esReintentable: esReintentable,
    demora: demora, MAX_INTENTOS: MAX_INTENTOS, puedeDeshacer: puedeDeshacer, totalFiltro: totalFiltro, formatoPrecio: formatoPrecio,
    formatoStock: formatoStock, opcionesDe: opcionesDe, nombresAtributos: nombresAtributos, atributoDe: atributoDe,
    filaVisible: filaVisible, GRUPOS: GRUPOS, GRUPO_NOMBRE: GRUPO_NOMBRE, VENTANA_DESHACER_MS: VENTANA_DESHACER_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BandejaLogica = api;
})(typeof window !== 'undefined' ? window : globalThis);
