import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Prueba el código real de public/bandeja-identidad/logica.js (no una copia).
// logica.js es un script clásico (UMD): en vitest se exporta como CommonJS-interop o cuelga de globalThis, como en el navegador.
const mod = await import('../public/bandeja-identidad/logica.js');
const L = mod.default?.marca ? mod.default : mod.marca ? mod : (globalThis.BandejaLogica ?? globalThis.window?.BandejaLogica);
const ev = (o = {}) => ({ key: 'j', target: { tagName: 'DIV', closest: () => null }, ...o });

describe('bandeja: logica pura', () => {
  it('tipo de caso y precio tienen copy legible para la estación', () => {
    expect(L.fraseTipo('sku_pendiente')).toMatch(/SKU/i);
    expect(L.fraseTipo('tipo_nuevo')).toMatch(/compar/i);
    expect(L.formatoPrecio(189900, 'ARS')).toBe('189.900 ARS');
  });

  it('diferencias se ordenan difiere, falta, equivalente y coincide', () => {
    const o = { explicacion: { atributos: [
      { nombre: 'igual', marca: 'coincide', valor: 'x' },
      { nombre: 'falta', marca: 'falta' },
      { nombre: 'cambia', marca: 'difiere', valor: 'y' },
      { nombre: 'equiv', marca: 'equivalente', valor: 'z' }
    ] } };
    expect(L.diferenciasVisibles(o, { atributos: { cambia: 'm' } }).map((x) => x.marca)).toEqual(['difiere', 'falta', 'equivalente', 'coincide']);
    expect(L.textoDecision({ sku: 'FB-1' }, L.diferenciasVisibles(o, {}))).toMatch(/FB-1 \(2 diferencias\)/);
  });
  it('marcas: símbolo + texto para cada una y no se rompe con una desconocida', () => {
    expect(L.marca('coincide')).toMatchObject({ simbolo: '✓', texto: 'coincide' });
    expect(L.marca('difiere').simbolo).toBe('≠');
    expect(L.marca('falta').simbolo).toBe('—');
    expect(L.marca('equivalente').simbolo).toBe('≈');
    expect(L.marca('xyz').texto).toBe('xyz');
  });

  it('copy de errores: cada código de la API tiene su texto de la spec', () => {
    for (const c of ['version_conflict', 'caso_cerrado', 'revierte_no_vigente', 'solo_admin', 'variante_invalida',
      'caso_sin_publicacion', 'idempotency_mismatch', 'caso_inexistente', 'bandeja_apagada', 'plataforma_no_responde']) {
      expect(L.copyError(c)).not.toMatch(/No se pudo completar/);
    }
    expect(L.copyError('otro')).toMatch(/otro/);
  });

  it('atajos: apagados, con modificadores, escribiendo o dentro de un diálogo no disparan', () => {
    expect(L.puedeDispararAtajo(ev(), true)).toBe(true);
    expect(L.puedeDispararAtajo(ev(), false)).toBe(false);
    for (const m of ['ctrlKey', 'altKey', 'metaKey']) expect(L.puedeDispararAtajo(ev({ [m]: true }), true)).toBe(false);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(L.puedeDispararAtajo(ev({ target: { tagName, closest: () => null } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', closest: (s) => (s === 'dialog' ? {} : null) } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', isContentEditable: true, closest: () => null } }), true)).toBe(false);
  });

  it('reintento: sólo red caída, 429 y 5xx; un 4xx es definitivo', () => {
    for (const s of [0, 429, 500, 502, 503]) expect(L.esReintentable(s)).toBe(true);
    for (const s of [200, 400, 403, 404, 409, 422]) expect(L.esReintentable(s)).toBe(false);
    // backoff exponencial con jitter ±25 %, tope de 15 s, y 5 intentos en total
    expect(L.demora(0, () => 0.5)).toBe(1000);
    expect(L.demora(1, () => 0.5)).toBe(2000);
    expect(L.demora(3, () => 0.5)).toBe(8000);
    expect(L.demora(99, () => 0.5)).toBe(15000);
    expect(L.demora(2, () => 0)).toBe(3000);
    expect(L.demora(2, () => 1)).toBe(5000);
    expect(L.MAX_INTENTOS).toBe(5);
  });

  it('deshacer: vale 10 s, una sola vez, y sólo si hay una decisión', () => {
    const u = { ts: 1000, consumida: false };
    expect(L.puedeDeshacer(u, 1000 + 10000)).toBe(true);
    expect(L.puedeDeshacer(u, 1000 + 10001)).toBe(false);
    expect(L.puedeDeshacer({ ...u, consumida: true }, 1500)).toBe(false);
    expect(L.puedeDeshacer(null, 1500)).toBe(false);
  });

  it('total del filtro: suma de grupos (sin no_decidibles) o el del grupo elegido, incluye confirmable y sin_titulo', () => {
    const c = { conflictos: 1, d5: 2, sku_exacto: 3, activas_con_stock: 4, resto: 5, confirmable: 6, sin_titulo: 7, no_decidibles: 99 };
    expect(L.totalFiltro(c, null)).toBe(28);
    expect(L.totalFiltro(c, 1)).toBe(2);
    expect(L.totalFiltro(c, 5)).toBe(6);
    expect(L.totalFiltro(c, 6)).toBe(7);
    expect(L.totalFiltro({}, 4)).toBe(0);
  });

  it('grupos: confirmable (5) y sin_titulo (6) están en el mapa y el nombrero, en ese orden', () => {
    expect(L.GRUPOS.confirmable).toBe(5);
    expect(L.GRUPOS.sin_titulo).toBe(6);
    expect(L.GRUPO_NOMBRE[5]).toMatch(/confirm/i);
    expect(L.GRUPO_NOMBRE[6]).toMatch(/sin.*t[ií]tulo/i);
  });

  it('precio y stock sin dato no dicen «null»', () => {
    expect(L.formatoPrecio(null, null)).toBe('Sin precio');
    expect(L.formatoPrecio(1500, 'ARS')).toBe('1.500 ARS');
    expect(L.formatoStock(null)).toBe('Stock sin dato');
    expect(L.formatoStock(0)).toBe('0 en stock');
  });

  it('opciones = candidatos + búsqueda sin repetir la misma variante', () => {
    const c = [{ variant_id: 'a' }, { variant_id: 'b' }];
    expect(L.opcionesDe(c, [{ variant_id: 'b' }, { variant_id: 'c' }]).map((o) => o.variant_id)).toEqual(['a', 'b', 'c']);
  });

  it('sólo diferencias oculta las filas donde todo coincide y deja las que difieren o faltan', () => {
    const ops = [{ explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }, { nombre: 'talle', marca: 'difiere' }], otros_atributos: [{ nombre: 'marca', marca: 'falta' }] } }];
    expect(L.nombresAtributos(ops)).toEqual(['color', 'talle', 'marca']);
    expect(L.filaVisible(ops, 'color', true)).toBe(false);
    expect(L.filaVisible(ops, 'talle', true)).toBe(true);
    expect(L.filaVisible(ops, 'marca', true)).toBe(true);
    expect(L.filaVisible(ops, 'color', false)).toBe(true);
  });

  it('sólo diferencias: un candidato SIN dato para el atributo (ni siquiera "falta") no se oculta, aunque otro coincida', () => {
    // Corrección de un hallazgo Alto de Codex en T4: ocultar esta fila haría parecer que el candidato sin
    // dato coincide, empujando a un vínculo equivocado — justo lo que el rediseño busca evitar.
    const ops = [
      { explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }] } },
      { explicacion: { atributos: [] } }, // sin entrada para 'color': ni coincide, ni difiere, ni falta
    ];
    expect(L.filaVisible(ops, 'color', true)).toBe(true);
  });

  it('sólo diferencias: equivalente cuenta como coincidencia (no fuerza la fila a visible)', () => {
    const ops = [{ explicacion: { atributos: [{ nombre: 'rodado', marca: 'equivalente' }] } }];
    expect(L.filaVisible(ops, 'rodado', true)).toBe(false);
  });

  it('sólo diferencias: atributo ausente en TODOS los candidatos (no sólo en uno) se muestra', () => {
    // Sugerencia Baja de Codex tras el fix: pinnear el caso donde ningún candidato tiene el atributo,
    // no sólo el caso mixto (uno con dato, otro sin) que ya cubre el test anterior.
    const ops = [
      { explicacion: { atributos: [] } },
      { explicacion: { atributos: [] } },
    ];
    expect(L.filaVisible(ops, 'color', true)).toBe(true);
  });

  it('sólo diferencias: sin candidatos (arreglo vacío) no hay nada que difiera → oculta', () => {
    // Sugerencia Baja de Codex: comportamiento no especificado antes, ahora pinneado. Es inalcanzable desde
    // la UI real (los nombres de fila salen de los propios candidatos), pero queda fijado por si se llama
    // a filaVisible directamente desde otro lado.
    expect(L.filaVisible([], 'color', true)).toBe(false);
  });
});

describe('bandeja: atajos sobre radios', () => {
  it('un radio enfocado no bloquea los atajos (sólo los campos de texto)', () => {
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'radio', closest: () => null } }, true)).toBe(true);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'search', closest: () => null } }, true)).toBe(false);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'text', closest: () => null } }, true)).toBe(false);
  });
});

describe('bandeja: deshacer() no se dispara dos veces (regresión de T3)', () => {
  // El bug real: al reescribir deshacer() para apartado/salteado se cambió el guard de entrada de
  // L.puedeDeshacer(u, ahora) (que exige !consumida) a un chequeo inline que sólo miraba `ts`, así que
  // una Z repetida dentro de los 10 s volvía a disparar el undo (POST/DELETE duplicado). Se corrigió
  // volviendo a delegar el guard en L.puedeDeshacer; este test fija ese comportamiento por código fuente
  // (no hay DOM real acá, ver la nota de la Tarea 3 sobre jsdom) y por la lógica pura ya cubierta arriba.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('el guard de entrada de deshacer() delega en L.puedeDeshacer (que exige !consumida)', () => {
    const cuerpo = js.match(/function deshacer\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(cuerpo).toMatch(/L\.puedeDeshacer\(u, Date\.now\(\)\)/);
  });

  it('las 3 formas de S.ultima (decisión, apartado, salteado) siempre incluyen ts y consumida', () => {
    // apartar(): S.ultima = { tipo: 'apartado', ... }
    const apartar = js.match(/function apartar\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(apartar).toMatch(/S\.ultima = \{[^}]*ts: Date\.now\(\)[^}]*consumida: false[^}]*\}/);
    // omitirPorAhora(): S.ultima = { tipo: 'salteado', ... }
    const omitir = js.match(/function omitirPorAhora\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(omitir).toMatch(/S\.ultima = \{[^}]*ts: Date\.now\(\)[^}]*consumida: false[^}]*\}/);
    // decidir(): S.ultima = { entry, ts, consumida } (forma vieja, sin tocar)
    const decidir = js.match(/function decidir\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(decidir).toMatch(/S\.ultima = \{ entry: entry, ts: Date\.now\(\), consumida: false \}/);
  });
});

describe('bandeja: consume el nombre real del tipo del detalle', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('pasa detalle.tipo a la lógica de teclas, no el nombre inexistente tipo_caso', () => {
    expect(js).toMatch(/tipoCaso:\s*S\.detalle\.tipo\b/);
    expect(js).not.toMatch(/tipoCaso:\s*S\.detalle\.tipo_caso\b/);
  });
});

describe('bandeja: tecla X en confirmable — d5 (T5, hallazgo Alto de Codex)', () => {
  // Bug real preexistente (de la pantalla original, commit 1ca92ee4, no de T2-T4): la rama 'rechazar' del
  // switch de teclas leía `cs.detalle.d5`, pero `cs` es una fila de S.cola (GET /casos), donde d5 viene
  // PLANO (api/identidad-interna.ts: `d5: f.detalle && f.detalle.d5 === true`), no anidado bajo `.detalle`
  // como en el detalle de GET /casos/:id (que sí tiene `detalle: c.detalle` crudo). Como `cs.detalle` nunca
  // existe, `omisionVigente` daba siempre false y X mandaba 'sin_candidato' en vez de 'mantener_omision'
  // para un caso D5 vigente — cambiaba la decisión real que se le manda a la plataforma.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it("la rama 'rechazar' lee cs.d5 (plano), no cs.detalle.d5 (anidado, no existe en la fila de cola)", () => {
    const cuerpo = js.match(/case 'rechazar':[\s\S]*?break;/)[0];
    // El código ejecutable (línea del if) usa cs.d5; el bug corregido se documenta en un comentario que
    // sí menciona "cs.detalle" entre comillas — por eso se chequea la línea del if, no todo el bloque.
    const lineaIf = cuerpo.split('\n').find((l) => l.includes('if (cs'));
    expect(lineaIf).toMatch(/cs\.d5 === true/);
    expect(lineaIf).not.toMatch(/cs\.detalle/);
  });

  it("el botón 'No es este' en modo confirmable sí puede seguir leyendo d.detalle.d5 (el detalle, no la fila de cola)", () => {
    // d.detalle.d5 es correcto ACÁ porque `d` es el detalle de GET /casos/:id, que sí anida `detalle: c.detalle`.
    // No es el mismo bug: no hay que "unificar" los dos accesos, son formas distintas a propósito.
    const cuerpo = js.match(/var omisionVigente = [\s\S]*?No es este \(X\)[\s\S]*?\n {4}\}/)[0];
    expect(cuerpo).toMatch(/d\.detalle && d\.detalle\.d5 === true/);
  });
});

describe('bandeja: ejecutarAccion — Paso 2 de T3, sin DOM (decisión pura de qué llamar)', () => {
  function apiFalsa() {
    return { apartar: vi.fn(), desapartar: vi.fn(), decidir: vi.fn(), omitir: vi.fn(), reabrir: vi.fn(), mostrar: vi.fn() };
  }

  it('? aparta el caso actual con su versión, una sola vez', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3, apartado: false }], idx: 0 };
    L.ejecutarAccion({ tipo: 'apartar' }, estado, api);
    expect(api.apartar).toHaveBeenCalledTimes(1);
    expect(api.apartar).toHaveBeenCalledWith('c1', 3);
  });

  it('? sobre un caso ya apartado no llama a apartar de nuevo', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3, apartado: true }], idx: 0 };
    L.ejecutarAccion({ tipo: 'apartar' }, estado, api);
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('Z después de apartar llama a desapartar con la versión nueva, y NUNCA a decidir', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3 }], idx: -1, ultimoTipo: 'apartado', ultimoApartadoId: 'c1', ultimoApartadoVersion: 4 };
    L.ejecutarAccion({ tipo: 'deshacer' }, estado, api);
    expect(api.desapartar).toHaveBeenCalledTimes(1);
    expect(api.desapartar).toHaveBeenCalledWith('c1', 4);
    expect(api.decidir).not.toHaveBeenCalled();
  });

  it('Z después de omitir por ahora reabre el caso salteado (sin apartar ni decidir)', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c2' }], idx: -1, ultimoTipo: 'salteado', ultimoSalteadoId: 'c2' };
    L.ejecutarAccion({ tipo: 'deshacer' }, estado, api);
    expect(api.reabrir).toHaveBeenCalledWith('c2');
    expect(api.apartar).not.toHaveBeenCalled();
    expect(api.decidir).not.toHaveBeenCalled();
  });

  it('2 solo (seleccionar) no llama a ninguna acción de la api: sólo Enter decide', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: null, detalle: { version: 1 } };
    // 'seleccionar' no es un caso manejado por ejecutarAccion (lo maneja bandeja.js con S.sel directamente,
    // no hace ninguna llamada a la api): confirma que no dispara nada.
    L.ejecutarAccion({ tipo: 'seleccionar', n: 2 }, estado, api);
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('2 y después Enter: decidir se llama con eleccion vincular y el variant_id seleccionado', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: 'variante-2', detalle: { version: 5 } };
    L.ejecutarAccion({ tipo: 'vincular' }, estado, api);
    expect(api.decidir).toHaveBeenCalledWith({ expected_version: 5, eleccion: 'vincular', variant_id: 'variante-2' });
  });

  it('Enter sin selección no decide y avisa "Elegí un candidato" en vez de vincular a undefined', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: null, detalle: { version: 5 } };
    L.ejecutarAccion({ tipo: 'vincular' }, estado, api);
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.mostrar).toHaveBeenCalledWith('Elegí un candidato');
  });

  it('O (omitir_por_ahora) llama a omitir con el id del caso actual y no hace ningún decidir/apartar', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c3' }], idx: 0 };
    L.ejecutarAccion({ tipo: 'omitir_por_ahora' }, estado, api);
    expect(api.omitir).toHaveBeenCalledWith('c3');
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('siguienteNoSalteado sobre el último caso, con sólo salteados restantes, no da vueltas infinitas (-1)', () => {
    const cola = [{ id: 'a' }, { id: 'b' }];
    expect(L.siguienteNoSalteado(cola, 0, new Set(['b']))).toBe(-1);
  });

  it('texto de cola agotada por salteados coincide con lo que muestra bandeja.js', () => {
    expect(L.TEXTO_SOLO_SALTEADOS).toBe('Sólo quedan casos que salteaste');
  });

  it('grupos: apartados (7) está en GRUPOS y GRUPO_NOMBRE', () => {
    expect(L.GRUPOS.apartados).toBe(7);
    expect(L.GRUPO_NOMBRE[7]).toMatch(/apartado/i);
  });
});

describe('bandeja: aria-keyshortcuts (chequeo estático sobre bandeja.js, patrón del repo sin DOM)', () => {
  // Los botones de acciones se arman dinámicamente en bandeja.js (el('button', ..., { id, 'aria-keyshortcuts' })),
  // no son markup estático de index.html. Se busca la llamada a el(...) de cada botón con tecla.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  const botonesConTecla = ['btn-vincular', 'btn-buscar', 'btn-apartar', 'btn-omitir-ahora', 'btn-no-existe', 'btn-confirmar', 'btn-rechazar'];

  it.each(botonesConTecla)('el botón %s se arma con aria-keyshortcuts y muestra la tecla en el texto', (id) => {
    const m = js.match(new RegExp("el\\('button'[^;]*?id: '" + id + "'[^}]*\\}\\)"));
    expect(m, `no se encontró el armado del botón ${id} en bandeja.js`).not.toBeNull();
    expect(m[0]).toMatch(/aria-keyshortcuts/);
    // El texto del botón (antes de los attrs) debe traer la tecla entre paréntesis, ej. "(Enter)"/"(?)"/"(O)".
    expect(m[0]).toMatch(/\([^)]+\)/);
  });

  it('el botón "No vincular esta publicación" no tiene tecla asignada (S1): sin aria-keyshortcuts', () => {
    const m = js.match(/el\('button'[^;]*?id: 'btn-no-vincular'[^}]*\}\)/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toMatch(/aria-keyshortcuts/);
  });
});

describe('bandeja: renderMatriz — fila «Por qué» y fila «Iguales» colapsada (T4, chequeo estático)', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');
  const cuerpo = js.match(/function renderMatriz\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];

  it('la fila «Por qué» se arma después de las filas de atributos (última fila de la tabla)', () => {
    const idxIguales = cuerpo.indexOf('fila-iguales');
    const idxAtributos = cuerpo.indexOf('nombresAtributos(opciones).forEach');
    const idxPorQue = cuerpo.indexOf('fila-porque');
    expect(idxIguales).toBeGreaterThan(-1);
    expect(idxAtributos).toBeGreaterThan(-1);
    expect(idxPorQue).toBeGreaterThan(-1);
    // Orden en el código = orden en el que se appendean las filas a la matriz = orden visual.
    expect(idxIguales).toBeLessThan(idxAtributos);
    expect(idxAtributos).toBeLessThan(idxPorQue);
  });

  it('cada celda de «Por qué» usa L.porQue(o) por candidato', () => {
    expect(cuerpo).toMatch(/L\.porQue\(o\)/);
  });

  it('la fila «Iguales» tiene un botón que expande/colapsa (aria-expanded) y no depende de S.soloDif', () => {
    const filaIguales = cuerpo.slice(cuerpo.indexOf('fila-iguales'), cuerpo.indexOf('L.nombresAtributos(opciones).forEach'));
    expect(filaIguales).toMatch(/aria-expanded/);
    expect(filaIguales).toMatch(/S\.mostrarIguales = !S\.mostrarIguales/);
    // A diferencia de las filas de atributos sueltas, el bloque de «Iguales» no consulta L.filaVisible/S.soloDif:
    // sigue mostrándose con "Sólo diferencias" activo, tal como pide el plan.
    expect(filaIguales).not.toMatch(/filaVisible|S\.soloDif/);
  });

  it('un atributo colapsado en «Iguales» no se repite como fila suelta salvo que S.mostrarIguales esté activo', () => {
    const bucleAtributos = cuerpo.slice(cuerpo.indexOf('L.nombresAtributos(opciones).forEach'), cuerpo.indexOf('fila-porque'));
    expect(bucleAtributos).toMatch(/esIgual = !!igualesSet\[n\]/);
    expect(bucleAtributos).toMatch(/esIgual && !S\.mostrarIguales/);
  });

  it('el botón «Iguales» declara aria-controls apuntando a las filas que expande (hallazgo de Codex en T4)', () => {
    expect(cuerpo).toMatch(/btnIguales\.setAttribute\('aria-controls'/);
  });

  it('S.mostrarIguales se resetea al abrir cada caso (no es una preferencia de sesión como soloDif)', () => {
    const abrirCaso = js.match(/function abrirCaso\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(abrirCaso).toMatch(/S\.mostrarIguales = false/);
  });
});
