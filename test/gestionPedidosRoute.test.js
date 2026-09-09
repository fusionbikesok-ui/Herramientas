import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gestionPedidosRouter } from '../routes/gestionPedidos.js';
import { describe, expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '096_gestion_pedidos_importaciones.sql'), 'utf8'));
  return db;
}

describe('POST /api/gestion-pedidos/importar', () => {
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

  it('devuelve 404 para un pedido inexistente', async () => {
    const db = dbPrueba(); const app = express(); app.use('/api/gestion-pedidos', gestionPedidosRouter(db, {}));
    const response = await request(app).get('/api/gestion-pedidos/999');
    expect(response.status).toBe(404); expect(response.body.error).toBe('Pedido no encontrado'); db.close();
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
