export function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getMapeoConocido(db) {
  const rows = db.prepare('SELECT clave_normalizada, id_woo, variacion_texto FROM mapeo_fusion').all();
  const mapa = {};
  for (const r of rows) {
    mapa[r.clave_normalizada] = { idWoo: r.id_woo, variacion: r.variacion_texto };
  }
  return mapa;
}

export function guardarMapeo(db, relaciones) {
  if (!relaciones || !relaciones.length) return;
  const stmt = db.prepare(`
    INSERT INTO mapeo_fusion (clave_normalizada, id_woo, variacion_texto, actualizado_en)
    VALUES (@clave, @idWoo, @variacion, @actualizadoEn)
    ON CONFLICT(clave_normalizada) DO UPDATE SET
      id_woo = excluded.id_woo,
      variacion_texto = excluded.variacion_texto,
      actualizado_en = excluded.actualizado_en
  `);
  const now = new Date().toISOString();
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run({ ...r, actualizadoEn: now });
  });
  insertMany(relaciones);
}

export function registrarNuevosPendientes(db, registros) {
  if (!registros || !registros.length) return;
  const stmt = db.prepare(`
    INSERT INTO pendientes_mapeo (nombre_original, clave_normalizada, creado_en, resuelto)
    VALUES (@nombreOriginal, @claveNormalizada, @creadoEn, 0)
  `);
  const now = new Date().toISOString();
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run({ ...r, creadoEn: now });
  });
  insertMany(registros);
}

export function resolverMapeoPendientes(db, catalogoFresco) {
  const pendientes = db.prepare('SELECT * FROM pendientes_mapeo WHERE resuelto = 0').all();
  if (!pendientes.length) return { resueltos: 0, pendientes: 0 };

  const clavesCatalogo = new Set(
    catalogoFresco.map(p => normalizarTexto(p.nombre))
  );

  const marcarResuelto = db.prepare('UPDATE pendientes_mapeo SET resuelto = 1 WHERE id = ?');
  let resueltos = 0;
  const tx = db.transaction(() => {
    for (const p of pendientes) {
      if (clavesCatalogo.has(p.clave_normalizada)) {
        marcarResuelto.run(p.id);
        resueltos++;
      }
    }
  });
  tx();

  return { resueltos, pendientes: pendientes.length - resueltos };
}
