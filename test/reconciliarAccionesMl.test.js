import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { ensureTables } from '../routes/notificacionesMl.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { reconciliarAccionesMl } from '../lib/reconciliarAccionesMl.js';

const DB = './test/tmp-reconciliar-acciones.sqlite';
const MLCFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

/**
 * Este módulo existe por §4.3 de la especificación de ML: el detalle del reclamo devuelve
 * `available_actions: []` para los tres players, mientras la BÚSQUEDA sí las declara. Como la
 * ingesta proyectaba desde el detalle, `external_actions` quedaba siempre NULL y —con la
 * regla de "vacío es desconocido"— la app no habilitaba nunca una acción de reclamo: la
 * funcionalidad estaba escrita y no se encendía en producción.
 *
 * Por eso lo que se prueba acá no es "el UPDATE corre", sino que el campo QUEDA POBLADO desde
 * la fuente correcta, y que un desconocido se guarda como NULL y no como lista vacía.
 */
describe('lib/reconciliarAccionesMl', () => {
  let db;
  let seq = 0;

  const seedReclamo = (resourceId) => {
    seq += 1;
    const eventId = `evt-rec-${seq}`;
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, 'caso.received', 'ml', 'mercadolibre', t, `corr-${eventId}`, `dedupe-${eventId}`);
    db.prepare(`INSERT INTO inbox_items (event_id,channel,resource_id,kind,title,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(eventId, 'ml', resourceId, 'reclamo', 'Reclamo', 'unread', 1, t, t);
  };

  const accionesDe = (resourceId) =>
    db.prepare('SELECT external_actions, external_status, last_synced_at FROM inbox_items WHERE resource_id = ?').get(resourceId);

  const respondeBusqueda = (reclamos, status = 200) =>
    mlFetch.mockResolvedValue({ status, headers: {}, data: { data: reclamos } });

  beforeEach(() => {
    for (const sufijo of ['', '-wal', '-shm']) {
      if (fs.existsSync(DB + sufijo)) fs.unlinkSync(DB + sufijo);
    }
    db = openDb(DB);
    ensureTables(db);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db?.close();
    for (const sufijo of ['', '-wal', '-shm']) {
      if (fs.existsSync(DB + sufijo)) fs.unlinkSync(DB + sufijo);
    }
  });

  it('puebla external_actions desde la búsqueda, que es la fuente que sí las declara', async () => {
    seedReclamo('claim:5124016992');
    respondeBusqueda([{
      id: 5124016992,
      status: 'opened',
      players: [
        { role: 'complainant', available_actions: [] },
        {
          role: 'respondent',
          available_actions: [{ action: 'send_message_to_mediator', mandatory: true, due_date: '2026-09-12T00:00:00Z' }],
        },
      ],
    }]);

    const resultado = await reconciliarAccionesMl(db, MLCFG);

    expect(resultado.actualizados).toBe(1);
    const fila = accionesDe('claim:5124016992');
    expect(JSON.parse(fila.external_actions)).toEqual([
      { action: 'send_message_to_mediator', mandatory: true, due_date: '2026-09-12T00:00:00Z' },
    ]);
    expect(fila.external_status).toBe('opened');
    expect(fila.last_synced_at).toBeTruthy();
  });

  it('consulta la búsqueda con nuestro rol de reclamado y solo los abiertos', async () => {
    seedReclamo('claim:1');
    respondeBusqueda([]);
    await reconciliarAccionesMl(db, MLCFG);

    const ruta = mlFetch.mock.calls[0][3];
    expect(ruta).toContain('/post-purchase/v1/claims/search');
    expect(ruta).toContain('status=opened');
    expect(ruta).toContain('players.role=respondent');
    expect(ruta).toContain(`players.user_id=${MLCFG.userId}`);
  });

  // La distinción que justifica el módulo entero.
  it('guarda NULL cuando ML no declara acciones: desconocido, no "ninguna"', async () => {
    seedReclamo('claim:77');
    respondeBusqueda([{ id: 77, status: 'opened', players: [{ role: 'respondent', available_actions: [] }] }]);

    await reconciliarAccionesMl(db, MLCFG);

    expect(accionesDe('claim:77').external_actions).toBeNull();
  });

  it('guarda NULL si el reclamo no trae players', async () => {
    seedReclamo('claim:78');
    respondeBusqueda([{ id: 78, status: 'opened' }]);

    await reconciliarAccionesMl(db, MLCFG);

    expect(accionesDe('claim:78').external_actions).toBeNull();
  });

  it('acepta el resource_id sin prefijo, que es como quedaron los casos viejos', async () => {
    seedReclamo('5124016993');
    respondeBusqueda([{
      id: 5124016993, status: 'opened',
      players: [{ role: 'respondent', available_actions: [{ action: 'send_message', mandatory: false, due_date: null }] }],
    }]);

    const resultado = await reconciliarAccionesMl(db, MLCFG);

    expect(resultado.actualizados).toBe(1);
    expect(JSON.parse(accionesDe('5124016993').external_actions)).toEqual([
      { action: 'send_message', mandatory: false, due_date: null },
    ]);
  });

  it('no toca nada si ML responde con error', async () => {
    seedReclamo('claim:79');
    respondeBusqueda(null, 500);

    const resultado = await reconciliarAccionesMl(db, MLCFG);

    expect(resultado.actualizados).toBe(0);
    expect(accionesDe('claim:79').external_actions).toBeNull();
  });

  it('no llama a ML si falta el identificador de vendedor', async () => {
    seedReclamo('claim:80');

    const resultado = await reconciliarAccionesMl(db, { clientId: 'cid' });

    expect(resultado.actualizados).toBe(0);
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('ignora un reclamo sin id en lugar de romper la corrida entera', async () => {
    seedReclamo('claim:81');
    respondeBusqueda([
      { status: 'opened' },
      { id: 81, status: 'opened', players: [{ role: 'respondent', available_actions: ['send_message'] }] },
    ]);

    const resultado = await reconciliarAccionesMl(db, MLCFG);

    expect(resultado.revisados).toBe(2);
    expect(resultado.actualizados).toBe(1);
    expect(JSON.parse(accionesDe('claim:81').external_actions)).toEqual([
      { action: 'send_message', mandatory: false, due_date: null },
    ]);
  });
});
