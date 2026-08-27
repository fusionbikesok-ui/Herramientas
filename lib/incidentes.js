/** Persistent integration incident registry (fail-open). */
export function ensureIncidentes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS integracion_incidentes (
    clave TEXT PRIMARY KEY,
    integracion TEXT NOT NULL,
    operacion TEXT NOT NULL,
    gravedad TEXT NOT NULL DEFAULT 'grave',
    resumen TEXT NOT NULL,
    ocurrencias INTEGER NOT NULL DEFAULT 1,
    primer_fallo_en TEXT NOT NULL,
    ultimo_fallo_en TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'abierto',
    recuperado_en TEXT
  )`);
}
export function registrarIncidente(db, { integracion, operacion, resumen, gravedad = 'grave', ahora = new Date().toISOString() }) {
  try {
    ensureIncidentes(db);
    const clave = `${integracion}:${operacion}`;
    db.prepare(`INSERT INTO integracion_incidentes
      (clave, integracion, operacion, gravedad, resumen, ocurrencias, primer_fallo_en, ultimo_fallo_en, estado)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'abierto')
      ON CONFLICT(clave) DO UPDATE SET resumen=excluded.resumen, ocurrencias=ocurrencias+1,
      ultimo_fallo_en=excluded.ultimo_fallo_en, estado='abierto', recuperado_en=NULL`)
      .run(clave, integracion, operacion, String(resumen).slice(0, 500), ahora, ahora);
    return true;
  } catch (error) {
    console.error('[incidentes] no se pudo registrar:', error.message);
    return false;
  }
}
export function resolverIncidente(db, integracion, operacion, ahora = new Date().toISOString()) {
  try {
    ensureIncidentes(db);
    return db.prepare(`UPDATE integracion_incidentes SET estado='resuelto', recuperado_en=?
      WHERE clave=? AND estado='abierto'`).run(ahora, `${integracion}:${operacion}`).changes > 0;
  } catch (error) {
    console.error('[incidentes] no se pudo resolver:', error.message);
    return false;
  }
}
export function listarIncidentesAbiertos(db) {
  try { ensureIncidentes(db); return db.prepare(`SELECT clave, integracion, operacion, gravedad, resumen, ocurrencias, primer_fallo_en, ultimo_fallo_en FROM integracion_incidentes WHERE estado='abierto' ORDER BY ultimo_fallo_en DESC`).all(); }
  catch (error) { console.error('[incidentes] no se pudo listar:', error.message); return []; }
}
