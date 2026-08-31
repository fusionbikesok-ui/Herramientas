/**
 * Sistema de incidentes operativos: detecta, registra y comunica fallos graves de
 * integraciones (ML/WooCommerce) sin depender de que un humano mire logs de PM2 en vivo.
 *
 * Flujo: `abrirOActualizarIncidente` se llama desde routes/matcher.js y routes/woo.js cada
 * vez que una llamada a la integración falla de forma clasificable; `confirmarCicloSano` se
 * llama al final de cada ciclo completo de sync SIN errores de esa integración/proceso, y
 * es la ÚNICA vía de resolución — nunca se resuelve por una sola llamada exitosa aislada
 * (evita "flapping": abrir y cerrar el mismo incidente en cada request individual).
 *
 * Decisiones deliberadamente diferidas a un hito posterior (anotadas acá para no perderlas,
 * no son bugs de este hito):
 *  - Solo hay estados 'activo'/'resuelto'. Un futuro "reconocido/silenciado por un admin"
 *    necesita decidir si es un estado más (y entonces el índice único parcial `WHERE
 *    estado='activo'` tiene que ampliarse a todos los estados "no resueltos") o una columna
 *    aparte (`silenciado_hasta`) que no interfiera con el dedupe.
 *  - `ultima_recuperacion_en` hoy siempre coincide con `resuelto_en` (confirmarCicloSano las
 *    setea juntas) — si en el futuro divergen (ej. "se recuperó pero un admin no lo cerró
 *    formalmente todavía") ahí cobra sentido tener las dos columnas separadas.
 *
 * CONDICIÓN para el hito que conecte esto a routes/matcher.js/routes/woo.js (hallazgo del
 * revisor, verificado empíricamente, no bloqueante HOY porque este módulo todavía no tiene
 * ningún caller): `PATRONES_CLAVE_VALOR` no matchea un secreto dentro de un JSON crudo sin
 * parsear (`'{"access_token":"ABC"}'` — la comilla entre la clave y `:` rompe el patrón) ni
 * variantes con guion (`x-access-token=`) o prefijo (`ml_access_token=`). Si un caller real
 * llega a pasar `contexto: { body: await res.text() }` con la respuesta cruda de ML/Woo antes
 * de parsearla, ese secreto se persiste sin redactar. Ampliar el regex antes de cablear el
 * primer caller que pueda pasar un body crudo.
 */

import { enviarAlertaIncidente } from './mailer.js';

const alertasIncidenteEnVuelo = new Set();

function notificarIncidenteSiCorresponde(db, incidente, recuperado = false) {
  if (!incidente) return;
  let eventos;
  try {
    eventos = new Set(db.prepare(
      'SELECT evento FROM incidentes_operativos_historial WHERE incidente_id = ? AND evento IN (?, ?)'
    ).all(incidente.id, 'email_alerta_caida', 'email_alerta_recuperada').map(r => r.evento));
  } catch (_) { return; }
  if (recuperado) {
    if (!eventos.has('email_alerta_caida') || eventos.has('email_alerta_recuperada')) return;
  } else {
    if (eventos.has('email_alerta_caida') || incidente.severidad !== 'critico') {
      let contexto = {};
      try { contexto = incidente.contexto_json ? JSON.parse(incidente.contexto_json) : {}; } catch (_) { return; }
      if (eventos.has('email_alerta_caida') || !contexto.circuitoAbierto) return;
    }
  }
  const clave = `${incidente.id}:${recuperado ? 'recuperada' : 'caida'}`;
  if (alertasIncidenteEnVuelo.has(clave)) return;
  alertasIncidenteEnVuelo.add(clave);
  enviarAlertaIncidente({ to: process.env.ALERTAS_EMAIL, incidente, recuperado })
    .then(resultado => {
      if (!resultado?.enviado) return;
      try { db.prepare('INSERT INTO incidentes_operativos_historial (incidente_id, evento, detalle_json, creado_en) VALUES (?, ?, ?, ?)').run(incidente.id, recuperado ? 'email_alerta_recuperada' : 'email_alerta_caida', null, now()); } catch (_) { /* fail-open */ }
    })
    .finally(() => alertasIncidenteEnVuelo.delete(clave));
}

const CLAVES_SECRETAS = /token|secret|password|authorization|api[-_]?key|cookie|credential|clave/i;
// Reemplaza SOLO la región sospechosa dentro del string (hallazgo del revisor: nulificar el
// string entero por contener la PALABRA "access_token" destruye justo los mensajes de error
// de auth de ML que más hace falta leer, ej. "invalid access_token for user"). Cada patrón
// captura el prefijo/nombre para conservarlo y solo tapa el valor que sigue.
// Pares clave=valor (o clave:valor): se conserva el nombre de la clave, solo se tapa el valor
// — "access_token=xyz" -> "access_token=[redactado]", útil para diagnosticar CUÁL parámetro
// traía el secreto sin revelar el secreto en sí.
const PATRONES_CLAVE_VALOR = /\b(access_token|api_key|client_secret|refresh_token)\s*[=:]\s*[^&\s"',}]+/gi;
// Secretos "bare" sin estructura clave=valor — se redactan enteros, no hay nombre que conservar.
const PATRONES_VALOR_BARE = [
  /\bBearer\s+[^\s"',}]+/gi,
  /\bAPP_USR-[^\s"',}]+/gi, // credencial de app de ML
  /\bTG-[^\s"',}]+/gi,      // refresh token de ML
];
const PROFUNDIDAD_MAX_SANITIZACION = 4; // suficiente para {respuesta:{headers:{...}}}, corta un ciclo/objeto patológico
const STRING_MAX_LEN = 2000;   // un body de error de ML no necesita más para diagnosticar
const ARRAY_MAX_ITEMS = 50;    // igual: una lista de "intentos" no necesita cientos de filas

function now() {
  return new Date().toISOString();
}

function redactarValorSecreto(valor) {
  let limpio = valor.replace(PATRONES_CLAVE_VALOR, (match) => {
    const clave = match.match(/^[a-z_]+/i)[0];
    return `${clave}=[redactado]`;
  });
  for (const patron of PATRONES_VALOR_BARE) limpio = limpio.replace(patron, '[redactado]');
  return limpio;
}

/**
 * Sanitiza el contexto antes de persistirlo: recorre objetos y arrays recursivamente (hallazgo
 * del revisor: la versión anterior solo miraba el primer nivel y solo nombres de clave, así que
 * `{respuesta: err.response}` con un `access_token` adentro pasaba entero), removiendo claves
 * que matcheen un patrón de secreto y redactando SOLO la región de un valor string que por su
 * FORMA delata un secreto (no el string entero — hallazgo del revisor: un mensaje de error que
 * simplemente MENCIONA "access_token" es justo el que más hace falta leer). Trunca strings y
 * arrays largos (un body de error completo no debe convertirse en una fila gigante por segundo
 * durante una tormenta de fallos). Nunca confía en que el llamador limpie antes de pasar el
 * contexto — defensa en profundidad, no la única línea.
 */
function sanitizarValor(valor, profundidad) {
  if (valor instanceof Error) {
    return { name: valor.name, message: sanitizarValor(valor.message, profundidad + 1) };
  }
  if (typeof valor === 'string') {
    const limpio = redactarValorSecreto(valor);
    return limpio.length > STRING_MAX_LEN ? `${limpio.slice(0, STRING_MAX_LEN)}…[truncado]` : limpio;
  }
  if (profundidad > PROFUNDIDAD_MAX_SANITIZACION) {
    return (Array.isArray(valor) || (valor && typeof valor === 'object')) ? '[omitido: demasiado profundo]' : valor;
  }
  if (Array.isArray(valor)) {
    const recortado = valor.slice(0, ARRAY_MAX_ITEMS).map(v => sanitizarValor(v, profundidad + 1));
    if (valor.length > ARRAY_MAX_ITEMS) recortado.push(`…[${valor.length - ARRAY_MAX_ITEMS} más, truncado]`);
    return recortado;
  }
  if (valor && typeof valor === 'object') {
    const limpio = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (CLAVES_SECRETAS.test(clave)) { limpio[clave] = '[redactado]'; continue; }
      limpio[clave] = sanitizarValor(v, profundidad + 1);
    }
    return limpio;
  }
  return valor; // number, boolean, null, undefined: nada que sanitizar
}

function sanitizarContexto(contexto) {
  if (!contexto || typeof contexto !== 'object') return null;
  const limpio = sanitizarValor(contexto, 0);
  return Object.keys(limpio).length ? limpio : null;
}

/**
 * Exporta sanitizarValor para que los routers puedan sanitizar strings antes de pasarlos
 * (ej. mensaje_tecnico). Uso: sanitizar cualquier string que venga del caller.
 */
export function sanitizarString(valor) {
  if (typeof valor !== 'string') return valor;
  return sanitizarValor(valor, 0);
}

function claveDedupe(integracion, proceso, tipoError) {
  return `${integracion}|${proceso}|${tipoError}`;
}

// Orden de severidad para decidir si una repetición "escala" el incidente existente.
// Object.create(null): sin prototipo, así que 'constructor'/'toString' nunca cuelan como
// severidad "conocida" por accidente (hallazgo del revisor, no hay bug real hoy pero cierra
// la puerta).
const RANGO_SEVERIDAD = Object.assign(Object.create(null), { info: 0, advertencia: 1, critico: 2 });
const SEVERIDAD_DEFAULT = 'advertencia';

function normalizarSeveridad(severidad) {
  return Object.prototype.hasOwnProperty.call(RANGO_SEVERIDAD, severidad) ? severidad : SEVERIDAD_DEFAULT;
}

/**
 * Abre un incidente nuevo o actualiza el activo existente con la misma clave de dedupe
 * (integracion|proceso|tipoError). better-sqlite3 es síncrono: dentro de un mismo proceso
 * Node no hay overlap real entre dos llamadas, así que el dedupe (SELECT activo → INSERT o
 * UPDATE) no tiene ventana de carrera intra-proceso. El índice único parcial sobre
 * `clave_dedupe` (WHERE estado='activo') es la garantía a nivel de constraint: si dos
 * PROCESOS distintos escribieran el mismo sqlite al mismo tiempo, el segundo INSERT
 * fallaría por el índice en vez de crear un duplicado silencioso — hoy ML/Woo corren en un
 * único proceso PM2, así que ese caso no está ejercitado, pero la constraint queda como red.
 *
 * Nunca pisa severidad hacia abajo: una racha de fallos `advertencia` después de uno
 * `critico` no baja la severidad ya registrada, solo escala hacia arriba. Una `severidad`
 * desconocida (typo, valor legado) cae a `SEVERIDAD_DEFAULT` en vez de romper el INSERT o
 * quedar invisible para los filtros de `listarIncidentes`.
 *
 * FAIL-OPEN a propósito (hallazgo del revisor): esto se llama desde el `catch` de un ciclo de
 * sync real de ML/Woo — si el registro del incidente en sí fallara (disco lleno, DB bloqueada),
 * NUNCA debe enmascarar ni interrumpir el manejo del error original que lo disparó. Devuelve
 * `{ id: null, creado: false, escalado: false, error: true }` en vez de lanzar.
 */
export function abrirOActualizarIncidente(db, { integracion, proceso, tipoError, severidad, mensajeTecnico, mensajeHumano, contexto }) {
  try {
    const severidadPedida = normalizarSeveridad(severidad);
    const mensaje = mensajeHumano || 'Fallo detectado sin mensaje descriptivo.';
    const clave = claveDedupe(integracion, proceso, tipoError);
    const contextoLimpio = sanitizarContexto(contexto);
    const contextoJson = contextoLimpio ? JSON.stringify(contextoLimpio) : null;
    // Sanitizar mensaje_tecnico antes de persistirlo (ej. redacta secretos en error messages)
    const mensajeTecnicoLimpio = mensajeTecnico ? sanitizarValor(mensajeTecnico, 0) : null;
    const ts = now();

    const insertarHistorial = db.prepare(
      'INSERT INTO incidentes_operativos_historial (incidente_id, evento, detalle_json, creado_en) VALUES (?, ?, ?, ?)'
    );

    const tx = db.transaction(() => {
      const activo = db.prepare(
        "SELECT * FROM incidentes_operativos WHERE clave_dedupe = ? AND estado = 'activo'"
      ).get(clave);

      if (!activo) {
        const info = db.prepare(`
          INSERT INTO incidentes_operativos
            (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_tecnico,
             mensaje_humano, contexto_json, contador_repeticiones, primera_deteccion_en,
             ultima_deteccion_en, creado_en, actualizado_en)
          VALUES (?, ?, ?, ?, ?, 'activo', ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(integracion, proceso, tipoError, clave, severidadPedida, mensajeTecnicoLimpio, mensaje, contextoJson, ts, ts, ts, ts);
        insertarHistorial.run(
          info.lastInsertRowid, 'abierto',
          JSON.stringify({ severidad: severidadPedida, mensajeHumano: mensaje, mensajeTecnico: mensajeTecnicoLimpio, contexto: contextoLimpio }),
          ts
        );
        const incidente = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(info.lastInsertRowid);
        notificarIncidenteSiCorresponde(db, incidente);
        return { id: info.lastInsertRowid, creado: true, escalado: false };
      }

      const severidadFinal = RANGO_SEVERIDAD[severidadPedida] > RANGO_SEVERIDAD[activo.severidad]
        ? severidadPedida
        : activo.severidad;
      const escalado = severidadFinal !== activo.severidad;

      db.prepare(`
        UPDATE incidentes_operativos SET
          severidad = ?, mensaje_tecnico = ?, mensaje_humano = ?, contexto_json = ?,
          contador_repeticiones = contador_repeticiones + 1,
          ultima_deteccion_en = ?, actualizado_en = ?
        WHERE id = ?
      `).run(severidadFinal, mensajeTecnicoLimpio, mensaje, contextoJson, ts, ts, activo.id);

      insertarHistorial.run(
        activo.id,
        escalado ? 'escalado' : 'repetido',
        JSON.stringify({
          severidadAnterior: activo.severidad, severidadNueva: severidadFinal,
          mensajeHumano: mensaje, mensajeTecnico: mensajeTecnicoLimpio, contexto: contextoLimpio,
        }),
        ts
      );
      const incidente = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(activo.id);
      notificarIncidenteSiCorresponde(db, incidente);
      return { id: activo.id, creado: false, escalado };
    });

    return tx();
  } catch (e) {
    console.error('[incidentes] error registrando incidente (fail-open, no interrumpe el llamador):', e.message);
    return { id: null, creado: false, escalado: false, error: true };
  }
}

/**
 * Confirma que un ciclo completo de sync de `integracion`/`proceso` terminó SIN errores de
 * esa clase — es la única señal que puede resolver un incidente. Si no hay incidente activo
 * para esa integración/proceso, no hace nada (no es un error, es el camino feliz normal).
 *
 * `tipoError` es opcional: si se pasa, resuelve solo esa clase de error puntual (ej. un ciclo
 * sano específicamente respecto de rate_limit, aunque siga habiendo un incidente de auth
 * abierto en paralelo). Si se omite, resuelve TODOS los incidentes activos de esa
 * integración/proceso — usar con cuidado, solo cuando el ciclo cubrió todas las clases.
 *
 * FAIL-OPEN, misma política y mismo motivo que `abrirOActualizarIncidente` (hallazgo del
 * revisor): esto se llama al final de un ciclo de sync EXITOSO — si el propio registro de la
 * resolución fallara (disco lleno, DB bloqueada), nunca debe convertir un ciclo sano en uno
 * fallido ni disparar un incidente falso por su culpa.
 */
export function confirmarCicloSano(db, { integracion, proceso, tipoError }) {
  try {
    const ts = now();
    const filtro = tipoError
      ? "WHERE integracion = ? AND proceso = ? AND tipo_error = ? AND estado = 'activo'"
      : "WHERE integracion = ? AND proceso = ? AND estado = 'activo'";
    const params = tipoError ? [integracion, proceso, tipoError] : [integracion, proceso];

    const activos = db.prepare(`SELECT id FROM incidentes_operativos ${filtro}`).all(...params);
    if (activos.length === 0) return { resueltos: 0 };

    const insertarHistorial = db.prepare(
      'INSERT INTO incidentes_operativos_historial (incidente_id, evento, detalle_json, creado_en) VALUES (?, ?, ?, ?)'
    );
    const resolverUno = db.prepare(`
      UPDATE incidentes_operativos SET
        estado = 'resuelto', ultima_recuperacion_en = ?, resuelto_en = ?, actualizado_en = ?
      WHERE id = ?
    `);

    const tx = db.transaction((ids) => {
      for (const id of ids) {
        resolverUno.run(ts, ts, ts, id);
        insertarHistorial.run(id, 'resuelto', null, ts);
      }
    });
    const ids = activos.map(a => a.id);
    tx(ids);
    for (const id of ids) {
      const incidente = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(id);
      notificarIncidenteSiCorresponde(db, incidente, true);
    }
    return { resueltos: ids.length };
  } catch (e) {
    console.error('[incidentes] error resolviendo incidente (fail-open, no interrumpe el llamador):', e.message);
    return { resueltos: 0, error: true };
  }
}

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const PAGE_MAX = 1_000_000; // tope defensivo del OFFSET — sin esto un page=1e21 tira SqliteError (hallazgo del revisor)

// Acepta number o string numérico (hallazgo del revisor: req.query.page de Express SIEMPRE
// llega como string — Number.isInteger('2') es false, así que sin esto el paginado quedaría
// pegado en la página 1 para siempre en cuanto esto se exponga como endpoint HTTP).
// Number.isSafeInteger (no Number.isInteger): un número como 1e21 ES entero para JS pero no
// es bindeable como OFFSET de sqlite — Number.isInteger(1e21) da true y dejaba pasar un
// SqliteError "datatype mismatch" ante un query param arbitrario (hallazgo del revisor).
export function enteroValido(valor, porDefecto, tope = Number.MAX_SAFE_INTEGER) {
  const n = typeof valor === 'string' ? Number.parseInt(valor, 10) : valor;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, tope) : porDefecto;
}

/**
 * Lista incidentes con filtros y paginación. `pageSize` tiene un tope duro (PAGE_SIZE_MAX)
 * para que un cliente no pueda pedir toda la tabla de una — respuestas estables, acotadas.
 */
export function listarIncidentes(db, { estado, integracion, severidad, page = 1, pageSize = PAGE_SIZE_DEFAULT } = {}) {
  const pageNum = enteroValido(page, 1, PAGE_MAX);
  const size = Math.min(enteroValido(pageSize, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);

  const condiciones = [];
  const params = [];
  if (estado) { condiciones.push('estado = ?'); params.push(estado); }
  if (integracion) { condiciones.push('integracion = ?'); params.push(integracion); }
  if (severidad) { condiciones.push('severidad = ?'); params.push(severidad); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) n FROM incidentes_operativos ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT * FROM incidentes_operativos ${where}
    ORDER BY ultima_deteccion_en DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, (pageNum - 1) * size);

  return { items, total, page: pageNum, pageSize: size };
}

/** Detalle de un incidente puntual, con su historial completo (más antiguo primero). */
export function obtenerIncidente(db, id) {
  const incidente = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(id);
  if (!incidente) return null;
  const historial = db.prepare(
    'SELECT * FROM incidentes_operativos_historial WHERE incidente_id = ? ORDER BY creado_en ASC, id ASC'
  ).all(id);
  return { ...incidente, historial };
}
