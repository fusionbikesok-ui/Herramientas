import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ejecutarImportacion } from '../lib/gestionPedidosSync.js';

const root = path.dirname(fileURLToPath(import.meta.url));

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '096_gestion_pedidos_importaciones.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '099_gestion_pedidos_estado_canal.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '100_gestion_pedidos_shipment_ml.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '101_gestion_pedidos_datos_ml.sql'), 'utf8'));
  return db;
}

const pedidoWoo = {
  id: 51, number: '51', date_created: '2026-09-09T10:00:00Z', status: 'processing',
  currency: 'ARS', total: '1000.00', shipping_total: '0', total_tax: '0',
  billing: { email: 'a@x.com' }, shipping: {}, shipping_lines: [], line_items: [], meta_data: [],
};

describe('Corrida compartida de importación', () => {
  it('deja la corrida registrada como completada con su resumen', async () => {
    const db = dbPrueba();
    const r = await ejecutarImportacion(db, {
      desde: '2026-09-01T00:00:00Z',
      listarWoo: async ({ pagina }) => (pagina === 1 ? [pedidoWoo] : []),
      listarMl: async () => [],
    });
    expect(r).toMatchObject({ ok: true, importados: 1, creados: 1, actualizados: 0 });
    expect(db.prepare('SELECT estado, importados FROM gestion_pedido_importaciones').get())
      .toEqual({ estado: 'completada', importados: 1 });
    db.close();
  });

  it('un fallo deja el intento visible en el historial y propaga el error', async () => {
    const db = dbPrueba();
    await expect(ejecutarImportacion(db, {
      desde: '2026-09-01T00:00:00Z',
      listarWoo: async () => { throw new Error('ML partially_paid 400'); },
      listarMl: async () => [],
    })).rejects.toThrow('ML partially_paid 400');
    // El caso real del 2026-09-09: una corrida fallida seguida de una completa. Si el
    // intento no quedara asentado, el historial mentiría por omisión.
    const corrida = db.prepare('SELECT estado, error FROM gestion_pedido_importaciones').get();
    expect(corrida.estado).toBe('fallida');
    expect(corrida.error).toContain('partially_paid');
    db.close();
  });

  it('reimportar la misma ventana no duplica pedidos', async () => {
    const db = dbPrueba();
    const opciones = {
      desde: '2026-09-01T00:00:00Z',
      listarWoo: async ({ pagina }) => (pagina === 1 ? [pedidoWoo] : []),
      listarMl: async () => [],
    };
    await ejecutarImportacion(db, opciones);
    const segunda = await ejecutarImportacion(db, opciones);
    expect(segunda).toMatchObject({ creados: 0, actualizados: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(1);
    db.close();
  });
});
