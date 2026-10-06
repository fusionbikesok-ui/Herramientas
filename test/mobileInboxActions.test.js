import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { ensureTables } from '../routes/notificacionesMl.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import {
  AccionError, responderPregunta, enviarMensajePack, ejecutarAccionReclamo, accionesDesdeBusqueda,
} from '../lib/mobileInboxActions.js';

const DB = './test/tmp-mobile-inbox-actions.sqlite';
const MLCFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

/**
 * lib/mobileInboxActions.js es lo único que escribe en ML desde la bandeja móvil (E6, tarea
 * 2). Estos tests cubren las reglas de la especificación que el módulo existe para respetar:
 * el caso tiene que ser visible para quien pide la acción (ownership, antes de tocar ML),
 * releer antes de escribir, `?tag=post_sale` obligatorio, el límite lo declara ML, la
 * allowlist de reclamos sale de `players[]`, y la idempotencia de tres estados por
 * `Idempotency-Key`.
 */
describe('lib/mobileInboxActions', () => {
  let db;
  let seq = 0;

  const seedCaso = ({ resourceId = null, packId = null, assignedUserId = null } = {}) => {
    seq += 1;
    const eventId = `evt-seed-${seq}`;
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, 'caso.received', 'ml', 'mercadolibre', t, `corr-${eventId}`, `dedupe-${eventId}`);
    db.prepare(`INSERT INTO inbox_items (event_id,channel,resource_id,pack_id,title,status,version,created_at,updated_at,assigned_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, 'ml', resourceId, packId, 'Caso', 'unread', 1, t, t, assignedUserId);
  };

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    ensureTables(db);
    mlFetch.mockReset();
    const t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('accion-user', 'hash', 0, 1, t, t);
  });

  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  describe('propiedad del caso (autorización antes de tocar ML)', () => {
    it('responderPregunta con un caso inexistente responde 404 y no llama a ML', async () => {
      await expect(responderPregunta(db, MLCFG, {
        questionId: 9001, texto: 'hola', userId: 1, clave: 'clave-owner-1',
      })).rejects.toMatchObject({ status: 404, code: 'no_encontrado' });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('responderPregunta con un caso asignado a otro usuario responde el MISMO 404 y no llama a ML', async () => {
      seedCaso({ resourceId: 'question:9002', assignedUserId: 2 });
      await expect(responderPregunta(db, MLCFG, {
        questionId: 9002, texto: 'hola', userId: 1, clave: 'clave-owner-2',
      })).rejects.toMatchObject({ status: 404, code: 'no_encontrado', message: 'Caso no encontrado' });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('enviarMensajePack con un caso ajeno responde 404 y no llama a ML', async () => {
      seedCaso({ packId: 'PACK-9', assignedUserId: 2 });
      await expect(enviarMensajePack(db, MLCFG, {
        packId: 'PACK-9', texto: 'hola', userId: 1, clave: 'clave-owner-3',
      })).rejects.toMatchObject({ status: 404, code: 'no_encontrado' });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('ejecutarAccionReclamo con un caso ajeno responde 404 y no llama a ML', async () => {
      seedCaso({ resourceId: 'claim:CLM-9', assignedUserId: 2 });
      await expect(ejecutarAccionReclamo(db, MLCFG, {
        claimId: 'CLM-9', accion: 'send_message_to_mediator', texto: 'hola', userId: 1, clave: 'clave-owner-4',
      })).rejects.toMatchObject({ status: 404, code: 'no_encontrado' });
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('un caso sin asignar (assigned_user_id NULL) es visible para cualquier usuario con permiso', async () => {
      seedCaso({ resourceId: 'question:9003', assignedUserId: null });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } })
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

      const out = await responderPregunta(db, MLCFG, {
        questionId: 9003, texto: 'texto', userId: 1, clave: 'clave-owner-5',
      });
      expect(out.repetida).toBe(false);
    });
  });

  describe('responderPregunta', () => {
    it('relee la pregunta antes de responder y proyecta el estado final', async () => {
      seedCaso({ resourceId: 'question:5001' });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } }) // lectura previa
        .mockResolvedValueOnce({ status: 200, data: {} }) // POST /answers
        .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } }); // relectura final

      const out = await responderPregunta(db, MLCFG, {
        questionId: 5001, texto: 'Sí, hacemos envíos', userId: 1, clave: 'clave-1',
      });

      expect(out).toMatchObject({ question_id: '5001', external_status: 'ANSWERED', repetida: false });
      expect(mlFetch).toHaveBeenCalledTimes(3);
      expect(mlFetch.mock.calls[0][3]).toBe('/questions/5001?api_version=4');
      expect(mlFetch.mock.calls[1][2]).toBe('POST');
      expect(mlFetch.mock.calls[1][3]).toBe('/answers');
    });

    it('rechaza con 409 si al releer la pregunta ya no está UNANSWERED, sin exponer el estado interno de ML', async () => {
      seedCaso({ resourceId: 'question:5002' });
      mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

      await expect(responderPregunta(db, MLCFG, {
        questionId: 5002, texto: 'Texto', userId: 1, clave: 'clave-2',
      })).rejects.toMatchObject({ status: 409, code: 'pregunta_no_abierta', message: 'La pregunta ya no admite respuesta' });

      // No debe intentar escribir si la relectura ya la descarta.
      expect(mlFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('llamadas a ML: GET manual, POST sin manual', () => {
    it('las lecturas (GET) usan manual:true y la escritura (POST) NO pasa manual', async () => {
      seedCaso({ resourceId: 'question:5010' });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } })
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

      await responderPregunta(db, MLCFG, { questionId: 5010, texto: 'texto', userId: 1, clave: 'clave-manual' });

      expect(mlFetch.mock.calls[0][2]).toBe('GET');
      expect(mlFetch.mock.calls[0][5]).toMatchObject({ manual: true });
      expect(mlFetch.mock.calls[1][2]).toBe('POST');
      expect(mlFetch.mock.calls[1][5]?.manual).not.toBe(true);
      expect(mlFetch.mock.calls[2][2]).toBe('GET');
      expect(mlFetch.mock.calls[2][5]).toMatchObject({ manual: true });
    });
  });

  describe('enviarMensajePack', () => {
    it('pega a la ruta del hilo con ?tag=post_sale, sin ese parámetro ML devuelve 404', async () => {
      seedCaso({ packId: 'PACK-1' });
      mlFetch
        .mockResolvedValueOnce({
          status: 200,
          data: { conversation_status: 'active', buyer_id: '777', seller_max_message_length: 500 },
        })
        .mockResolvedValueOnce({ status: 200, data: {} });

      await enviarMensajePack(db, MLCFG, { packId: 'PACK-1', texto: 'Ya lo despachamos', userId: 1, clave: 'clave-3' });

      const rutaLectura = mlFetch.mock.calls[0][3];
      const rutaEscritura = mlFetch.mock.calls[1][3];
      expect(rutaLectura).toBe('/messages/packs/PACK-1/sellers/99999?tag=post_sale');
      expect(rutaEscritura).toBe('/messages/packs/PACK-1/sellers/99999?tag=post_sale');
      expect(rutaLectura).toContain('?tag=post_sale');
    });

    it('usa seller_max_message_length del hilo como tope, no una constante fija', async () => {
      seedCaso({ packId: 'PACK-2' });
      mlFetch.mockResolvedValueOnce({
        status: 200,
        data: { conversation_status: 'active', buyer_id: '777', seller_max_message_length: 10 },
      });

      const texto = 'esto tiene mas de diez caracteres';
      await expect(enviarMensajePack(db, MLCFG, { packId: 'PACK-2', texto, userId: 1, clave: 'clave-4' }))
        .rejects.toMatchObject({ status: 422, code: 'texto_largo' });

      // No debe intentar el POST si el texto ya no pasa la validación de largo.
      expect(mlFetch).toHaveBeenCalledTimes(1);
    });

    it('un texto corto respeta el límite del hilo y sí se envía', async () => {
      seedCaso({ packId: 'PACK-3' });
      mlFetch
        .mockResolvedValueOnce({
          status: 200,
          data: { conversation_status: 'active', buyer_id: '777', seller_max_message_length: 500 },
        })
        .mockResolvedValueOnce({ status: 200, data: {} });

      const out = await enviarMensajePack(db, MLCFG, { packId: 'PACK-3', texto: 'ok', userId: 1, clave: 'clave-5' });
      expect(out).toMatchObject({ pack_id: 'PACK-3', repetida: false });
    });

    it('sin buyer_id ni to.user_id en el hilo, rechaza 409 sin_destinatario y no llama al POST', async () => {
      seedCaso({ packId: 'PACK-4' });
      mlFetch.mockResolvedValueOnce({
        status: 200,
        data: { conversation_status: 'active', seller_max_message_length: 500 },
      });

      await expect(enviarMensajePack(db, MLCFG, { packId: 'PACK-4', texto: 'hola', userId: 1, clave: 'clave-6' }))
        .rejects.toMatchObject({ status: 409, code: 'sin_destinatario' });
      expect(mlFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('ejecutarAccionReclamo', () => {
    it('con available_actions desconocidas (claim y búsqueda sin players) rechaza 409 y no escribe en ML', async () => {
      seedCaso({ resourceId: 'claim:CLM-1' });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'opened', players: [] } }) // GET claim
        .mockResolvedValueOnce({ status: 200, data: { data: [] } }); // GET search

      await expect(ejecutarAccionReclamo(db, MLCFG, {
        claimId: 'CLM-1', accion: 'send_message_to_mediator', texto: 'hola', userId: 1, clave: 'clave-7',
      })).rejects.toMatchObject({ status: 409, code: 'acciones_desconocidas' });

      // Ningún POST debe haberse llamado.
      expect(mlFetch.mock.calls.every((c) => c[2] !== 'POST')).toBe(true);
    });

    it('una acción económica se rechaza con 422 sin llamar a ML (ni siquiera se llega a chequear ownership)', async () => {
      await expect(ejecutarAccionReclamo(db, MLCFG, {
        claimId: 'CLM-2', accion: 'refund', texto: 'hola', userId: 1, clave: 'clave-8',
      })).rejects.toMatchObject({ status: 422, code: 'accion_economica' });

      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('ejecuta la acción cuando players[] la declara para nuestro rol', async () => {
      seedCaso({ resourceId: 'claim:CLM-3' });
      mlFetch
        .mockResolvedValueOnce({
          status: 200,
          data: {
            status: 'opened',
            players: [{ role: 'respondent', available_actions: [{ action: 'send_message_to_mediator', mandatory: false, due_date: null }] }],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: {} }); // POST de la acción

      const out = await ejecutarAccionReclamo(db, MLCFG, {
        claimId: 'CLM-3', accion: 'send_message_to_mediator', texto: 'Estamos revisando', userId: 1, clave: 'clave-9',
      });
      expect(out).toMatchObject({ claim_id: 'CLM-3', accion: 'send_message_to_mediator', repetida: false });
    });

    it('rechaza con 409 sin exponer el estado interno de ML cuando el reclamo ya no está abierto', async () => {
      seedCaso({ resourceId: 'claim:CLM-4' });
      mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'closed' } });

      await expect(ejecutarAccionReclamo(db, MLCFG, {
        claimId: 'CLM-4', accion: 'send_message_to_mediator', texto: 'hola', userId: 1, clave: 'clave-10',
      })).rejects.toMatchObject({ status: 409, code: 'reclamo_cerrado', message: 'El reclamo ya no está abierto' });
    });
  });

  describe('accionesDesdeBusqueda', () => {
    it('devuelve las acciones del vendedor para el reclamo encontrado en la búsqueda', async () => {
      mlFetch.mockResolvedValueOnce({
        status: 200,
        data: { data: [{ id: 'CLM-5', players: [{ role: 'respondent', available_actions: [{ action: 'send_message', mandatory: false, due_date: null }] }] }] },
      });
      const acciones = await accionesDesdeBusqueda(db, MLCFG, 'CLM-5');
      expect(acciones).toEqual([{ action: 'send_message', mandatory: false, due_date: null }]);
    });

    it('devuelve null si la búsqueda no incluye el reclamo o la llamada falla', async () => {
      mlFetch.mockResolvedValueOnce({ status: 200, data: { data: [] } });
      expect(await accionesDesdeBusqueda(db, MLCFG, 'CLM-6')).toBeNull();

      mlFetch.mockResolvedValueOnce({ status: 500, data: null });
      expect(await accionesDesdeBusqueda(db, MLCFG, 'CLM-7')).toBeNull();
    });
  });

  describe('idempotencia', () => {
    it('la misma Idempotency-Key no vuelve a escribir en ML y devuelve repetida:true', async () => {
      seedCaso({ resourceId: 'question:6001' });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } })
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

      const primero = await responderPregunta(db, MLCFG, {
        questionId: 6001, texto: 'texto', userId: 1, clave: 'clave-repetida',
      });
      expect(primero.repetida).toBe(false);
      expect(mlFetch).toHaveBeenCalledTimes(3);

      const segundo = await responderPregunta(db, MLCFG, {
        questionId: 6001, texto: 'texto distinto, no importa', userId: 1, clave: 'clave-repetida',
      });
      expect(segundo.repetida).toBe(true);
      expect(segundo.question_id).toBe(primero.question_id);
      // No se hizo ninguna llamada adicional a ML en el reintento.
      expect(mlFetch).toHaveBeenCalledTimes(3);
    });

    it('un fallo ANTES de mandar el envío (relectura) libera la clave: el reintento sí ejecuta de verdad', async () => {
      seedCaso({ resourceId: 'question:6002' });
      mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } }); // releer -> ya no abierta -> AccionError, antes del POST

      await expect(responderPregunta(db, MLCFG, {
        questionId: 6002, texto: 'texto', userId: 1, clave: 'clave-liberada',
      })).rejects.toMatchObject({ status: 409 });
      expect(mlFetch).toHaveBeenCalledTimes(1);

      // La clave quedó liberada: un reintento con la misma clave debe volver a intentar,
      // no devolver un resultado fantasma ni quedar trabado en "en_curso".
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } })
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

      const reintento = await responderPregunta(db, MLCFG, {
        questionId: 6002, texto: 'texto', userId: 1, clave: 'clave-liberada',
      });
      expect(reintento.repetida).toBe(false);
      expect(mlFetch).toHaveBeenCalledTimes(4);
    });

    it('un fallo EN o DESPUÉS del POST deja la clave incierta: el reintento no vuelve a escribir y recibe 409', async () => {
      seedCaso({ resourceId: 'question:6003' });
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } }) // releer: ok, se llega a marcarEnviado()
        .mockRejectedValueOnce(new Error('ECONNRESET')); // el POST se cae sin saber si ML lo procesó

      await expect(responderPregunta(db, MLCFG, {
        questionId: 6003, texto: 'texto', userId: 1, clave: 'clave-incierta',
      })).rejects.toThrow('ECONNRESET');
      expect(mlFetch).toHaveBeenCalledTimes(2);

      // El reintento con la misma clave NO debe volver a llamar a ML: no se sabe si el
      // mensaje anterior llegó, y reintentarlo a ciegas podría duplicarlo.
      await expect(responderPregunta(db, MLCFG, {
        questionId: 6003, texto: 'texto', userId: 1, clave: 'clave-incierta',
      })).rejects.toMatchObject({ status: 409, code: 'resultado_incierto' });
      expect(mlFetch).toHaveBeenCalledTimes(2);
    });
  });
});
