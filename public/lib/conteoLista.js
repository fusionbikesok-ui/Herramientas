/*
 * public/lib/conteoLista.js — lógica pura de la lista única del contador de inventario.
 *
 * Vive acá, fuera del HTML, por el mismo motivo que conteoCantidad.js: es la parte que tiene
 * que estar bien sí o sí y se puede probar sin navegador.
 *
 * `unificar` es el corazón del rediseño del 2026-09-11. Antes la pantalla tenía dos listas
 * —pendientes y contados— y contar un producto lo mudaba de una a la otra: el operario tenía
 * que scrollear al fondo de la segunda para encontrar lo que acababa de tocar. Ahora hay una
 * sola lista y el orden NO depende del estado, así que contar algo no lo mueve de lugar.
 *
 * Script clásico (no ESM), igual que el resto de public/lib.
 */
(function (root) {
  'use strict';

  // "Casco Giro Syntax — M / Azul" → { base, detalle }. El separador " — " es el que usa el
  // catálogo para las variantes. Importa porque hasta 21 productos comparten exactamente la
  // misma foto (talles de zapatillas, colores de bicis): ahí la imagen no distingue nada y el
  // talle/color tiene que ser lo más grande de la fila.
  function varianteDeNombre(nombre) {
    var txt = String(nombre == null ? '' : nombre);
    var i = txt.indexOf(' — ');
    if (i < 0) return null;
    var detalle = txt.slice(i + 3).trim();
    if (!detalle) return null;
    return { base: txt.slice(0, i).trim(), detalle: detalle };
  }

  function comparar(a, b) {
    // Un código sin asociar va primero: es trabajo que hay que resolver antes de cerrar.
    if (!!a.sin_asociar !== !!b.sin_asociar) return a.sin_asociar ? -1 : 1;
    return String(a.categoria || '').localeCompare(String(b.categoria || ''), 'es')
      || String(a.marca || '').localeCompare(String(b.marca || ''), 'es')
      || String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  }

  function unificar(contados, pendientes) {
    var orden = [];
    var indice = {};
    (pendientes || []).forEach(function (p) {
      if (indice[p.sku] !== undefined) return;
      indice[p.sku] = orden.length;
      orden.push({
        clave: p.sku, sku: p.sku, nombre: p.nombre, img: p.img || null,
        marca: p.marca || null, categoria: p.categoria_principal || null,
        contado: false, cantidad: null, diferencia: null, stock_woo: null,
      });
    });
    (contados || []).forEach(function (i) {
      var clave = i.sku || ('ean:' + i.ean);
      var fila = {
        clave: clave, sku: i.sku, nombre: i.nombre, img: i.img || null,
        marca: i.marca || null, categoria: i.categoria_principal || null,
        contado: true, itemId: i.id, ean: i.ean, cantidad: i.cantidad,
        diferencia: i.diferencia, stock_woo: i.stock_woo,
        sin_asociar: !i.sku, fuera_de_alcance: i.fuera_de_alcance,
        codigo_desconocido: i.codigo_desconocido, estado_codigo: i.estado_codigo,
        aviso: i.aviso, ajustado: i.ajustado,
      };
      if (indice[clave] !== undefined) orden[indice[clave]] = fila;
      else { indice[clave] = orden.length; orden.push(fila); }
    });
    return orden.sort(comparar);
  }

  // Qué tono corresponde a una lectura. Vive acá porque es una decisión, no un efecto: el
  // segundo sonido de cada escaneo tiene que decir QUÉ pasó, no sólo que se escuchó algo.
  //
  // `suma` vs `nuevo` es la parte que importa y sale de un incidente real (casco Giro
  // FB-67121, 2026-09-08): si escaneás lo que creés que es la primera unidad de un producto
  // y suena el tono de suma, ese producto ya estaba contado.
  function tipoDeSonido(item, fueraDeAlcance) {
    if (!item) return 'error';
    if (!item.sku) return 'error';          // código sin asociar: hay que resolverlo
    if (item.codigo_desconocido) return 'error';
    if (fueraDeAlcance || item.fuera_de_alcance) return 'fuera';
    return Number(item.cantidad) > 1 ? 'suma' : 'nuevo';
  }

  root.ConteoLista = {
    unificar: unificar,
    varianteDeNombre: varianteDeNombre,
    tipoDeSonido: tipoDeSonido,
  };
})(typeof window !== 'undefined' ? window : this);
