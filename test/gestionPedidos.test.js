import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importarGestionPedidos } from '../lib/gestionPedidos.js';

const root = path.dirname(fileURLToPath(import.meta.url));

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  return db;
}

describe('Gestión de pedidos relacional', () => {
  it('importa Woo y ML, conserva cancelados y es idempotente', () => {
    const db = dbPrueba();
    const ordenes = [
      { canal: 'web', wc_order_id: 1001, numero: '1001', fecha: '2026-09-01T10:00:00Z', estado: 'processing', comprador: { nombre: 'Ana', apellido: 'Demo', email: 'ana@example.com' }, items: [{ product_id: 7, sku: 'FB-7', ean: '7791', nombre: 'Casco', cantidad: 1 }] },
      { canal: 'ml', ml_order_id: 'ML-1', numero: 'ML-1', fecha: '2026-09-02T10:00:00Z', estado: 'cancelled', comprador: { nickname: 'comprador-ml' }, items: [{ seller_sku: 'FB-8', nombre: 'Luces', cantidad: 2 }] },
    ];
    expect(importarGestionPedidos(db, ordenes).map(x => x.created)).toEqual([true, true]);
    expect(importarGestionPedidos(db, ordenes).map(x => x.created)).toEqual([false, false]);
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(2);
    expect(db.prepare("SELECT estado_comercial FROM gestion_pedidos WHERE fuente='mercadolibre'").get().estado_comercial).toBe('cancelado');
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedido_items').get().n).toBe(2);
    db.close();
  });
});
