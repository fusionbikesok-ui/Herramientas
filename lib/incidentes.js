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
 */

const CLAVES_SECRETAS = /token|secret|password|authorization/i;
// Valores que delatan un secreto aunque la clave que los contiene sea inocente (ej. una URL
// completa con ?access_token=... en la query, o un header armado a mano en un objeto `url`).
const VALORES_SECRETOS = /(access_token|api_key|bearer\s|client_secret|APP_USR-)/i;
const PROFUNDIDAD_MAX_SANITIZACION = 4; // suficiente para {respuesta:{headers:{...}}}, corta un ciclo/objeto patológico

function now() {
  return new Date().toISOString();
}

/**
 * Sanitiza el contexto antes de persistirlo: recorre objetos y arrays recursivamente (hallazgo
 * del revisor: la versión anterior solo miraba el primer nivel y solo nombres de clave, así que
 * `{respuesta: err.response}` con un `access_token` adentro pasaba entero), removiendo claves
 * que matcheen un patrón de secreto y redactando valores string que por su FORMA delatan un
 * secreto aunque la clave sea inocente. Nunca confía en que el llamador se acuerde de limpiar
 * antes de pasar el contexto — defensa en profundidad, no la única línea de defensa.
 */
function sanitizarValor(valor, profundidad) {
  if (profundidad > PROFUNDIDAD_MAX_SANITIZACION) return '[omitido: demasiado profundo]';
  if (typeof valor === 'string') return VALORES_SECRETOS.test(valor) ? '[redactado]' : valor;
  if (Array.isArray(valor)) return valor.map(v => sanitizarValor(v, profundidad + 1));
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
        `).run(integracion, proceso, tipoError, clave, severidadPedida, mensajeTecnico ?? null, mensaje, contextoJson, ts, ts, ts, ts);
        insertarHistorial.run(info.lastInsertRowid, 'abierto', JSON.stringify({ severidad: severidadPedida, mensajeHumano: mensaje }), ts);
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
      `).run(severidadFinal, mensajeTecnico ?? null, mensaje, contextoJson, ts, ts, activo.id);

      insertarHistorial.run(
        activo.id,
        escalado ? 'escalado' : 'repetido',
        JSON.stringify({
          severidadAnterior: activo.severidad, severidadNueva: severidadFinal,
          mensajeHumano: mensaje, mensajeTecnico: mensajeTecnico ?? null, contexto: contextoLimpio,
        }),
        ts
      );
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
 */
export function confirmarCicloSano(db, { integracion, proceso, tipoError }) {
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
  tx(activos.map(a => a.id));
  return { resueltos: activos.length };
}

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

// Acepta number o string numérico (hallazgo del revisor: req.query.page de Express SIEMPRE
// llega como string — Number.isInteger('2') es false, así que sin esto el paginado quedaría
// pegado en la página 1 para siempre en cuanto esto se exponga como endpoint HTTP).
function enteroValido(valor, porDefecto) {
  const n = typeof valor === 'string' ? Number.parseInt(valor, 10) : valor;
  return Number.isInteger(n) && n > 0 ? n : porDefecto;
}

/**
 * Lista incidentes con filtros y paginación. `pageSize` tiene un tope duro (PAGE_SIZE_MAX)
 * para que un cliente no pueda pedir toda la tabla de una — respuestas estables, acotadas.
 */
export function listarIncidentes(db, { estado, integracion, severidad, page = 1, pageSize = PAGE_SIZE_DEFAULT } = {}) {
  const pageNum = enteroValido(page, 1);
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
