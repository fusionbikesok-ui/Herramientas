import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preparacionRouter } from '../routes/preparacion.js';

const root = path.dirname(fileURLToPath(import.meta.url));

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  db.exec(`CREATE TABLE ean_sku (ean TEXT PRIMARY KEY, sku TEXT); CREATE TABLE catalogo_cache (id_woo INTEGER, sku TEXT, img TEXT, tipo TEXT, gtin TEXT);`);
  return db;
}

describe('POST /api/preparacion/lote-desde-gestion', () => {
  it('crea la preparación, claim y evento para un pedido confirmado', async () => {
    const db = dbPrueba(); const now = '2026-09-09T10:00:00Z';
    const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Cliente', now, now).lastInsertRowid;
    const pedido = db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,numero_visible,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', '501', '#501', 'confirmado', 'importado', now, now).lastInsertRowid;
    db.prepare(`INSERT INTO gestion_pedido_items (pedido_id,nombre,sku,ean,cantidad,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(pedido, 'Casco demo', 'CASCO-1', '7790000000012', 2, now, now);
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { username: 'operador-demo' }; next(); });
    app.use('/api/preparacion', preparacionRouter(db, { woo: {}, ml: {}, preparacionClaimTtlMs: 60_000 }));
    const response = await request(app).post('/api/preparacion/lote-desde-gestion').send({ gestion_pedido_ids: [pedido] });
    expect(response.status).toBe(201); expect(response.body.pedidos).toHaveLength(1);
    expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos WHERE id=?').get(pedido).estado_operativo).toBe('en_preparacion');
    expect(db.prepare('SELECT cantidad_esperada FROM preparacion_items').get().cantidad_esperada).toBe(2);
    expect(db.prepare('SELECT usuario FROM preparacion_claims').get().usuario).toBe('operador-demo');
    db.close();
  });
});
