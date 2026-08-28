import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { preparacionRouter } from '../routes/preparacion.js';
import { calcularFechaDespacho, fechaEstimadaShipment, horaValida, normalizarHorarios } from '../lib/horariosDespacho.js';

const laborables = normalizarHorarios([]);

describe('horarios de despacho', () => {
  it('valida cortes HH:MM', () => {
    expect(horaValida('16:00')).toBe(true);
    expect(horaValida('24:00')).toBe(false);
    expect(horaValida('4:00')).toBe(false);
  });

  it('propone el mismo día antes del corte y el siguiente después', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T17:00:00Z'))).toBe('2026-08-28');
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T20:30:00Z'))).toBe('2026-08-31');
  });

  it('salta fines de semana deshabilitados', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-29T14:00:00Z'))).toBe('2026-08-31');
  });

  it('no rompe el sync si no hay días habilitados', () => {
    expect(calcularFechaDespacho(laborables.map((h) => ({ ...h, habilitado: false })), new Date())).toBeNull();
  });

  it('usa solo el límite de preparación del shipment, no la fecha de entrega', () => {
    expect(fechaEstimadaShipment({ date_estimated_delivery: '2026-09-03' })).toBeNull();
    expect(fechaEstimadaShipment({ shipping_option: { estimated_handling_limit: { date: '2026-08-31T12:00:00Z' } } })).toBe('2026-08-31');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-09-01T23:59:59-03:00' } })).toBe('2026-09-01');
  });

  it('expone y actualiza los siete días mediante el router', async () => {
    const file = './test/tmp-horarios-despacho.sqlite';
    const db = openDb(file);
    const app = express(); app.use(express.json());
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const inicial = await request(app).get('/api/preparacion/horarios-despacho');
    expect(inicial.status).toBe(200);
    expect(inicial.body.data).toHaveLength(7);
    const horarios = inicial.body.data.map((h) => ({ ...h, habilitado: h.dia === 6, hora_corte: '15:30' }));
    const guardado = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios });
    expect(guardado.status).toBe(200);
    expect(guardado.body.data.find((h) => h.dia === 6)).toMatchObject({ habilitado: true, hora_corte: '15:30' });
    const invalido = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios: horarios.slice(0, 6) });
    expect(invalido.status).toBe(422);
    const ninguno = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios: horarios.map((h) => ({ ...h, habilitado: false })) });
    expect(ninguno.status).toBe(422);
    db.close();
    try { fs.unlinkSync(file); } catch {}
  });
});
