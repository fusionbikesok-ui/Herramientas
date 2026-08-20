/*
 * public/lib/conteoCantidad.js — Lógica pura de decisión de cantidad contada
 * (Contador de inventario). Nada de DOM ni fetch acá: solo la parte que
 * decide QUÉ significa lo que el operario tipeó/tocó y QUÉ hay que mandar
 * (o revertir) — es la lógica que, mal hecha, termina escribiendo stock en
 * Woo por accidente.
 *
 * Se carga como <script src="../lib/conteoCantidad.js"></script> (script
 * CLÁSICO, no module), igual que format.js: queda disponible de forma
 * síncrona como window.ConteoCantidad para el script inline de la página.
 */
(function (root) {
  'use strict';

  // Tope razonable de cantidad contada. Existe para blindar contra la pistola
  // HID tipeando un código de barras (13+ dígitos) en el campo de cantidad
  // por error de foco: un conteo real de depósito nunca llega a este orden.
  var TOPE_CANTIDAD_DEFECTO = 9999;

  // Normaliza lo que el operario dejó en el input. La regla que NO puede
  // quedar implícita: "campo vacío" (o solo espacios) es un estado propio,
  // distinto de "cero". Nunca devuelve valor=0 para un campo vacío.
  //   { ok:false, motivo:'vacio' }      → no tipeó nada (o borró todo)
  //   { ok:false, motivo:'invalida' }   → lo que hay no es un número (texto, etc.)
  //   { ok:true, valor:N, truncada }    → número válido, entero >= 0
  function normalizarCantidad(raw) {
    if (raw == null) return { ok: false, motivo: 'vacio' };
    var s = String(raw).trim();
    if (s === '') return { ok: false, motivo: 'vacio' };
    var num = Number(s);
    if (!isFinite(num) || isNaN(num)) return { ok: false, motivo: 'invalida' };
    var truncada = !Number.isInteger(num);
    var entero = Math.round(num);
    // Un negativo se lleva a 0, pero se AVISA: dejarlo pasar en silencio es la misma
    // asimetría que ya corregimos con el campo vacío — el operario tipeó una cosa y se
    // guardó otra sin enterarse. Un decimal avisa ("se redondeó"); un negativo también debe.
    var negativa = entero < 0;
    if (negativa) entero = 0;
    return { ok: true, valor: entero, truncada: !!truncada, negativa: negativa };
  }

  // true si el valor supera el tope (pistola HID tipeando un código de barras
  // completo en el campo de cantidad).
  function excedeTope(valor, tope) {
    var t = (typeof tope === 'number' && isFinite(tope)) ? tope : TOPE_CANTIDAD_DEFECTO;
    return typeof valor === 'number' && valor > t;
  }

  // Decide qué hacer con lo que el operario tipeó, dado el último valor
  // conocido (confirmado o el último que ESTE control ya calculó). Nunca
  // devuelve "enviar" para un campo vacío o inválido: en esos casos indica
  // revertir al valor anterior, sin tocar el servidor.
  //   valorAnterior: number — último valor conocido (confirmado o local)
  //   rawInput: lo que hay en el input (string)
  //   opts.tope: opcional, tope máximo permitido
  function decidirCantidadAEnviar(valorAnterior, rawInput, opts) {
    opts = opts || {};
    var base = (typeof valorAnterior === 'number' && isFinite(valorAnterior)) ? valorAnterior : 0;
    var norm = normalizarCantidad(rawInput);
    if (!norm.ok) {
      return { enviar: false, valorMostrar: base, motivo: norm.motivo };
    }
    if (excedeTope(norm.valor, opts.tope)) {
      return { enviar: false, valorMostrar: base, motivo: 'tope', tope: (typeof opts.tope === 'number' ? opts.tope : TOPE_CANTIDAD_DEFECTO) };
    }
    if (norm.valor === base && !norm.truncada) {
      return { enviar: false, valorMostrar: base, motivo: 'sin_cambio' };
    }
    return {
      enviar: true, valorMostrar: norm.valor, valorEnviar: norm.valor,
      truncada: norm.truncada, negativa: norm.negativa,
      motivo: norm.negativa ? 'negativa' : (norm.truncada ? 'truncada' : 'ok'),
    };
  }

  // Delta puro del botón "−": SIEMPRE se calcula sobre el último valor
  // localmente conocido (el que pasás como `base`), nunca releyendo una
  // copia que puede estar vieja. Quien llama es responsable de encadenar:
  // el resultado de un toque es la `base` del siguiente, así dos toques
  // seguidos bajan 2 (nunca 1) aunque la respuesta del primer PATCH todavía
  // no haya vuelto del servidor.
  function siguienteAlRestar(base) {
    var b = (typeof base === 'number' && isFinite(base)) ? base : 0;
    return Math.max(0, b - 1);
  }

  var ConteoCantidad = {
    TOPE_CANTIDAD_DEFECTO: TOPE_CANTIDAD_DEFECTO,
    normalizarCantidad: normalizarCantidad,
    decidirCantidadAEnviar: decidirCantidadAEnviar,
    siguienteAlRestar: siguienteAlRestar,
    excedeTope: excedeTope
  };

  root.ConteoCantidad = ConteoCantidad;
})(typeof window !== 'undefined' ? window : this);
