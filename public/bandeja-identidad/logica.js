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

  // Chip → grupo de prioridad de la API (0 conflicto … 7 apartados). Punto A (decisión de José vía
  // opt-16 2026-09-24): confirmable (5, SKU ya vinculado — un click, sin candidatos) va después de los
  // decidibles; sin_titulo (6) al fondo de todos, hasta que el punto B les dé una fuente; apartados (7) al final.
  var GRUPOS = { conflictos: 0, d5: 1, sku_exacto: 2, activas_con_stock: 3, resto: 4, confirmable: 5, sin_titulo: 6, apartados: 7 };
  var GRUPO_NOMBRE = ['Conflicto', 'D5', 'SKU exacto en sombra', 'Activa con stock', 'Resto', 'Confirmar', 'Sin título', 'Apartado'];

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
  function textoCuentaRegresiva(segundos) {
    var n = Math.max(0, Math.ceil(Number(segundos) || 0));
    return 'Deshacer: z (' + n + ' s)';
  }
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
    var n = Number(precio);
    var valor = Number.isFinite(n) ? new Intl.NumberFormat('es-AR').format(n) : String(precio);
    return valor + (moneda ? ' ' + moneda : '');
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

  // «Sólo diferencias»: una fila se oculta si ninguna opción difiere ni le falta el dato. Que a un candidato
  // le falte el dato (sin entrada en absoluto, distinto de la marca 'falta') también cuenta como visible:
  // ocultar esa fila lo haría ver como si coincidiera, empujando a un vínculo equivocado (hallazgo de Codex
  // en T4, corregido por decisión explícita de opt-55). 'equivalente' sigue contando como coincidencia, igual
  // que 'coincide' — son grupos separados a propósito (ver atributosIguales), pero acá ambos son "no difiere".
  function filaVisible(opciones, nombre, soloDiferencias) {
    if (!soloDiferencias) return true;
    return (opciones || []).some(function (o) {
      var a = atributoDe(o, nombre);
      return !a || (a.marca !== 'coincide' && a.marca !== 'equivalente');
    });
  }

  // Mapeo de tecla a acción según el contexto (caso normal o confirmable).
  // Devuelve { tipo, n? } o null si la tecla no aplica o el número de candidato no existe.
  function accionDeTecla(key, ctx) {
    var k = key.toLowerCase();
    var confirmable = ctx.confirmable;
    var nCandidatos = ctx.nCandidatos || 0;

    // Teclas comunes
    if (k === '/') return { tipo: 'buscar' };
    if (k === 'z') return { tipo: 'deshacer' };
    if (k === 'a') return { tipo: 'ayuda' };

    // En caso normal
    if (!confirmable) {
      if (/^[1-9]$/.test(k)) {
        var n = Number(k);
        if (n > nCandidatos) return null; // candidato no existe
        return { tipo: 'seleccionar', n: n };
      }
      if (k === 'enter') return ctx.candidatoVisible && nCandidatos > 0 ? { tipo: 'vincular' } : null;
      if (k === 'x') return { tipo: 'no_vincular' };
      if (k === '?') return { tipo: 'apartar' };
      if (k === 'o') return { tipo: 'omitir_por_ahora' };
      if (k === 'n') return { tipo: 'no_existe' };
      if (k === 's') return null; // omisión permanente ya no tiene tecla
      return null;
    }

    // En caso confirmable
    if (k === 'enter') return { tipo: 'confirmar' };
    if (k === 'x') return { tipo: 'rechazar' };
    if (k === '?') return { tipo: 'apartar' };
    if (k === 'o') return { tipo: 'omitir_por_ahora' };
    return null;
  }

  // Busca el siguiente índice en la cola que NO esté en salteados, empezando desde idx+1.
  // Devuelve -1 si todos los restantes están salteados.
  function siguienteNoSalteado(cola, idx, salteados) {
    for (var i = idx + 1; i < cola.length; i++) {
      if (!salteados.has(cola[i].id)) return i;
    }
    return -1;
  }

  // T5 — hallazgo Media de Codex: J/K (ir(delta)) no filtraba salteados como sí lo hacía avanzar(), así
  // que omitir un caso con O y navegar manualmente con J/K podía reabrirlo antes de tiempo. Generaliza
  // siguienteNoSalteado a ambos sentidos (delta=+1/-1); no llega a haber otros deltas en el uso real.
  // Devuelve -1 si no hay ningún índice válido en esa dirección (todos salteados o límite de la cola).
  function indiceNoSalteado(cola, idx, delta, salteados) {
    var i = idx + delta;
    while (i >= 0 && i < (cola || []).length) {
      if (!salteados.has(cola[i].id)) return i;
      i += delta;
    }
    return -1;
  }

  // Dispatcher puro (sin DOM, sin fetch): decide QUÉ llamada hacer para una `accion` de accionDeTecla()
  // (o 'omitir_por_ahora'/'no_existe', que no vienen de una tecla en el sentido llamado por bandeja.js)
  // dado el `estado` actual, sin ejecutarla — la ejecución (fetch real, reintentos, foco) la hace
  // bandeja.js con la `api` inyectada. Así el Paso 2 del plan (T3) se prueba sin DOM/jsdom: se llama
  // ejecutarAccion con un `api` de mocks (vi.fn()) y se assertea qué se llamó y con qué.
  //
  // `estado` = { cola, idx, sel (candidato elegido), detalle (con .version) } para apartar/vincular/no_existe/
  //   omitir_por_ahora, o { cola, idx, ultimoTipo: 'apartado'|'salteado', ultimoApartadoId, ultimoApartadoVersion,
  //   ultimoSalteadoId } para 'deshacer' (el tipo 'decision' del undo no pasa por acá: sigue viviendo en
  //   bandeja.js tal cual, porque necesita decision_id/versionNueva de una decisión ya guardada).
  // `api` = { apartar(caseId, expectedVersion), desapartar(caseId, expectedVersion), decidir(cuerpo),
  //           omitir(caseId), reabrir(caseId), mostrar(mensaje) } — cada método puede devolver lo que
  //           quiera, no se usa acá.
  function ejecutarAccion(accion, estado, api) {
    if (!accion) return;
    var caso = estado.cola[estado.idx];

    switch (accion.tipo) {
      case 'apartar':
        if (!caso || caso.apartado) return;
        api.apartar(caso.id, caso.version);
        return;

      case 'deshacer': {
        // Se limita a los dos tipos que agrega esta tarea; 'decision' sigue viviendo en bandeja.js
        // (necesita decision_id/versionNueva de una decisión ya guardada, que no pasa por acá).
        var casoApartado = estado.cola.filter(function (c) { return c.id === estado.ultimoApartadoId; })[0];
        if (estado.ultimoTipo === 'apartado' && casoApartado) {
          api.desapartar(casoApartado.id, estado.ultimoApartadoVersion);
          return;
        }
        if (estado.ultimoTipo === 'salteado' && estado.ultimoSalteadoId !== undefined) {
          api.reabrir(estado.ultimoSalteadoId);
          return;
        }
        return;
      }

      case 'omitir_por_ahora':
        if (!caso) return;
        api.omitir(caso.id);
        return;

      case 'vincular':
        if (estado.sel === null || estado.sel === undefined) { api.mostrar('Elegí un candidato'); return; }
        api.decidir({ expected_version: estado.detalle && estado.detalle.version, eleccion: 'vincular', variant_id: estado.sel });
        return;

      case 'no_vincular':
        api.decidir({ expected_version: estado.detalle && estado.detalle.version, eleccion: 'omitir' });
        return;

      case 'no_existe':
        api.decidir({ expected_version: estado.detalle && estado.detalle.version, eleccion: 'sin_candidato' });
        return;

      default:
        return;
    }
  }

  // Texto para la pantalla vacía cuando ya no quedan casos no salteados (Paso 2, T3).
  var TEXTO_SOLO_SALTEADOS = 'Sólo quedan casos que salteaste';

  // «Por qué» (T4): resumen corto de qué coincide y qué difiere/falta para un candidato, usando los
  // mismos nombres de atributos que ya arma nombresAtributos()/atributoDe(). 'equivalente' cuenta como
  // coincidencia para este resumen (la marca visual ya distingue ≈ de ✓ en la celda). Formato del mockup:
  // "modelo, color y talle coinciden" / "el color difiere; el talle falta" / mezcla de ambas con '; '.
  function porQue(opcion) {
    var e = (opcion && opcion.explicacion) || {};
    var lista = (e.atributos || []).concat(e.otros_atributos || []);
    if (!lista.length) return 'Sin atributos para comparar.';
    var coinciden = [], difieren = [], faltan = [];
    lista.forEach(function (a) {
      if (a.marca === 'coincide' || a.marca === 'equivalente') coinciden.push(a.nombre);
      else if (a.marca === 'falta') faltan.push(a.nombre);
      else difieren.push(a.nombre); // 'difiere' o cualquier marca desconocida
    });
    function listar(nombres) {
      if (nombres.length === 1) return nombres[0];
      if (nombres.length === 2) return nombres[0] + ' y ' + nombres[1];
      return nombres.slice(0, -1).join(', ') + ' y ' + nombres[nombres.length - 1];
    }
    var partes = [];
    if (coinciden.length) partes.push(listar(coinciden) + (coinciden.length > 1 ? ' coinciden' : ' coincide'));
    if (difieren.length) partes.push((difieren.length > 1 ? 'los atributos ' : 'el ') + listar(difieren) + (difieren.length > 1 ? ' difieren' : ' difiere'));
    if (faltan.length) partes.push((faltan.length > 1 ? 'los atributos ' : 'el ') + listar(faltan) + (faltan.length > 1 ? ' faltan' : ' falta'));
    // Cada parte ya es una oración corta salvo la primera (que arranca en minúscula, "modelo, color… coinciden");
    // se capitaliza sólo la primera letra del resumen entero.
    var texto = partes.join('; ') + '.';
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  }

  // Atributos con la MISMA marca en TODOS los candidatos (para colapsarlos en una sola fila «Iguales»).
  // Un atributo que falta en algún candidato (no tiene entrada) no cuenta como igual: no hay nada que comparar.
  function atributosIguales(opciones) {
    var nombres = nombresAtributos(opciones);
    return nombres.filter(function (n) {
      var marcas = (opciones || []).map(function (o) { var a = atributoDe(o, n); return a ? a.marca : null; });
      if (!marcas.length || marcas.some(function (m) { return m === null; })) return false;
      return marcas.every(function (m) { return m === marcas[0]; });
    });
  }

  var FRASES_TIPO = {
    sku_pendiente: 'revisá si el SKU observado corresponde al candidato',
    omitida_revisar: 'revisá la publicación que quedó apartada',
    sku_inexistente_en_woo: 'confirmá si existe una variante Woo para este SKU',
    woo_sin_sku: 'revisá título y atributos porque Woo no tiene SKU',
    woo_sku_duplicado: 'revisá la duplicación del SKU antes de vincular',
    woo_sku_no_canonico: 'revisá si el SKU de Woo es el canónico',
    decision_en_conflicto: 'compará la decisión vigente con la nueva evidencia',
    identidad_legado: 'revisá la identidad heredada y sus datos principales',
    user_product_divergente: 'revisá si ML y Woo representan la misma variante',
    atributo_divergente: 'revisá los atributos que difieren',
    categoria_en_desacuerdo: 'revisá la categoría en ambos canales',
    categoria_sin_mapeo: 'revisá la categoría sin mapeo',
    categoria_persona_contradicha: 'revisá la categoría sugerida y la evidencia',
    sku_cambiado: 'revisá el cambio de SKU',
    formato_cambiado: 'revisá el formato y la variante publicada'
  };
  function fraseTipo(tipo) { return FRASES_TIPO[tipo] || 'compará publicación y candidato antes de decidir'; }
  function valorAtributo(a, lado) {
    var original = lado === 'ml' ? a.valorMlOriginal : a.valorCandidatoOriginal;
    var valor = lado === 'ml' ? a.valorMl : a.valorCandidato;
    if (original !== undefined && original !== null && String(original).trim() !== '') return String(original);
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') return String(valor);
    return '—';
  }
  function diferenciasVisibles(explicacion) {
    var e = explicacion && explicacion.explicacion ? explicacion.explicacion : (explicacion || {});
    var vistos = {};
    var lista = (e.atributos || []).concat(e.otros_atributos || []).filter(function (a) {
      if (!a || !a.nombre || vistos[a.nombre]) return false;
      vistos[a.nombre] = true;
      return true;
    });
    var grupos = { difiere: [], falta: [], equivalente: [], coincide: [] };
    lista.forEach(function (a) {
      var marcaActual = a.marca === 'coincide' || a.marca === 'equivalente' ? a.marca : (a.marca === 'falta' ? 'falta' : 'difiere');
      var copy = marca(marcaActual);
      var fila = { nombre: a.nombre, marca: marcaActual, simbolo: copy.simbolo, texto: copy.texto,
        valorMl: valorAtributo(a, 'ml'), valorCandidato: valorAtributo(a, 'candidato') };
      grupos[marcaActual].push(fila);
    });
    var orden = ['difiere', 'falta', 'equivalente'];
    return {
      diferencias: orden.reduce(function (out, marca) { return out.concat(grupos[marca]); }, []),
      iguales: grupos.coincide.length,
      nombresIguales: grupos.coincide.map(function (a) { return a.nombre; })
    };
  }
  function textoDiferencias(n) {
    return n === 0 ? 'sin diferencias' : n + (n === 1 ? ' diferencia' : ' diferencias');
  }
  function resumenCandidato(opcion) {
    var titulo = opcion && opcion.titulo ? String(opcion.titulo) : 'Sin título';
    var limite = 28;
    return {
      titulo: titulo.length > limite ? titulo.slice(0, limite - 1) + '…' : titulo,
      diferencias: diferenciasVisibles(opcion && opcion.explicacion).diferencias.length
    };
  }
  function textoDecision(opcion, diferencias) {
    if (!opcion) return 'Elegí una acción para este caso';
    var sku = opcion.sku || 'este candidato';
    var lista = diferencias && diferencias.diferencias ? diferencias.diferencias : (diferencias || []);
    return 'Enter = VINCULAR a ' + sku + ' (' + textoDiferencias(lista.length) + ')';
  }

  function siguienteNivelZoom(nivel, accion) {
    var actual = Number(nivel);
    if (actual !== 1 && actual !== 2 && actual !== 3) actual = 1;
    if (accion === '0') return 1;
    if (accion === '-' || accion === 'menos') return actual === 1 ? 3 : actual - 1;
    return actual === 3 ? 1 : actual + 1;
  }

  function indiceCandidatoVisor(actual, n, delta) {
    n = Number(n) || 0;
    if (n < 1) return -1;
    var i = Number(actual);
    if (!Number.isInteger(i) || i < 0 || i >= n) i = delta < 0 ? 0 : -1;
    return (i + (Number(delta) < 0 ? -1 : 1) + n) % n;
  }

  function paresParaVisor(caso, opcion) {
    var publicacion = (caso && caso.publicacion) || {};
    var candidato = opcion || null;
    return {
      ml: {
        foto: publicacion.foto || publicacion.thumbnail || null,
        titulo: publicacion.titulo || 'Sin título',
        sku: publicacion.sku_observado || publicacion.sku || 'Sin SKU'
      },
      candidato: candidato ? {
        foto: candidato.foto || candidato.thumbnail || null,
        titulo: candidato.titulo || 'Sin título',
        sku: candidato.sku || 'Sin SKU'
      } : null
    };
  }

  var api = {
    marca: marca, copyError: copyError, puedeDispararAtajo: puedeDispararAtajo, esReintentable: esReintentable,
    demora: demora, MAX_INTENTOS: MAX_INTENTOS, puedeDeshacer: puedeDeshacer, textoCuentaRegresiva: textoCuentaRegresiva, totalFiltro: totalFiltro, formatoPrecio: formatoPrecio,
    formatoStock: formatoStock, opcionesDe: opcionesDe, nombresAtributos: nombresAtributos, atributoDe: atributoDe,
    filaVisible: filaVisible, accionDeTecla: accionDeTecla, siguienteNoSalteado: siguienteNoSalteado,
    indiceNoSalteado: indiceNoSalteado,
    ejecutarAccion: ejecutarAccion, TEXTO_SOLO_SALTEADOS: TEXTO_SOLO_SALTEADOS,
    porQue: porQue, atributosIguales: atributosIguales, fraseTipo: fraseTipo, diferenciasVisibles: diferenciasVisibles,
    textoDiferencias: textoDiferencias, resumenCandidato: resumenCandidato, textoDecision: textoDecision,
    siguienteNivelZoom: siguienteNivelZoom, indiceCandidatoVisor: indiceCandidatoVisor, paresParaVisor: paresParaVisor,
    GRUPOS: GRUPOS, GRUPO_NOMBRE: GRUPO_NOMBRE, VENTANA_DESHACER_MS: VENTANA_DESHACER_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BandejaLogica = api;
})(typeof window !== 'undefined' ? window : globalThis);
