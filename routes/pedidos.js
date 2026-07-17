import express from 'express';

export function pedidosRouter(db) {
  const router = express.Router();

  // Migraciones para DBs existentes
  const migrations = [
    'ALTER TABLE recepciones ADD COLUMN pedido_id INTEGER',
    'ALTER TABLE recepciones ADD COLUMN importador TEXT',
    'ALTER TABLE recepciones ADD COLUMN numero_pedido TEXT',
    'ALTER TABLE recepcion_documentos ADD COLUMN nombre_archivo TEXT',
    'ALTER TABLE recepcion_documentos ADD COLUMN drive_file_id TEXT',
    'ALTER TABLE recepcion_documentos ADD COLUMN drive_url TEXT',
  ];
  for (const sql of migrations) {
    try { db.prepare(sql).run(); } catch (_) { /* columna ya existe */ }
  }

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_pedido       TEXT NOT NULL,
      numero_pedido_norm  TEXT,
      importador          TEXT NOT NULL,
      proveedor           TEXT,
      estado              TEXT NOT NULL DEFAULT 'pendiente',
      notas               TEXT,
      drive_folder_id     TEXT,
      creado_en           TEXT NOT NULL
    )`).run();
    // Índice único por número normalizado + importador (tolerante a prefijos/sufijos)
    db.prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_norm_imp ON pedidos(numero_pedido_norm, importador)'
    ).run();
    // Mantener índice viejo como no-unique para compatibilidad
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_pedidos_num_imp ON pedidos(numero_pedido, importador)'
    ).run();
  } catch (_) { /* ya existe */ }

  // Rellenar numero_pedido_norm en pedidos existentes que no lo tienen
  try {
    const sinNorm = db.prepare("SELECT id, numero_pedido FROM pedidos WHERE numero_pedido_norm IS NULL OR numero_pedido_norm = ''").all();
    if (sinNorm.length > 0) {
      // Importar la misma función de normalización
      const normRE = /^(PEDIDO|PED|ORDEN\s+DE\s+COMPRA|ORDEN|ORD|OC|OV|FACTURA|FAC|FC|REMITO|REM)[.\-\s]*/i;
      const sufRE  = /\s+(EXPRESS|URGENTE|NORMAL|PRIORITARIO|STANDARD)\s*$/i;
      const upd = db.prepare("UPDATE pedidos SET numero_pedido_norm=? WHERE id=?");
      const batch = db.transaction(() => {
        for (const p of sinNorm) {
          const norm = (p.numero_pedido || '').trim().toUpperCase()
            .replace(sufRE, '').replace(normRE, '').trim().replace(/\s+/g, ' ') || p.numero_pedido;
          upd.run(norm, p.id);
        }
      });
      batch();
    }
  } catch (_) {}

  // Lista de pedidos con conteos
  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM recepciones WHERE pedido_id = p.id) AS total_recepciones,
        (SELECT COUNT(*) FROM recepciones WHERE pedido_id = p.id AND estado = 'confirmada') AS recepciones_confirmadas,
        (SELECT COUNT(*) FROM recepcion_documentos rd
          INNER JOIN recepciones r ON rd.recepcion_id = r.id
          WHERE r.pedido_id = p.id) AS total_docs
      FROM pedidos p ORDER BY p.creado_en DESC LIMIT 200
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Documentos sin número de pedido (pendientes de clasificar)
  router.get('/sin-clasificar', (req, res) => {
    const rows = db.prepare(`
      SELECT r.id AS recepcion_id, r.proveedor, r.importador, r.fecha, r.estado,
        rd.id AS doc_id, rd.tipo, rd.numero, rd.nombre_archivo, rd.drive_url
      FROM recepciones r
      INNER JOIN recepcion_documentos rd ON rd.recepcion_id = r.id
      WHERE r.numero_pedido IS NULL OR r.numero_pedido = ''
      ORDER BY r.creado_en DESC
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Detalle de un pedido
  router.get('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'no encontrado' });

    const recepciones = db.prepare(`
      SELECT r.id, r.fecha, r.estado, r.confirmado_en, r.notas,
        (SELECT COUNT(*) FROM recepcion_items WHERE recepcion_id = r.id) AS total_items,
        (SELECT COUNT(*) FROM recepcion_documentos WHERE recepcion_id = r.id) AS total_docs
      FROM recepciones r WHERE r.pedido_id = ? ORDER BY r.creado_en
    `).all(id);

    const documentos = db.prepare(`
      SELECT rd.*, r.fecha AS fecha_recepcion
      FROM recepcion_documentos rd
      INNER JOIN recepciones r ON rd.recepcion_id = r.id
      WHERE r.pedido_id = ?
      ORDER BY rd.creado_en
    `).all(id);

    res.json({ ok: true, data: { ...pedido, recepciones, documentos } });
  });

  // Actualizar pedido (notas, estado manual)
  router.patch('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { notas, estado } = req.body || {};
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'no encontrado' });

    if (notas !== undefined) db.prepare('UPDATE pedidos SET notas=? WHERE id=?').run(notas, id);
    if (estado && ['pendiente', 'recibido_parcial', 'completado'].includes(estado)) {
      db.prepare('UPDATE pedidos SET estado=? WHERE id=?').run(estado, id);
    }

    res.json({ ok: true, data: db.prepare('SELECT * FROM pedidos WHERE id=?').get(id) });
  });

  // Asignar un número de pedido a recepciones sin clasificar
  router.post('/clasificar', (req, res) => {
    const { recepcion_ids, numero_pedido, importador } = req.body || {};
    if (!numero_pedido || !importador || !Array.isArray(recepcion_ids) || !recepcion_ids.length) {
      return res.status(400).json({ ok: false, error: 'numero_pedido, importador y recepcion_ids requeridos' });
    }
    const now = new Date().toISOString();

    // Auto-crear o buscar pedido
    db.prepare(`INSERT OR IGNORE INTO pedidos (numero_pedido, importador, estado, creado_en)
      VALUES (?,?,'pendiente',?)`).run(numero_pedido, importador, now);
    const pedido = db.prepare(
      'SELECT * FROM pedidos WHERE numero_pedido=? AND importador=?'
    ).get(numero_pedido, importador);

    let clasificadas = 0;
    for (const rid of recepcion_ids) {
      const r = db.prepare(
        'UPDATE recepciones SET numero_pedido=?, importador=?, pedido_id=? WHERE id=?'
      ).run(numero_pedido, importador, pedido.id, rid);
      clasificadas += r.changes;
    }

    res.json({ ok: true, pedido_id: pedido.id, clasificadas });
  });

  return router;
}
