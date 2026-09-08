import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import {
  POLITICA, proximaRepeticion, debeEscalar, barrerEscalamiento, reconocer, reasignar,
  casoVivoConClave,
} from '../lib/escalamientoAlertas.js';

const DB = './test/tmp-escalamiento-alertas.sqlite';
const MINUTO = 60 * 1000;

/**
 * Reloj de escalamiento de la bandeja (E6, tarea 5b; §14 del plan maestro).
 *
 * Reglas centrales que estos tests fijan: urgente repite a los 2' y escala a los 5', y SIGUE
 * repitiendo cada 5' después de escalar (escalar no apaga el reloj); alta mide contra 15' y
 * no escala nunca; normal no repite. Escalar ocurre una sola vez. Reconocer frena la
 * repetición pero no resuelve. Reasignar conserva la historia y respeta `expected_version`.
 */
describe('lib/escalamientoAlertas', () => {
  let db, t;

  const nuevoCaso = ({ eventId, severidad, creadoHaceMin = 0, extra = {} }) => {
    const creado = new Date(Date.now() - creadoHaceMin * MINUTO).toISOString();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, 'claim.received', 'ml', 'mercadolibre', creado, `corr-${eventId}`, `dedupe-${eventId}`);
    const columnas = ['event_id', 'channel', 'title', 'status', 'severidad', 'version', 'created_at', 'updated_at'];
    const valores = [eventId, 'ml', 'Caso', 'unread', severidad, 1, creado, creado];
    for (const [clave, valor] of Object.entries(extra)) { columnas.push(clave); valores.push(valor); }
    const marcas = columnas.map(() => '?').join(',');
    const info = db.prepare(`INSERT INTO inbox_items (${columnas.join(',')}) VALUES (${marcas})`).run(...valores);
    return Number(info.lastInsertRowid);
  };

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('u1', 'hash', 0, 1, t, t);
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('u2', 'hash', 0, 1, t, t);
  });

  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  describe('proximaRepeticion', () => {
    it('urgente repite a los 2 minutos', () => {
      const desde = Date.now();
      expect(proximaRepeticion('urgente', desde)).toBe(new Date(desde + 2 * MINUTO).toISOString());
    });

    it('alta repite a los 15 minutos', () => {
      const desde = Date.now();
      expect(proximaRepeticion('alta', desde)).toBe(new Date(desde + 15 * MINUTO).toISOString());
    });

    it('normal no repite (null apaga el reloj)', () => {
      expect(proximaRepeticion('normal', Date.now())).toBeNull();
    });
  });

  describe('debeEscalar', () => {
    it('urgente escala a los 5 minutos sin reconocer', () => {
      const item = { severidad: 'urgente', created_at: new Date(Date.now() - 5 * MINUTO).toISOString(), acknowledged_at: null, escalated_at: null };
      expect(debeEscalar(item)).toBe(true);
    });

    it('urgente no escala antes de los 5 minutos', () => {
      const item = { severidad: 'urgente', created_at: new Date(Date.now() - 4 * MINUTO).toISOString(), acknowledged_at: null, escalated_at: null };
      expect(debeEscalar(item)).toBe(false);
    });

    it('alta nunca escala (la política no define umbral)', () => {
      const item = { severidad: 'alta', created_at: new Date(Date.now() - 999 * MINUTO).toISOString(), acknowledged_at: null, escalated_at: null };
      expect(debeEscalar(item)).toBe(false);
      expect(POLITICA.alta.escalar).toBeNull();
    });

    it('no escala si ya se reconoció', () => {
      const item = { severidad: 'urgente', created_at: new Date(Date.now() - 10 * MINUTO).toISOString(), acknowledged_at: t, escalated_at: null };
      expect(debeEscalar(item)).toBe(false);
    });

    it('no escala una segunda vez si escalated_at ya está seteado', () => {
      const item = { severidad: 'urgente', created_at: new Date(Date.now() - 10 * MINUTO).toISOString(), acknowledged_at: null, escalated_at: t };
      expect(debeEscalar(item)).toBe(false);
    });
  });

  describe('barrerEscalamiento', () => {
    it('escala un caso urgente vencido y programa la próxima repetición (no apaga el reloj)', () => {
      const ahora = Date.now();
      const id = nuevoCaso({
        eventId: 'evt-u1', severidad: 'urgente', creadoHaceMin: 6,
        extra: { next_repeat_at: new Date(ahora - MINUTO).toISOString() },
      });

      const resultado = barrerEscalamiento(db, { ahora });
      expect(resultado.escalados).toContain(id);
      expect(resultado.repetidos).toContain(id);

      const row = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(id);
      expect(row.escalated_at).not.toBeNull();
      // Sigue con un próximo repeat programado: escalar no apaga el reloj.
      expect(row.next_repeat_at).not.toBeNull();
    });

    it('no vuelve a escalar un caso ya escalado en una vuelta posterior', () => {
      const ahora = Date.now();
      const id = nuevoCaso({
        eventId: 'evt-u2', severidad: 'urgente', creadoHaceMin: 20,
        extra: { escalated_at: new Date(ahora - 15 * MINUTO).toISOString(), next_repeat_at: new Date(ahora - MINUTO).toISOString() },
      });

      const resultado = barrerEscalamiento(db, { ahora });
      expect(resultado.repetidos).toContain(id);
      expect(resultado.escalados).not.toContain(id);
    });

    it('normal no aparece entre los vencidos (next_repeat_at nunca se setea)', () => {
      const ahora = Date.now();
      nuevoCaso({ eventId: 'evt-n1', severidad: 'normal', creadoHaceMin: 60, extra: { next_repeat_at: null } });
      const resultado = barrerEscalamiento(db, { ahora });
      expect(resultado.revisados).toBe(0);
    });

    it('invoca notificar por cada caso repetido, con la severidad y si escaló', () => {
      const ahora = Date.now();
      nuevoCaso({
        eventId: 'evt-u3', severidad: 'urgente', creadoHaceMin: 6,
        extra: { next_repeat_at: new Date(ahora - MINUTO).toISOString() },
      });
      const notificados = [];
      barrerEscalamiento(db, { ahora, notificar: (info) => notificados.push(info) });
      expect(notificados).toHaveLength(1);
      expect(notificados[0]).toMatchObject({ escalado: true, severidad: 'urgente' });
    });
  });

  describe('reconocer', () => {
    it('frena la repetición pero no resuelve: el status sigue abierto', () => {
      const id = nuevoCaso({ eventId: 'evt-r1', severidad: 'urgente', extra: { next_repeat_at: t, status: 'unread' } });
      const resultado = reconocer(db, { inboxId: id, userId: 1 });
      expect(resultado.yaReconocido).toBe(false);
      expect(resultado.item.next_repeat_at).toBeNull();
      expect(resultado.item.status).toBe('unread');
      expect(resultado.item.acknowledged_by).toBe(1);
    });

    it('reconocer dos veces no pisa quién reconoció primero', async () => {
      const id = nuevoCaso({ eventId: 'evt-r2', severidad: 'urgente', extra: { next_repeat_at: t } });
      const primero = reconocer(db, { inboxId: id, userId: 1 });
      expect(primero.yaReconocido).toBe(false);
      const original = primero.item.acknowledged_at;

      // Pequeña espera para asegurar que, si el código pisara el timestamp, se notaría.
      await new Promise((r) => setTimeout(r, 5));
      const segundo = reconocer(db, { inboxId: id, userId: 2 });
      expect(segundo.yaReconocido).toBe(true);
      expect(segundo.item.acknowledged_by).toBe(1);
      expect(segundo.item.acknowledged_at).toBe(original);
    });

    it('devuelve missing:true para un caso inexistente', () => {
      expect(reconocer(db, { inboxId: 99999, userId: 1 }).missing).toBe(true);
    });
  });

  describe('reasignar', () => {
    it('conserva la historia de quién, a quién, quién actuó y cuándo', () => {
      const id = nuevoCaso({ eventId: 'evt-a1', severidad: 'normal', extra: { assigned_user_id: 1 } });
      const resultado = reasignar(db, { inboxId: id, aUsuario: 2, actor: 1, motivo: 'vacaciones' });
      expect(resultado.item.assigned_user_id).toBe(2);

      const historia = db.prepare('SELECT * FROM inbox_assignments WHERE inbox_id = ?').get(id);
      expect(historia).toMatchObject({ from_user_id: 1, to_user_id: 2, actor_user_id: 1, motivo: 'vacaciones' });
      expect(historia.created_at).toBeTruthy();
    });

    it('respeta expected_version y devuelve conflicto si no coincide', () => {
      const id = nuevoCaso({ eventId: 'evt-a2', severidad: 'normal' });
      const resultado = reasignar(db, {
        inboxId: id, aUsuario: 2, actor: 1, esperado: 999,
      });
      expect(resultado.conflict).toBeTruthy();
      expect(db.prepare('SELECT assigned_user_id FROM inbox_items WHERE inbox_id = ?').get(id).assigned_user_id).toBeNull();
    });

    it('devuelve missing:true para un caso inexistente', () => {
      expect(reasignar(db, { inboxId: 99999, aUsuario: 2, actor: 1 }).missing).toBe(true);
    });
  });

  describe('casoVivoConClave', () => {
    it('devuelve el caso vivo con esa dedupe_key y none para archivado/resuelto', () => {
      const id = nuevoCaso({ eventId: 'evt-d1', severidad: 'normal', extra: { dedupe_key: 'clave-x', status: 'unread' } });
      const vivo = casoVivoConClave(db, 'clave-x');
      expect(vivo.inbox_id).toBe(id);

      db.prepare("UPDATE inbox_items SET status = 'resolved' WHERE inbox_id = ?").run(id);
      expect(casoVivoConClave(db, 'clave-x')).toBeNull();
    });

    it('devuelve null si no se pasa clave', () => {
      expect(casoVivoConClave(db, null)).toBeNull();
    });
  });
});
