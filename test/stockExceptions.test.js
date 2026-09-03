import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  crearIncidente, listarIncidentes, resolverIncidente,
  crearTarea, listarTareas, tomarTarea, completarTarea,
  recibirDevolucion, clasificarDevolucion, marcarDanoDevolucion,
} from '../lib/stockExceptions.js';
import { stockExceptionsRouter } from '../routes/stockExceptions.js';

const FILE = './test/tmp-stock-exceptions.sqlite';
const clean = () => { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); if (fs.existsSync(`${FILE}-shm`)) fs.unlinkSync(`${FILE}-shm`); if (fs.existsSync(`${FILE}-wal`)) fs.unlinkSync(`${FILE}-wal`); };

function appFor(db, user = 'operario', permisos = [{ herramienta: 'stock-exceptions', nivel: 'write' }]) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: user, permisos }; next(); });
  app.use('/api/stock-exceptions', stockExceptionsRouter(db)); return app;
}

describe('E18 — excepciones físicas', () => {
  let db;
  beforeEach(() => { clean(); db = openDb(FILE); });
  afterEach(() => { db.close(); clean(); });

  it('crea las tablas 066 y la migración es idempotente', () => {
    const nombres = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'stock_%'").all().map(x => x.name);
    expect(nombres).toEqual(expect.arrayContaining(['stock_incidents', 'stock_tasks', 'stock_exception_events']));
    expect(db.prepare("SELECT COUNT(*) n FROM _schema_migrations WHERE key='stock_exceptions_066'").get().n).toBe(1);
    db.close(); db = openDb(FILE);
    expect(db.prepare("SELECT COUNT(*) n FROM _schema_migrations WHERE key='stock_exceptions_066'").get().n).toBe(1);
  });

  it('crea y reintenta un incidente sin duplicarlo y audita', () => {
    const input = { tipo: 'faltante', severidad: 'urgente', sku: 'FB-X', motivo: 'No encontrado', creado_por: 'ana', operation_id: 'inc-1' };
    const one = crearIncidente(db, input), two = crearIncidente(db, input);
    expect(one.ok).toBe(true); expect(two.repetido).toBe(true);
    expect(listarIncidentes(db)).toHaveLength(1);
    expect(db.prepare("SELECT evento FROM stock_exception_events WHERE entidad='incidente'").all().map(x => x.evento)).toEqual(['creado']);
  });

  it('rechaza resolver con versión obsoleta y permite resolver con la vigente', () => {
    const created = crearIncidente(db, { tipo: 'daño', motivo: 'Golpe', creado_por: 'ana', operation_id: 'inc-2' });
    expect(resolverIncidente(db, created.incidente.id, { expected_version: 99, resolucion: 'Separado', resuelto_por: 'ana', operation_id: 'res-2' }).code).toBe('VERSION_CONFLICT');
    const done = resolverIncidente(db, created.incidente.id, { expected_version: 1, resolucion: 'Separado', resuelto_por: 'ana', operation_id: 'res-2' });
    expect(done.ok).toBe(true); expect(done.incidente.estado).toBe('resuelto');
    expect(resolverIncidente(db, created.incidente.id, { expected_version: 2, resolucion: 'otra', resuelto_por: 'ana', operation_id: 'res-2' }).repetido).toBe(true);
  });

  it('crea, toma y completa una tarea con claim y auditoría', () => {
    const incident = crearIncidente(db, { tipo: 'faltante', motivo: 'faltante', creado_por: 'ana', operation_id: 'inc-3' });
    const created = crearTarea(db, { incident_id: incident.incidente.id, tipo: 'contar', sku: 'FB-X', creado_por: 'ana', operation_id: 'task-1' });
    const taken = tomarTarea(db, created.tarea.id, { expected_version: 1, asignado_a: 'luis', operation_id: 'take-1' });
    expect(taken.ok).toBe(true); expect(taken.tarea.estado).toBe('tomada');
    expect(completarTarea(db, created.tarea.id, { expected_version: 2, completada_por: 'ana', resultado: 'Contado', operation_id: 'complete-bad' }).code).toBe('TASK_NOT_OWNED');
    const done = completarTarea(db, created.tarea.id, { expected_version: 2, completada_por: 'luis', resultado: 'Contado', operation_id: 'complete-1' });
    expect(done.ok).toBe(true); expect(done.tarea.estado).toBe('completada');
    expect(listarTareas(db, { incident_id: incident.incidente.id })).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM stock_exception_events WHERE entidad='tarea'").get().n).toBe(3);
  });

  it('protege las transiciones REST e informa conflictos de versión', async () => {
    const app = appFor(db);
    const created = await request(app).post('/api/stock-exceptions/incidentes').send({ tipo: 'diferencia', motivo: 'Conteo', operation_id: 'http-1' });
    expect(created.status).toBe(201);
    const listed = await request(app).get('/api/stock-exceptions/incidentes?estado=abierto');
    expect(listed.status).toBe(200); expect(listed.body.data).toHaveLength(1);
    const conflict = await request(app).post(`/api/stock-exceptions/incidentes/${created.body.incidente.id}/resolver`).send({ expected_version: 4, resolucion: 'Ajustar', operation_id: 'http-res-1' });
    expect(conflict.status).toBe(409);
    const resolved = await request(app).post(`/api/stock-exceptions/incidentes/${created.body.incidente.id}/resolver`).send({ expected_version: 1, resolucion: 'Ajustar', operation_id: 'http-res-2' });
    expect(resolved.status).toBe(201); expect(resolved.body.incidente.estado).toBe('resuelto');
  });

  it('no completa una tarea tomada por otro operador', () => {
    const task = crearTarea(db, { tipo: 'verificar', creado_por: 'ana', operation_id: 'task-2' });
    tomarTarea(db, task.tarea.id, { expected_version: 1, asignado_a: 'luis', operation_id: 'take-2' });
    expect(completarTarea(db, task.tarea.id, { expected_version: 2, completada_por: 'ana', resultado: 'ok', operation_id: 'complete-2' }).code).toBe('TASK_NOT_OWNED');
  });

  it('recibe una devolución una sola vez y crea inspección sin stock comercial', () => {
    const incident = crearIncidente(db, { tipo: 'otro', sku: 'FB-X', cantidad: 1, motivo: 'Devolución', creado_por: 'ana', operation_id: 'return-1' });
    const input = { expected_version: 1, producto_estado: 'recibido', recibido_por: 'ana', operation_id: 'receive-1' };
    const one = recibirDevolucion(db, incident.incidente.id, input);
    const two = recibirDevolucion(db, incident.incidente.id, input);
    expect(one.ok).toBe(true); expect(two.repetido).toBe(true);
    expect(one.tarea.tipo).toBe('inspeccionar');
    expect(db.prepare('SELECT COUNT(*) n FROM stock_tasks').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n).toBe(0);
  });

  it('clasifica con conflicto de versión y permite disponible/no disponible/condicionado', () => {
    const incident = crearIncidente(db, { tipo: 'otro', motivo: 'Devolución', creado_por: 'ana', operation_id: 'return-2' });
    const received = recibirDevolucion(db, incident.incidente.id, { expected_version: 1, recibido_por: 'ana', operation_id: 'receive-2' });
    expect(clasificarDevolucion(db, incident.incidente.id, { expected_version: 1, clasificacion: 'disponible', clasificado_por: 'ana', operation_id: 'class-bad' }).code).toBe('VERSION_CONFLICT');
    const done = clasificarDevolucion(db, incident.incidente.id, { expected_version: received.incidente.expected_version, clasificacion: 'condicionado', clasificado_por: 'ana', operation_id: 'class-2' });
    expect(done.ok).toBe(true); expect(done.incidente.clasificacion).toBe('condicionado');
  });

  it('marca devolución dañada, crea incidente urgente y tarea de revisión', () => {
    const incident = crearIncidente(db, { tipo: 'otro', sku: 'FB-X', motivo: 'Devolución', creado_por: 'ana', operation_id: 'return-3' });
    const received = recibirDevolucion(db, incident.incidente.id, { expected_version: 1, recibido_por: 'ana', operation_id: 'receive-3' });
    const damaged = marcarDanoDevolucion(db, incident.incidente.id, { expected_version: received.incidente.expected_version, motivo: 'Marco roto', marcado_por: 'ana', operation_id: 'damage-3' });
    expect(damaged.ok).toBe(true); expect(damaged.incidente.severidad).toBe('urgente'); expect(damaged.incidente.clasificacion).toBe('no_disponible');
    expect(damaged.tarea.tipo).toBe('verificar');
  });

  it('REST rechaza mutaciones sin permiso de stock', async () => {
    const app = appFor(db, 'sin-permiso', []);
    const response = await request(app).post('/api/stock-exceptions/devoluciones/1/recibir').send({ expected_version: 1, operation_id: 'forbidden-1' });
    expect(response.status).toBe(403); expect(response.body.code).toBe('FORBIDDEN');
  });
});
