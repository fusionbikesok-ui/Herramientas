import express from 'express';
import { wooFetch } from './woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { importarVentanaGestionPedidos } from '../lib/gestionPedidos.js';

function fechaHaceDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function exigirRespuesta(resp, nombre) {
  if (!resp || resp.status < 200 || resp.status >= 300) throw new Error(`${nombre} respondió ${resp?.status ?? 'sin status'}`);
  return resp.data;
}

function fechaLocalArgentina(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function sumarDiasHabiles(fechaIso, dias) {
  const d = new Date(fechaIso);
  while (dias > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const nombre = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' }).format(d);
    if (!['Sat', 'Sun'].includes(nombre)) dias -= 1;
  }
  return d;
}

function cierreDia(diaLocal, hora = process.env.GESTION_PEDIDOS_CIERRE || '19:00') {
  const [h, m] = String(hora).split(':').map(Number);
  return new Date(`${diaLocal}T${String(h || 19).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00-03:00`).toISOString();
}

function vencimientoRecuperacion(creado) {
  const local = fechaLocalArgentina(creado);
  const siguiente = sumarDiasHabiles(new Date(`${local}T12:00:00-03:00`).toISOString(), 1);
  return cierreDia(fechaLocalArgentina(siguiente));
}

function normalizarTelefonoArgentina(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^54/, '').replace(/^9/, '');
  return digits.length === 10 ? digits : null;
}

/** Router administrativo para la importación inicial/reconciliación manual. */
export function gestionPedidosRouter(db, { woo, ml, listarWoo: listarWooOverride, listarMl: listarMlOverride }) {
  const router = express.Router();
  router.post('/recuperar-ventas/importar-carritos', (req, res) => {
    const carritos = Array.isArray(req.body?.carritos) ? req.body.carritos : [];
    if (carritos.length > 1000) return res.status(400).json({ ok: false, error: 'demasiados carritos' });
    const ahora = new Date().toISOString();
    const upsert = db.prepare(`INSERT INTO gestion_recuperacion_oportunidades
      (fuente,external_id,creado_fuente_en,vence_en,datos_json,creado_en,actualizado_en)
      VALUES ('carrito_abandonado',?,?,?,?,?,?)
      ON CONFLICT(fuente,external_id) DO UPDATE SET creado_fuente_en=excluded.creado_fuente_en,
      vence_en=excluded.vence_en, datos_json=excluded.datos_json, actualizado_en=excluded.actualizado_en`);
    const tx = db.transaction(() => carritos.reduce((n, carrito) => {
      const id = String(carrito.id || carrito.cart_id || carrito.cart_hash || '').trim();
      const creado = carrito.abandoned_at || carrito.updated_at || carrito.created_at;
      if (!id || !creado) return n;
      upsert.run(id, creado, vencimientoRecuperacion(creado), JSON.stringify(carrito), ahora, ahora);
      return n + 1;
    }, 0));
    return res.json({ ok: true, importados: tx() });
  });
  router.get('/recuperar-ventas', (req, res) => {
    const ahora = new Date().toISOString();
    const cancelados = db.prepare(`SELECT p.id, p.fuente, p.external_id, p.creado_fuente_en, p.cancelado_en
      FROM gestion_pedidos p
      WHERE p.estado_comercial='cancelado' AND p.cancelado_en IS NOT NULL`).all();
    const crear = db.prepare(`INSERT OR IGNORE INTO gestion_recuperacion_oportunidades
      (pedido_id,fuente,external_id,creado_fuente_en,vence_en,datos_json,creado_en,actualizado_en)
      VALUES (?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const pedido of cancelados) {
        const creado = pedido.cancelado_en || pedido.creado_fuente_en || ahora;
        crear.run(pedido.id, 'pedido_cancelado', `${pedido.fuente}:${pedido.external_id}`, creado,
          vencimientoRecuperacion(creado), null, ahora, ahora);
      }
    });
    tx();
    db.prepare(`UPDATE gestion_recuperacion_oportunidades SET estado='recuperada', actualizado_en=?
      WHERE estado='vigente' AND pedido_id IN (SELECT p.id FROM gestion_pedidos p WHERE p.estado_comercial NOT IN ('cancelado','fallido'))`).run(ahora);
    db.prepare(`UPDATE gestion_recuperacion_oportunidades SET estado='vencida', actualizado_en=?
      WHERE estado='vigente' AND vence_en <= ?`).run(ahora, ahora);
    const rows = db.prepare(`SELECT o.*, p.numero_visible, p.fuente AS pedido_fuente,
      c.id AS cliente_id, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
      (SELECT COUNT(*) FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id) AS contactos,
      (SELECT x.canal FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_canal,
      (SELECT x.actor FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_actor,
      (SELECT x.contactado_en FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_contacto
      FROM gestion_recuperacion_oportunidades o
      LEFT JOIN gestion_pedidos p ON p.id=o.pedido_id
      LEFT JOIN gestion_pedido_clientes c ON c.id=p.cliente_id
      WHERE o.estado='vigente' ORDER BY o.vence_en ASC, o.creado_fuente_en DESC`).all();
    const consolidadas = new Map();
    for (const row of rows) {
      let datos = {};
      try { datos = row.datos_json ? JSON.parse(row.datos_json) : {}; } catch { datos = {}; }
      const email = row.cliente_email || datos.email || datos.billing_email;
      const telefono = row.cliente_telefono || datos.phone || datos.billing_phone;
      const key = row.cliente_id ? `cliente:${row.cliente_id}` : email ? `email:${String(email).toLowerCase()}` : telefono ? `telefono:${String(telefono).replace(/\D/g, '')}` : `oportunidad:${row.id}`;
      const anterior = consolidadas.get(key);
      if (!anterior) consolidadas.set(key, { ...row, cliente_email: email, cliente_telefono: telefono, datos, intentos: 1 });
      else if (row.creado_fuente_en > anterior.creado_fuente_en) consolidadas.set(key, { ...row, intentos: anterior.intentos + 1 });
      else anterior.intentos += 1;
    }
    return res.json({ ok: true, oportunidades: [...consolidadas.values()], total: consolidadas.size });
  });
  router.post('/recuperar-ventas/:id/contactar', (req, res) => {
    const canal = String(req.body?.canal || '').toLowerCase();
    if (!['whatsapp', 'email'].includes(canal)) return res.status(400).json({ ok: false, error: 'canal inválido' });
    const oportunidad = db.prepare('SELECT * FROM gestion_recuperacion_oportunidades WHERE id=?').get(req.params.id);
    if (!oportunidad) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    if (oportunidad.estado !== 'vigente') return res.status(409).json({ ok: false, error: 'La oportunidad ya no está vigente' });
    const ahora = new Date().toISOString();
    const actor = String(req.user?.username || req.user?.nombre || 'usuario_actual');
    const contacto = db.prepare(`INSERT INTO gestion_recuperacion_contactos
      (oportunidad_id,canal,actor,contactado_en,creado_en) VALUES (?,?,?,?,?)`)
      .run(oportunidad.id, canal, actor, ahora, ahora);
    return res.status(201).json({ ok: true, contacto: { id: contacto.lastInsertRowid, oportunidad_id: oportunidad.id, canal, actor, contactado_en: ahora } });
  });
  router.get('/recuperar-ventas/:id', (req, res) => {
    const oportunidad = db.prepare(`SELECT o.*, p.numero_visible, p.total_centavos,
      c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono
      FROM gestion_recuperacion_oportunidades o
      LEFT JOIN gestion_pedidos p ON p.id=o.pedido_id
      LEFT JOIN gestion_pedido_clientes c ON c.id=p.cliente_id
      WHERE o.id=?`).get(req.params.id);
    if (!oportunidad) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    let datos = {};
    try { datos = oportunidad.datos_json ? JSON.parse(oportunidad.datos_json) : {}; } catch { datos = {}; }
    const items = oportunidad.pedido_id
      ? db.prepare('SELECT nombre, cantidad, precio_unitario_centavos FROM gestion_pedido_items WHERE pedido_id=? ORDER BY id').all(oportunidad.pedido_id)
      : (Array.isArray(datos.items) ? datos.items : Array.isArray(datos.line_items) ? datos.line_items : []);
    const nombre = oportunidad.cliente_nombre || datos.name || datos.billing_name || 'cliente';
    const email = oportunidad.cliente_email || datos.email || datos.billing_email || '';
    const telefono = oportunidad.cliente_telefono || datos.phone || datos.billing_phone || '';
    const lineas = items.map(item => `${item.nombre || item.name || 'Producto'} x${item.cantidad || item.qty || item.quantity || 1}`).join(', ') || 'los productos seleccionados';
    return res.json({ ok: true, oportunidad: { ...oportunidad, datos, items, contacto: {
      nombre, email, telefono, telefono_argentina: normalizarTelefonoArgentina(telefono),
      asunto: `¿Pudiste completar tu compra? ${oportunidad.numero_visible || 'Carrito abandonado'}`,
      cuerpo: `Hola ${nombre},\n\nVimos que tu compra no llegó a completarse. Habías seleccionado: ${lineas}.\n\n¿Tuviste algún problema con la compra, te arrepentiste o necesitás que te ayudemos con algo? Estamos para ayudarte.\n\nSaludos,\nFusion Bikes`,
    } } });
  });
  router.get('/', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const condiciones = [];
    const params = [];
    if (req.query.estado) { condiciones.push('p.estado_operativo = ?'); params.push(String(req.query.estado)); }
    if (req.query.comercial) { condiciones.push('p.estado_comercial = ?'); params.push(String(req.query.comercial)); }
    if (req.query.fuente) { condiciones.push('p.fuente = ?'); params.push(String(req.query.fuente)); }
    if (req.query.q) {
      condiciones.push(`(p.numero_visible LIKE ? OR p.external_id LIKE ? OR c.nombre LIKE ? OR c.email LIKE ? OR c.telefono LIKE ? OR EXISTS
        (SELECT 1 FROM gestion_pedido_items i WHERE i.pedido_id=p.id AND (i.sku LIKE ? OR i.ean LIKE ? OR i.nombre LIKE ?)))`);
      const q = `%${String(req.query.q).trim()}%`;
      params.push(q, q, q, q, q, q, q, q);
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS total FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}`).get(...params).total;
    const pedidos = db.prepare(`SELECT p.id, p.numero_visible, p.fuente, p.external_id, p.estado_comercial, p.estado_operativo,
      p.pago_estado, p.total_centavos, p.moneda, p.creado_fuente_en, p.actualizado_en,
      c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
      (SELECT COUNT(*) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS productos,
      (SELECT COALESCE(SUM(i.cantidad),0) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS unidades
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}
      ORDER BY p.creado_fuente_en DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    return res.json({ ok: true, total, limit: limite, offset, pedidos });
  });
  router.post('/preparacion/validar-lote', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.pedido_ids) ? req.body.pedido_ids : []).map(Number).filter(Number.isSafeInteger))];
    if (!ids.length || ids.length > 100) return res.status(400).json({ ok: false, error: 'pedido_ids debe contener entre 1 y 100 IDs' });
    const placeholders = ids.map(() => '?').join(',');
    const pedidos = db.prepare(`SELECT id, numero_visible, fuente, estado_comercial, estado_operativo
      FROM gestion_pedidos WHERE id IN (${placeholders})`).all(...ids);
    const encontrados = new Set(pedidos.map(p => p.id));
    const rechazados = ids.filter(id => !encontrados.has(id)).map(id => ({ id, motivo: 'pedido inexistente' }));
    const validos = [];
    for (const pedido of pedidos) {
      if (pedido.estado_comercial !== 'confirmado') {
        rechazados.push({ id: pedido.id, numero_visible: pedido.numero_visible, motivo: `estado comercial ${pedido.estado_comercial}` });
      } else if (!['importado', 'requiere_atencion'].includes(pedido.estado_operativo)) {
        rechazados.push({ id: pedido.id, numero_visible: pedido.numero_visible, motivo: `estado operativo ${pedido.estado_operativo}` });
      } else {
        validos.push(pedido);
      }
    }
    return res.json({ ok: true, puede_iniciar: validos.length > 0 && rechazados.length === 0, solicitados: ids.length, validos, rechazados });
  });
  router.get('/importar/config', (_req, res) => res.json({
    ok: true,
    woocommerce: Boolean(woo?.url && woo?.ck && woo?.cs),
    mercadolibre: Boolean(ml?.clientId && ml?.clientSecret && ml?.userId),
    ventana_por_defecto_dias: 30,
    estados_ml: process.env.GESTION_PEDIDOS_ML_STATUSES ? process.env.GESTION_PEDIDOS_ML_STATUSES.split(',').map(x => x.trim()).filter(Boolean) : null,
  }));
  router.get('/importaciones', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const corridas = db.prepare(`SELECT id, desde, hasta, estado, woo_recibidos, ml_recibidos, importados, creados, actualizados, error, iniciado_en, finalizado_en
      FROM gestion_pedido_importaciones ORDER BY id DESC LIMIT ?`).all(limite);
    return res.json({ ok: true, corridas });
  });
  router.post('/importar', async (req, res) => {
    const desde = req.body?.desde || fechaHaceDias(30);
    const hasta = req.body?.hasta || new Date().toISOString();
    // Sin override se usa únicamente la ventana de fechas: el buscador de vendedor devuelve
    // el universo vigente sin depender de que cada estado documentado sea válido para la
    // cuenta/API actual. El override sirve para corridas acotadas y se deduplica por ID.
    const statusesMl = process.env.GESTION_PEDIDOS_ML_STATUSES
      ? process.env.GESTION_PEDIDOS_ML_STATUSES.split(',').map(x => x.trim()).filter(Boolean)
      : null;
    const iniciadoEn = new Date().toISOString();
    const corrida = db.prepare(`INSERT INTO gestion_pedido_importaciones (desde, hasta, estado, iniciado_en) VALUES (?, ?, 'iniciada', ?)`).run(desde, hasta, iniciadoEn);
    try {
      const resultados = await importarVentanaGestionPedidos(db, {
        desde,
        hasta,
        porPagina: 50,
        listarWoo: listarWooOverride || (async ({ desde: after, hasta: before, pagina, limite }) => {
          const query = `/orders?status=any&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&orderby=date&order=asc&per_page=${limite}&page=${pagina}`;
          return exigirRespuesta(await wooFetch(woo, query), 'WooCommerce');
        }),
        listarMl: listarMlOverride || (async ({ desde: from, hasta: to, offset, limite }) => {
          const todas = [];
          for (const status of statusesMl || [null]) {
            const estado = status ? `&order.status=${encodeURIComponent(status)}` : '';
            const query = `/orders/search?seller=${encodeURIComponent(ml.userId)}${estado}&sort=date_asc&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(to)}&offset=${offset}&limit=${limite}`;
            const data = exigirRespuesta(await mlFetch(db, ml, 'get', query), `MercadoLibre ${status}`);
            todas.push(...(data.results || []));
          }
          const unicas = new Map(todas.map(orden => [String(orden.id), orden]));
          return [...unicas.values()];
        }),
      });
      const resumen = { ok: true, desde, hasta, importados: resultados.length, creados: resultados.filter(x => x.created).length, actualizados: resultados.filter(x => x.changed && !x.created).length };
      db.prepare(`UPDATE gestion_pedido_importaciones SET estado='completada', importados=?, creados=?, actualizados=?, finalizado_en=? WHERE id=?`).run(resumen.importados, resumen.creados, resumen.actualizados, new Date().toISOString(), corrida.lastInsertRowid);
      return res.json(resumen);
    } catch (error) {
      db.prepare(`UPDATE gestion_pedido_importaciones SET estado='fallida', error=?, finalizado_en=? WHERE id=?`).run(error.message, new Date().toISOString(), corrida.lastInsertRowid);
      return res.status(502).json({ ok: false, error: 'No se pudo completar la importación', detalle: error.message });
    }
  });
  router.get('/:id', (req, res) => {
    const pedido = db.prepare(`SELECT p.*, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id WHERE p.id=?`).get(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    pedido.entrega = db.prepare('SELECT * FROM gestion_pedido_entregas WHERE pedido_id=?').get(pedido.id) || null;
    pedido.items = db.prepare('SELECT * FROM gestion_pedido_items WHERE pedido_id=? ORDER BY id').all(pedido.id);
    pedido.eventos = db.prepare('SELECT * FROM gestion_pedido_eventos WHERE pedido_id=? ORDER BY creado_en DESC, id DESC').all(pedido.id);
    if (pedido.fuente === 'woocommerce' && woo?.url) {
      const base = String(woo.url).replace(/\/$/, '');
      pedido.enlace_woocommerce = `${base}/wp-admin/post.php?post=${encodeURIComponent(pedido.external_id)}&action=edit`;
    } else {
      pedido.enlace_woocommerce = null;
    }
    return res.json({ ok: true, pedido });
  });
  return router;
}
