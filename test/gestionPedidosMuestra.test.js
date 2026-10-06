import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconciliarMuestra } from '../lib/gestionPedidosMuestra.js';

const root = path.dirname(fileURLToPath(import.meta.url));
describe('reconciliación de muestra GP9', () => {
  it('detecta faltantes y devuelve verde cuando la muestra coincide', () => {
    const db = new Database(':memory:'); db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
    const now = '2026-09-09T10:00:00Z'; const cliente = db.prepare('INSERT INTO gestion_pedido_clientes (nombre,creado_en,actualizado_en) VALUES (?,?,?)').run('Muestra', now, now).lastInsertRowid;
    db.prepare(`INSERT INTO gestion_pedidos (cliente_id,fuente,external_id,estado_comercial,estado_operativo,importado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(cliente, 'woocommerce', 'S-1', 'confirmado', 'importado', now, now);
    const parcial = reconciliarMuestra(db, [{ fuente: 'woocommerce', external_id: 'S-1' }, { fuente: 'mercadolibre', external_id: 'S-2' }]);
    expect(parcial.ok).toBe(false); expect(parcial.faltantes).toHaveLength(1);
    const completa = reconciliarMuestra(db, [{ fuente: 'woocommerce', external_id: 'S-1' }]);
    expect(completa).toMatchObject({ ok: true, encontrados: 1, faltantes: [], duplicados: [] }); db.close();
  });
});
