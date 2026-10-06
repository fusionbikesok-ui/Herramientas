import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gestionPedidosRouter } from '../routes/gestionPedidos.js';
import { resolvePermiso, permiteAcceso } from '../lib/permisos.js';
import { describe, expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

// Las oportunidades de Recuperar ventas vencen al cierre del día hábil siguiente, así que
// una fecha fija hace que el test pase sólo el día que se escribió: estos rompieron solos al
// cambiar la fecha (2026-09-09 → 2026-09-10). Se ancla a "hace un rato" y siguen vigentes.
function haceHoras(horas) {
  return new Date(Date.now() - horas * 3600 * 1000).toISOString();
}

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '096_gestion_pedidos_importaciones.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '097_gestion_pedidos_recuperacion.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '098_gestion_pedidos_cambios.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '099_gestion_pedidos_estado_canal.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '100_gestion_pedidos_shipment_ml.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '101_gestion_pedidos_datos_ml.sql'), 'utf8'));
  return db;
}

describe('POST /api/gestion-pedidos/importar', () => {
  it('aplica el permiso pedidos por método en toda la superficie relacional', () => {
    expect(resolvePermiso('GET', '/gestion-pedidos/recuperar-ventas')).toMatchObject({ anyOf: ['pedidos'], nivel: 'read' });
    expect(resolvePermiso('POST', '/gestion-pedidos/recuperar-ventas/1/contactar')).toMatchObject({ anyOf: ['pedidos'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'pedidos', nivel: 'read' }], resolvePermiso('GET', '/gestion-pedidos'))).toBe(true);
    expect(permiteAcceso([{ herramienta: 'pedidos', nivel: 'read' }], resolvePermiso('POST', '/gestion-pedidos'))).toBe(false);
  });

  it('calcula diferencia financiada sólo con cuotas y tasa explícitas', async () => {
    const db = dbPrueba(); const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const ok = await request(app).post('/api/gestion-pedidos/calcular-diferencia').send({ diferencia_contado_centavos: 200000, cuotas: 6, coeficiente: 1.125 });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ diferencia_financiada_centavos: 225000, importe_por_cuota_centavos: 37500 });
    const missing = await request(app).post('/api/gestion-pedidos/calcular-diferencia').send({ diferencia_contado_centavos: 200000, cuotas: 6 });
    expect(missing.status).toBe(422); expect(missing.body.code).toBe('TASA_NO_DISPONIBLE'); db.close();
  });

  it('registra cambio de producto con motivo obligatorio y lo deja en auditoría', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', 'cambio-1', 'confirmado', 'importado', now, now).lastInsertRowid;
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const bad = await request(app).post(`/api/gestion-pedidos/${pedido}/cambios-productos`).send({ accion: 'remocion', producto_nombre: 'Casco' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post(`/api/gestion-pedidos/${pedido}/cambios-productos`).send({ accion: 'remocion', producto_nombre: 'Casco', sku: 'CAS-1', cantidad: 1, motivo: 'falla_stock', diferencia_contado_centavos: -200000, cuotas: 6 });
    expect(ok.status).toBe(201); expect(ok.body.cambio).toMatchObject({ motivo: 'falla_stock', actor: 'usuario_actual', cuotas: 6 });
    expect(db.prepare("SELECT evento FROM gestion_pedido_eventos WHERE pedido_id=?").get(pedido).evento).toBe('cambio_producto'); db.close();
  });

  it('actualiza Woo antes de marcar enviado y no muta si Woo falla', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', 'woo-send-1', 'confirmado', 'listo_para_despachar', now, now).lastInsertRowid;
    const calls = []; const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, { actualizarWoo: async input => { calls.push(input); return { status: 200 }; } }));
    const ok = await request(app).post(`/api/gestion-pedidos/${pedido}/enviar-woo`).send({ estado_woo: 'enviadoandreani' });
    expect(ok.status).toBe(200); expect(calls).toEqual([{ externalId: 'woo-send-1', estado: 'enviadoandreani' }]); expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos WHERE id=?').get(pedido).estado_operativo).toBe('enviado');
    const pedido2 = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', 'woo-send-2', 'confirmado', 'listo_para_despachar', now, now).lastInsertRowid;
    const failing = express(); failing.use(express.json()); failing.use('/api/gestion-pedidos', gestionPedidosRouter(db, { actualizarWoo: async () => { throw new Error('caído'); } }));
    const bad = await request(failing).post(`/api/gestion-pedidos/${pedido2}/enviar-woo`).send({});
    expect(bad.status).toBe(502); expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos WHERE id=?').get(pedido2).estado_operativo).toBe('listo_para_despachar'); db.close();
  });
  it('lista y busca pedidos por cliente, SKU y EAN', async () => {
    const db = dbPrueba();
    const ahora = '2026-09-09T10:00:00Z';
    const cliente = db.prepare(`INSERT INTO gestion_pedido_clientes (nombre,email,telefono,creado_en,actualizado_en) VALUES (?,?,?,?,?)`).run('Ana Demo', 'ana@example.com', '1122334455', ahora, ahora).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en,creado_fuente_en) VALUES (?,?,?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', '501', '#501', 'confirmado', 'importado', ahora, ahora, ahora).lastInsertRowid;
    db.prepare(`INSERT INTO gestion_pedido_items (pedido_id,nombre,sku,ean,cantidad,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(pedido, 'Casco demo', 'CASCO-1', '7790000000012', 2, ahora, ahora);
    const app = express(); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const lista = await request(app).get('/api/gestion-pedidos?q=7790000000012');
    expect(lista.status).toBe(200); expect(lista.body.total).toBe(1); expect(lista.body.pedidos[0].unidades).toBe(2);
    const detalle = await request(app).get(`/api/gestion-pedidos/${pedido}`);
    expect(detalle.status).toBe(200); expect(detalle.body.pedido.items[0]).toMatchObject({ sku: 'CASCO-1', ean: '7790000000012' });
    db.close();
  });

  it('combina filtros comercial, operativo y fuente sin consultar pedidos_cache', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const insert = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en,creado_fuente_en) VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run(cliente, 'woocommerce', '1', '#1', 'confirmado', 'importado', now, now, now);
    insert.run(cliente, 'mercadolibre', '2', '#2', 'cancelado', 'cerrado', now, now, now);
    const app = express(); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const response = await request(app).get('/api/gestion-pedidos?comercial=cancelado&estado=cerrado&fuente=mercadolibre');
    expect(response.status).toBe(200); expect(response.body.total).toBe(1); expect(response.body.pedidos[0].external_id).toBe('2'); db.close();
  });

  it('construye el enlace administrativo de WooCommerce en el detalle Woo', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Demo', now, now).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', '501', 'confirmado', 'importado', now, now).lastInsertRowid;
    const app = express(); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, { woo: { url: 'https://shop.example/' } }));
    const response = await request(app).get(`/api/gestion-pedidos/${pedido}`);
    expect(response.body.pedido.enlace_woocommerce).toBe('https://shop.example/wp-admin/post.php?post=501&action=edit'); db.close();
  });

  it('devuelve 404 para un pedido inexistente', async () => {
    const db = dbPrueba(); const app = express(); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const response = await request(app).get('/api/gestion-pedidos/999');
    expect(response.status).toBe(404); expect(response.body.error).toBe('Pedido no encontrado'); db.close();
  });

  it('valida un lote y rechaza cancelados antes de crear preparaciones', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const insert = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`);
    const confirmado = insert.run(cliente, 'woocommerce', '1', '#1', 'confirmado', 'importado', now, now).lastInsertRowid;
    const cancelado = insert.run(cliente, 'woocommerce', '2', '#2', 'cancelado', 'cerrado', now, now).lastInsertRowid;
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const response = await request(app).post('/api/gestion-pedidos/preparacion/validar-lote').send({ pedido_ids: [confirmado, cancelado] });
    expect(response.status).toBe(200); expect(response.body.validos).toHaveLength(1); expect(response.body.rechazados[0].motivo).toContain('cancelado'); expect(response.body.puede_iniciar).toBe(false); db.close();
  });

  it('expone el estado de configuración sin credenciales', async () => {
    const db = dbPrueba();
    const app = express();
    app.use('/api/gestion-pedidos', gestionPedidosRouter(db, { woo: { url: 'https://woo.test', ck: 'ck', cs: 'cs' }, ml: { clientId: 'id', clientSecret: 'secret', userId: '1' } }));
    const response = await request(app).get('/api/gestion-pedidos/importar/config');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, woocommerce: true, mercadolibre: true });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    db.close();
  });

  it('lista las corridas de importación para auditoría', async () => {
    const db = dbPrueba();
    db.prepare(`INSERT INTO gestion_pedido_importaciones (desde, hasta, estado, importados, iniciado_en) VALUES (?, ?, 'completada', ?, ?)`)
      .run('2026-09-01', '2026-09-09', 4, '2026-09-09T10:00:00Z');
    const app = express();
    app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const response = await request(app).get('/api/gestion-pedidos/importaciones?limit=1');
    expect(response.status).toBe(200);
    expect(response.body.corridas).toHaveLength(1);
    expect(response.body.corridas[0]).toMatchObject({ estado: 'completada', importados: 4 });
    db.close();
  });

  it('construye Recuperar ventas para cancelados, consolida por cliente y registra contacto manual', async () => {
    const db = dbPrueba(); const now = haceHoras(3);
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,email,telefono,creado_en,actualizado_en) VALUES (?,?,?,?,?)')
      .run('Cliente Demo', 'demo@example.com', '+54 9 11 5555 1234', now, now).lastInsertRowid;
    const insert = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en,creado_fuente_en,cancelado_en) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const first = insert.run(cliente, 'woocommerce', 'r-1', '#R1', 'cancelado', 'cerrado', now, now, now, now).lastInsertRowid;
    insert.run(cliente, 'woocommerce', 'r-2', '#R2', 'cancelado', 'cerrado', now, now, haceHoras(2), haceHoras(2));
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const lista = await request(app).get('/api/gestion-pedidos/recuperar-ventas');
    expect(lista.status).toBe(200); expect(lista.body.total).toBe(1); expect(lista.body.oportunidades[0].intentos).toBe(2);
    const id = lista.body.oportunidades[0].id;
    const contacto = await request(app).post(`/api/gestion-pedidos/recuperar-ventas/${id}/contactar`).send({ canal: 'whatsapp' });
    expect(contacto.status).toBe(201); expect(contacto.body.contacto).toMatchObject({ canal: 'whatsapp', actor: 'usuario_actual' });
    const otra = await request(app).post(`/api/gestion-pedidos/recuperar-ventas/${id}/contactar`).send({ canal: 'email' });
    expect(otra.status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gestion_recuperacion_contactos WHERE oportunidad_id=?').get(id).n).toBe(2);
    expect(first).toBeTruthy(); db.close();
  });

  it('importa carritos abandonados del plugin y los consolida por email aunque no tengan pedido', async () => {
    const db = dbPrueba(); const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const importacion = await request(app).post('/api/gestion-pedidos/recuperar-ventas/importar-carritos').send({ carritos: [
      { id: 'cart-a', abandoned_at: haceHoras(4), email: 'cart@example.com', phone: '11 5555 1234', cart_total: 1000 },
      { id: 'cart-b', abandoned_at: haceHoras(3), email: 'cart@example.com', phone: '11 5555 1234', cart_total: 1200 },
    ] });
    expect(importacion.status).toBe(200); expect(importacion.body.importados).toBe(2);
    const lista = await request(app).get('/api/gestion-pedidos/recuperar-ventas');
    expect(lista.body.total).toBe(1); expect(lista.body.oportunidades[0]).toMatchObject({ intentos: 2, cliente_email: 'cart@example.com' });
    db.close();
  });

  it('devuelve datos de contacto preparados sin registrar contacto', async () => {
    const db = dbPrueba(); const now = haceHoras(4);
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,email,telefono,creado_en,actualizado_en) VALUES (?,?,?,?,?)').run('Ana Demo', 'ana@example.com', '+54 9 11 5555 1234', now, now).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en,creado_fuente_en,cancelado_en) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', 'detail-1', '#D1', 'cancelado', 'cerrado', now, now, now, now).lastInsertRowid;
    db.prepare(`INSERT INTO gestion_pedido_items (pedido_id,nombre,cantidad,creado_en,actualizado_en) VALUES (?,?,?,?,?)`).run(pedido, 'Casco demo', 2, now, now);
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const lista = await request(app).get('/api/gestion-pedidos/recuperar-ventas');
    const detail = await request(app).get(`/api/gestion-pedidos/recuperar-ventas/${lista.body.oportunidades[0].id}`);
    expect(detail.status).toBe(200); expect(detail.body.oportunidad.contacto).toMatchObject({ email: 'ana@example.com', telefono_argentina: '1155551234' });
    expect(detail.body.oportunidad.contacto.cuerpo).toContain('Casco demo x2');
    expect(db.prepare('SELECT COUNT(*) AS n FROM gestion_recuperacion_contactos').get().n).toBe(0); db.close();
  });

  it('importa por HTTP con adaptadores simulados y devuelve el resumen', async () => {
    const db = dbPrueba();
    const app = express();
    app.use(express.json());
    app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {
      listarWoo: async () => [{ id: 501, number: '501', date_created: '2026-09-01T00:00:00Z', status: 'processing', billing: { first_name: 'Woo', email: 'woo@example.com' }, line_items: [] }],
      listarMl: async () => [{ id: 'ML-501', date_created: '2026-09-01T00:00:00Z', status: 'cancelled', buyer: { nickname: 'ml-demo' }, order_items: [] }],
    }));
    const response = await request(app).post('/api/gestion-pedidos/importar').send({ desde: '2026-09-01T00:00:00Z' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, importados: 2, creados: 2, actualizados: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(2);
    db.close();
  });
});

describe('Vista y contadores de Gestión de pedidos', () => {
  function sembrar(db) {
    const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const alta = (ext, comercial, operativo) => db.prepare(`INSERT INTO gestion_pedidos
      (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,creado_fuente_en,importado_en,actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', ext, ext, comercial, operativo, now, now, now).lastInsertRowid;
    alta('activo-1', 'confirmado', 'importado');
    alta('activo-2', 'confirmado', 'en_preparacion');
    alta('cerrado-1', 'cancelado', 'cerrado');
    alta('cerrado-2', 'confirmado', 'despachado');
    // Un retiro en local pendiente NO está cerrado: tiene que seguir en la vista.
    alta('retiro-1', 'confirmado', 'importado');
    return db;
  }

  it('vista=atencion excluye los pedidos con cierre confirmado', async () => {
    const db = sembrar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const todos = await request(app).get('/api/gestion-pedidos');
    expect(todos.body.total).toBe(5);
    const atencion = await request(app).get('/api/gestion-pedidos?vista=atencion');
    expect(atencion.status).toBe(200);
    expect(atencion.body.total).toBe(3);
    expect(atencion.body.pedidos.map((p) => p.external_id).sort())
      .toEqual(['activo-1', 'activo-2', 'retiro-1']);
    db.close();
  });

  it('el resumen informa contadores y la última importación', async () => {
    const db = sembrar(dbPrueba());
    db.prepare(`INSERT INTO gestion_pedido_importaciones (desde,hasta,estado,importados,iniciado_en,finalizado_en)
      VALUES ('2026-09-01','2026-09-09','completada',5,'2026-09-09T09:00:00Z','2026-09-09T09:01:00Z')`).run();
    // Una corrida todavía en curso no debe presentarse como la última noticia buena.
    db.prepare(`INSERT INTO gestion_pedido_importaciones (desde,hasta,estado,iniciado_en)
      VALUES ('2026-09-01','2026-09-09','iniciada','2026-09-09T09:30:00Z')`).run();
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const r = await request(app).get('/api/gestion-pedidos/resumen');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, atencion: 3, total: 5, recuperar: 0 });
    expect(r.body.ultima_importacion).toMatchObject({ estado: 'completada', importados: 5 });
    db.close();
  });

  it('el contador de Recuperar ventas usa el mismo filtro que su lista', async () => {
    const db = sembrar(dbPrueba());
    const futuro = new Date(Date.now() + 864e5).toISOString();
    const alta = (ext, estadoOportunidad, vence) => db.prepare(`INSERT INTO gestion_recuperacion_oportunidades
      (fuente,external_id,estado,creado_fuente_en,vence_en,creado_en,actualizado_en)
      VALUES ('carrito_abandonado',?,?,?,?,?,?)`).run(ext, estadoOportunidad, '2026-09-09T00:00:00Z', vence, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z');
    alta('c1', 'vigente', futuro);
    alta('c2', 'vigente', '2026-09-01T00:00:00Z');   // vencida
    alta('c3', 'recuperada', futuro);                 // ya no es oportunidad
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const resumen = await request(app).get('/api/gestion-pedidos/resumen');
    const lista = await request(app).get('/api/gestion-pedidos/recuperar-ventas');
    expect(resumen.body.recuperar).toBe(1);
    // Un contador que no coincide con lo que la lista muestra manda a buscar algo que no está.
    expect(resumen.body.recuperar).toBe(lista.body.oportunidades.length);
    db.close();
  });

  it('"resumen" no se confunde con el id de un pedido', async () => {
    const db = sembrar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const r = await request(app).get('/api/gestion-pedidos/resumen');
    expect(r.body.ok).toBe(true);
    expect(r.body.pedido).toBeUndefined();
    db.close();
  });
});

describe('Venta de ML espejada en WooCommerce', () => {
  function sembrarPar(db, { conOrdenMl = true } = {}) {
    const now = '2026-09-09T10:00:00Z';
    const cliente = (nombre) => db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run(nombre, now, now).lastInsertRowid;
    const alta = (f, ext, numero, nombreCliente, estadoCanal, espejo, mlOrderId) => db.prepare(`INSERT INTO gestion_pedidos
      (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,estado_canal,espejo_ml,ml_order_id,creado_fuente_en,importado_en,actualizado_en)
      VALUES (?,?,?,?,'confirmado','importado',?,?,?,?,?,?)`)
      .run(cliente(nombreCliente), f, ext, numero, estadoCanal, espejo, mlOrderId, now, now, now).lastInsertRowid;
    // El espejo casi no comparte datos con su origen: nombre real vs nickname, y otro importe.
    if (conOrdenMl) alta('mercadolibre', '2000018369254322', '2000018369254322', 'EZEQUIELHORVAT', 'paid', 0, null);
    alta('woocommerce', '68972', '68972', 'Ezequiel Matias Horvat', 'mercadolibre', 1, '2000018369254322');
    alta('woocommerce', '68970', '68970', 'Cliente Web', 'lpaandreani', 0, null);
    return db;
  }

  it('muestra la venta una sola vez, la de ML, cuando existe el par', async () => {
    const db = sembrarPar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const r = await request(app).get('/api/gestion-pedidos');
    expect(r.body.total).toBe(2);
    const ids = r.body.pedidos.map((p) => p.external_id).sort();
    expect(ids).toEqual(['2000018369254322', '68970']);
    // La fila de ML expone el número de Woo con el que trabaja el depósito.
    const venta = r.body.pedidos.find((p) => p.fuente === 'mercadolibre');
    expect(venta.numero_espejo_woo).toBe('68972');
    db.close();
  });

  it('si la orden de ML no se importó, el espejo se sigue viendo', async () => {
    // Si no, una venta cuyo lado ML quedó fuera de la ventana desaparecería de la pantalla.
    const db = sembrarPar(dbPrueba(), { conOrdenMl: false });
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const r = await request(app).get('/api/gestion-pedidos');
    expect(r.body.pedidos.map((p) => p.external_id).sort()).toEqual(['68970', '68972']);
    db.close();
  });

  it('el buscador encuentra la venta por el número de Woo del espejo', async () => {
    const db = sembrarPar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const r = await request(app).get('/api/gestion-pedidos?q=68972');
    expect(r.body.total).toBe(1);
    expect(r.body.pedidos[0].fuente).toBe('mercadolibre');
    db.close();
  });

  it('los contadores cuentan lo mismo que la lista', async () => {
    const db = sembrarPar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const resumen = await request(app).get('/api/gestion-pedidos/resumen');
    const lista = await request(app).get('/api/gestion-pedidos');
    expect(resumen.body.total).toBe(lista.body.total);
    expect(resumen.body.atencion).toBe(2);
    db.close();
  });

  it('el detalle de la venta ML enlaza su pedido espejo', async () => {
    const db = sembrarPar(dbPrueba());
    const app = express(); app.use(express.json()); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const lista = await request(app).get('/api/gestion-pedidos');
    const venta = lista.body.pedidos.find((p) => p.fuente === 'mercadolibre');
    const detalle = await request(app).get(`/api/gestion-pedidos/${venta.id}`);
    expect(detalle.body.pedido.espejo_woo).toMatchObject({ numero_visible: '68972', estado_canal: 'mercadolibre' });
    // El estado de la venta lo manda ML, no su espejo de Woo.
    expect(detalle.body.pedido.estado_canal).toBe('paid');
    db.close();
  });
});
