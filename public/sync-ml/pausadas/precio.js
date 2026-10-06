/* Lógica pura de «Calcular precio y reactivar» (Sincronización ML > Pausadas con stock).
   Sin DOM ni fetch: la pantalla le inyecta las llamadas. Se carga en el navegador (window.PausadasPrecio)
   y los tests la importan como CommonJS. No hay backend nuevo: usa /api/precios/objetivo,
   /api/precios/actualizar-precio-item y la reactivación existente. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PausadasPrecio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ERR_NETO = 'El neto de ML queda por debajo del precio web';
  var MAX_LOTE = 50;
  var MAX_CLAVES_OBJETIVO = 100;

  function r2(n) { return Math.round(Number(n) * 100) / 100; }

  /* Claves (variaciones) de un resultado de reactivación que fueron frenadas por neto bajo; null si no es ese bloqueo. */
  function clavesBloqueoNeto(res) {
    if (!res || !res.bloqueado) return null;
    var lista = Array.isArray(res.bloqueos) && res.bloqueos.length ? res.bloqueos : [res];
    var claves = lista.filter(function (b) { return b && b.error === ERR_NETO && b.clave; }).map(function (b) { return b.clave; });
    return claves.length ? claves : null;
  }

  /* Parte las claves en tandas para /objetivo (máx. 100 por pedido). */
  function tandas(claves) {
    var out = [];
    for (var i = 0; i < claves.length; i += MAX_CLAVES_OBJETIVO) out.push(claves.slice(i, i + MAX_CLAVES_OBJETIVO));
    return out;
  }

  /* Plan para una publicación a partir de lo que devolvió /objetivo (mapa clave → fila).
     ML exige un precio único cuando hay variaciones: se usa el más alto de los calculados.
     Si alguna variación no tiene precio calculado no se ofrece confirmar (no se inventa un número). */
  function planItem(itemId, claves, resultados) {
    var filas = claves.map(function (c) { return (resultados && resultados[c]) || { clave: c, precio: null, motivo: 'ML no devolvió el cálculo.' }; });
    var sin = filas.filter(function (f) { return !(Number(f.precio) > 0); });
    if (sin.length) {
      var motivos = [];
      // Sin punto final: la pantalla arma «No se puede calcular: <motivo>. No se cambia nada…» y el motivo de /objetivo ya trae el suyo.
      sin.forEach(function (f) { var m = String(f.motivo || 'No se pudo calcular el precio').trim().replace(/[.\s]+$/, ''); if (motivos.indexOf(m) < 0) motivos.push(m); });
      return { itemId: itemId, ok: false, motivos: motivos };
    }
    var det = filas.reduce(function (a, f) { return Number(f.precio) > Number(a.precio) ? f : a; }, filas[0]);
    var actuales = filas.map(function (f) { return Number(f.precio_actual); }).filter(function (n) { return n > 0; });
    var actual = actuales.length ? r2(Math.max.apply(null, actuales)) : null;
    var nuevo = r2(det.precio);
    return {
      itemId: itemId, ok: true, actual: actual, nuevo: nuevo,
      cambia: actual == null || actual !== nuevo,
      baja: actual != null && nuevo < actual,
      neto: det.neto == null ? null : r2(det.neto),
      precioWeb: det.contado == null ? null : r2(det.contado),
      cruzaEnvio: filas.some(function (f) { return !!f.cruza_umbral_envio; }),
      variaciones: filas.length
    };
  }

  /* Resumen para la tabla de confirmación. */
  function resumen(planes) {
    var ok = planes.filter(function (p) { return p.ok; });
    var cambian = ok.filter(function (p) { return p.cambia; });
    return {
      total: planes.length,
      confirmables: ok.length,
      sinCalculo: planes.length - ok.length,
      cambian: cambian.length,
      sinCambio: ok.length - cambian.length,
      bajan: ok.filter(function (p) { return p.baja; }).length,
      diferencia: r2(cambian.reduce(function (a, p) { return a + (p.actual != null ? p.nuevo - p.actual : 0); }, 0))
    };
  }

  /* Ejecuta lo confirmado. deps.putPrecio(itemId, precio) → Promise<{ok, error}>;
     deps.reactivar(itemIds) → Promise<{[itemId]: {ok, error}}>.
     Reglas: primero el precio; si falla, esa publicación NO se reactiva. Si el precio no cambió no hay PUT.
     Si la reactivación falla, el precio nuevo queda aplicado (estado fallo_reactivacion). Devuelve un resultado por publicación. */
  async function ejecutar(planes, deps) {
    var out = {};
    var paraReactivar = [];
    var confirmables = planes.filter(function (p) { return p.ok; }).slice(0, MAX_LOTE);
    for (var i = 0; i < confirmables.length; i++) {
      var p = confirmables[i];
      if (p.cambia) {
        var r;
        try { r = await deps.putPrecio(p.itemId, p.nuevo); } catch (e) { r = { ok: false, error: e && e.message ? e.message : 'falló el pedido' }; }
        if (!r || !r.ok) { out[p.itemId] = { itemId: p.itemId, estado: 'fallo_precio', error: (r && r.error) || 'no se pudo actualizar el precio' }; continue; }
        out[p.itemId] = { itemId: p.itemId, precioAplicado: p.nuevo };
      } else {
        out[p.itemId] = { itemId: p.itemId, precioAplicado: null };
      }
      paraReactivar.push(p.itemId);
    }
    if (paraReactivar.length) {
      var mapa;
      try { mapa = await deps.reactivar(paraReactivar); } catch (e) {
        var msg = e && e.message ? e.message : 'falló el pedido';
        mapa = {}; paraReactivar.forEach(function (id) { mapa[id] = { ok: false, error: msg }; });
      }
      paraReactivar.forEach(function (id) {
        var x = (mapa && mapa[id]) || { ok: false, error: 'el servidor no devolvió resultado' };
        out[id].estado = x.ok ? 'ok' : 'fallo_reactivacion';
        if (!x.ok) { out[id].error = x.error || 'no se pudo reactivar'; if (x.bloqueado) out[id].bloqueado = true; }
      });
    }
    return planes.map(function (p) {
      if (!p.ok) return { itemId: p.itemId, estado: 'sin_calculo' };
      return out[p.itemId] || { itemId: p.itemId, estado: 'omitida', error: 'fuera del tope de ' + MAX_LOTE };
    });
  }

  /* Permiso de escritura en Precios y en Sync ML (admin o nivel write en ambos). `me` es la respuesta de /api/auth/me. */
  function puedeEscribirPrecios(me) {
    if (!me) return false;
    if (me.is_admin || (me.scopes && me.scopes.indexOf('all') !== -1)) return true;
    var w = {};
    (me.permisos || []).forEach(function (p) { if (p && p.nivel === 'write') w[p.herramienta] = true; });
    return !!(w['precios'] && w['sync-ml']);
  }

  return { ERR_NETO: ERR_NETO, MAX_LOTE: MAX_LOTE, clavesBloqueoNeto: clavesBloqueoNeto, tandas: tandas, planItem: planItem, resumen: resumen, ejecutar: ejecutar, puedeEscribirPrecios: puedeEscribirPrecios };
});
