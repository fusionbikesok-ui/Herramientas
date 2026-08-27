/**
 * Sistema de incidentes operativos: detecta, registra y comunica fallos graves de
 * integraciones (ML/WooCommerce) sin depender de que un humano mire logs de PM2 en vivo.
 *
 * Flujo: `abrirOActualizarIncidente` se llama desde routes/matcher.js y routes/woo.js cada
 * vez que una llamada a la integración falla de forma clasificable; `confirmarCicloSano` se
 * llama al final de cada ciclo completo de sync SIN errores de esa integración/proceso, y
 * es la ÚNICA vía de resolución — nunca se resuelve por una sola llamada exitosa aislada
 * (evita "flapping": abrir y cerrar el mismo incidente en cada request individual).
 */

const CLAVES_SECRETAS = /token|secret|password|authorization/i;

function now() {
  return new Date().toISOString();
}

/**
 * Sanitiza el contexto antes de persistirlo: remueve cualquier clave que matchee un patrón
 * de secreto, sin confiar en que el llamador nunca se equivoque. Defensa en profundidad —
 * ningún caller de este repo debería pasar un token acá, pero si lo hace por error, no debe
 * terminar en la base de datos de incidentes ni en la respuesta HTTP que la expone.
 */
function sanitizarContexto(contexto) {
  if (!contexto || typeof contexto !== 'object') return null;
  const limpio = {};
  for (const [clave, valor] of Object.entries(contexto)) {
    if (CLAVES_SECRETAS.test(clave)) continue;
    limpio[clave] = valor;
  }
  return limpio;
}

function claveDedupe(integracion, proceso, tipoError) {
  return `${integracion}|${proceso}|${tipoError}`;
}

// Orden de severidad para decidir si una repetición "escala" el incidente existente.
const RANGO_SEVERIDAD = { info: 0, advertencia: 1, critico: 2 };

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
 * `critico` no baja la severidad ya registrada, solo escala hacia arriba.
 */
export function abrirOActualizarIncidente(db, { integracion, proceso, tipoError, severidad, mensajeTecnico, mensajeHumano, contexto }) {
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
      `).run(integracion, proceso, tipoError, clave, severidad, mensajeTecnico ?? null, mensajeHumano, contextoJson, ts, ts, ts, ts);
      insertarHistorial.run(info.lastInsertRowid, 'abierto', JSON.stringify({ severidad, mensajeHumano }), ts);
      return { id: info.lastInsertRowid, creado: true, escalado: false };
    }

    const severidadFinal = (RANGO_SEVERIDAD[severidad] ?? 0) > (RANGO_SEVERIDAD[activo.severidad] ?? 0)
      ? severidad
      : activo.severidad;
    const escalado = severidadFinal !== activo.severidad;

    db.prepare(`
      UPDATE incidentes_operativos SET
        severidad = ?, mensaje_tecnico = ?, mensaje_humano = ?, contexto_json = ?,
        contador_repeticiones = contador_repeticiones + 1,
        ultima_deteccion_en = ?, actualizado_en = ?
      WHERE id = ?
    `).run(severidadFinal, mensajeTecnico ?? null, mensajeHumano, contextoJson, ts, ts, activo.id);

    insertarHistorial.run(
      activo.id,
      escalado ? 'escalado' : 'repetido',
      JSON.stringify({ severidadAnterior: activo.severidad, severidadNueva: severidadFinal, mensajeHumano }),
      ts
    );
    return { id: activo.id, creado: false, escalado };
  });

  return tx();
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

/**
 * Lista incidentes con filtros y paginación. `pageSize` tiene un tope duro (PAGE_SIZE_MAX)
 * para que un cliente no pueda pedir toda la tabla de una — respuestas estables, acotadas.
 */
export function listarIncidentes(db, { estado, integracion, severidad, page = 1, pageSize = PAGE_SIZE_DEFAULT } = {}) {
  const pageNum = Number.isInteger(page) && page > 0 ? page : 1;
  const size = Math.min(Math.max(Number.isInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);

  const condiciones = [];
  const params = [];
  if (estado) { condiciones.push('estado = ?'); params.push(estado); }
  if (integracion) { condiciones.push('integracion = ?'); params.push(integracion); }
  if (severidad) { condiciones.push('severidad = ?'); params.push(severidad); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) n FROM incidentes_operativos ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT * FROM incidentes_operativos ${where}
    ORDER BY ultima_deteccion_en DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, (pageNum - 1) * size);

  return { items, total, page: pageNum, pageSize: size };
}

/** Detalle de un incidente puntual, con su historial completo (más antiguo primero). */
export function obtenerIncidente(db, id) {
  const incidente = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ?').get(id);
  if (!incidente) return null;
  const historial = db.prepare(
    'SELECT * FROM incidentes_operativos_historial WHERE incidente_id = ? ORDER BY creado_en ASC'
  ).all(id);
  return { ...incidente, historial };
}
