/*
 * public/lib/conteoCantidad.js — Lógica pura del conteo (Contador de inventario).
 * Nada de DOM ni fetch acá. Dos cosas viven en este archivo:
 *
 *   1. QUÉ significa lo que el operario tipeó/tocó y qué hay que mandar (o
 *      revertir) — la lógica que, mal hecha, termina escribiendo stock en Woo
 *      por accidente.
 *   2. En qué ORDEN se aplican las escrituras (crearColaEscrituras). No decide
 *      ninguna cantidad, pero es lo que hace que el orden en que tocó el
 *      operario sea el orden en que se aplica: sin eso, el punto 1 puede estar
 *      perfecto y el conteo salir mal igual.
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


  // Cola de escrituras: el conteo tiene DOS escrituras que pegan al mismo ítem con
  // semánticas distintas — el escaneo suma +1 en el servidor (relativo) y el control de
  // cantidad manda un valor ABSOLUTO. Si viajan a la vez gana el que LLEGA, no el que se
  // envió, y el +1 del escaneo se pierde en silencio: justo el subconteo que esta pantalla
  // vino a arreglar. Serializarlas es lo que hace que el orden en que tocó el operario sea
  // el orden en que se aplica.
  //
  // Un fallo NO puede cortar la cola: si una escritura rechaza, la siguiente igual corre.
  // Eso lo hace el `catch` — la cadena que se GUARDA es la domada, y por eso el próximo
  // `then` siempre arranca. Lo que se DEVUELVE es la promesa original, para que quien llama
  // pueda seguir viendo el error. (Una versión anterior además pasaba `hacer` como segundo
  // argumento de `then`: hacía lo mismo dos veces, y esa redundancia volvía imposible
  // testear cualquiera de los dos mecanismos — la mutación de uno la tapaba el otro.)
  function crearColaEscrituras() {
    var cola = Promise.resolve();
    return function encolar(hacer) {
      var p = cola.then(hacer);
      cola = p.catch(function () {});
      return p;
    };
  }

  var ConteoCantidad = {
    TOPE_CANTIDAD_DEFECTO: TOPE_CANTIDAD_DEFECTO,
    normalizarCantidad: normalizarCantidad,
    decidirCantidadAEnviar: decidirCantidadAEnviar,
    siguienteAlRestar: siguienteAlRestar,
    excedeTope: excedeTope,
    crearColaEscrituras: crearColaEscrituras
  };

  root.ConteoCantidad = ConteoCantidad;
})(typeof window !== 'undefined' ? window : this);
