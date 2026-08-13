import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { crearPreparacion, registrarEvento } from '../routes/preparacion.js';
import { buscarCandidatas, cerrarCandidatas, corteEsValido, CORTE_DEFAULT } from '../scripts/cerrar-preparaciones-sin-evidencia.mjs';

const TEST_DB = './test/tmp-cerrar-sin-evidencia.sqlite';

describe('cerrar-preparaciones-sin-evidencia', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  });

  function prep(wcOrderId, { creadoEn, estado = 'en_preparacion' } = {}) {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId, numeroPedido: String(wcOrderId), comprador: 'X', items: [] });
    if (creadoEn) db.prepare('UPDATE preparaciones SET creado_en=? WHERE id=?').run(creadoEn, id);
    if (estado !== 'en_preparacion') db.prepare('UPDATE preparaciones SET estado=? WHERE id=?').run(estado, id);
    return id;
  }

  it('buscarCandidatas trae las viejas sin completar, ANTES del corte', () => {
    const vieja = prep(1, { creadoEn: '2026-08-01T00:00:00.000Z' });
    const nueva = prep(2, { creadoEn: '2026-08-12T12:00:00.000Z' }); // después del corte, no debe salir

    const candidatas = buscarCandidatas(db, CORTE_DEFAULT);
    expect(candidatas.map(c => c.id)).toContain(vieja);
    expect(candidatas.map(c => c.id)).not.toContain(nueva);
  });

  it('buscarCandidatas EXCLUYE completada, pendiente_deposito y cerrada_sin_evidencia (no las re-lista)', () => {
    const completada = prep(3, { creadoEn: '2026-08-01T00:00:00.000Z', estado: 'completada' });
    const pendienteDeposito = prep(4, { creadoEn: '2026-08-01T00:00:00.000Z', estado: 'pendiente_deposito' });
    const yaCerrada = prep(5, { creadoEn: '2026-08-01T00:00:00.000Z', estado: 'cerrada_sin_evidencia' });

    const candidatas = buscarCandidatas(db, CORTE_DEFAULT);
    const ids = candidatas.map(c => c.id);
    expect(ids).not.toContain(completada);
    expect(ids).not.toContain(pendienteDeposito);
    expect(ids).not.toContain(yaCerrada);
  });

  it('buscarCandidatas incluye una vieja CON escaneos/fotos igual (segunda ronda: ya no se salvan)', () => {
    const conTrabajo = prep(6, { creadoEn: '2026-08-01T00:00:00.000Z' });
    registrarEvento(db, { preparacionId: conTrabajo, itemId: null, tipo: 'escaneo', usuario: 'juan', detalle: {} });
    db.prepare("INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,NULL,'articulo','/x.jpg',?)")
      .run(conTrabajo, new Date().toISOString());

    const candidatas = buscarCandidatas(db, CORTE_DEFAULT);
    const fila = candidatas.find(c => c.id === conTrabajo);
    expect(fila).toBeTruthy();
    expect(fila.escaneos).toBe(1);
    expect(fila.fotos).toBe(1);
  });

  it('cerrarCandidatas pasa el estado a cerrada_sin_evidencia y registra un evento auditable por cada una (MUTATION: sin el UPDATE, el estado queda igual)', () => {
    const vieja = prep(7, { creadoEn: '2026-08-01T00:00:00.000Z' });
    const candidatas = buscarCandidatas(db, CORTE_DEFAULT);

    const n = cerrarCandidatas(db, candidatas, { corte: CORTE_DEFAULT, ahora: '2026-08-12T09:00:00.000Z' });

    expect(n).toBe(candidatas.length);
    const row = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(vieja);
    expect(row.estado).toBe('cerrada_sin_evidencia');

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='cerrada_sin_evidencia'").get(vieja);
    expect(ev).toBeTruthy();
    expect(ev.usuario).toBeNull();
    expect(ev.creado_en).toBe('2026-08-12T09:00:00.000Z');
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ corte: CORTE_DEFAULT });
  });

  it('correr buscarCandidatas + cerrarCandidatas dos veces seguidas es idempotente: la segunda vez no encuentra nada nuevo', () => {
    prep(8, { creadoEn: '2026-08-01T00:00:00.000Z' });
    cerrarCandidatas(db, buscarCandidatas(db, CORTE_DEFAULT), { corte: CORTE_DEFAULT });

    const segundaVuelta = buscarCandidatas(db, CORTE_DEFAULT);
    expect(segundaVuelta).toHaveLength(0);
  });

  it('dry-run real: buscarCandidatas por sí sola no modifica nada', () => {
    const vieja = prep(9, { creadoEn: '2026-08-01T00:00:00.000Z' });
    buscarCandidatas(db, CORTE_DEFAULT);
    const row = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(vieja);
    expect(row.estado).toBe('en_preparacion');
  });

  describe('corteEsValido / rechazo de --corte inválido (hallazgo del revisor)', () => {
    it('acepta fechas ISO completas y solo-fecha', () => {
      expect(corteEsValido('2026-08-12T00:00:00.000Z')).toBe(true);
      expect(corteEsValido('2026-08-12')).toBe(true);
    });

    it('rechaza texto libre como "hoy" — el caso real que reportó el revisor', () => {
      expect(corteEsValido('hoy')).toBe(false);
    });

    it('rechaza vacío, undefined y texto que no arranca con YYYY-MM-DD', () => {
      expect(corteEsValido('')).toBe(false);
      expect(corteEsValido(undefined)).toBe(false);
      expect(corteEsValido('12-08-2026')).toBe(false); // formato AR/DD-MM-YYYY, no ISO
    });

    it('buscarCandidatas lanza con un corte inválido, en vez de comparar como texto y traer de más (MUTATION: bloqueante del revisor)', () => {
      // Sin la validación, SQLite compara TEXTO: '2026-08-01T...' < 'hoy' da true para
      // CUALQUIER fecha ISO (ASCII: '2' < 'h'), así que "hoy" cerraría todo.
      prep(10, { creadoEn: '2026-08-01T00:00:00.000Z' });
      expect(() => buscarCandidatas(db, 'hoy')).toThrow(/corte inválido/);
    });
  });
});
