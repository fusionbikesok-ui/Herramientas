import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { encolarTrabajo, reclamarTrabajos, cerrarTrabajo, reencolarTrabajo, hayTrabajoPendiente } from '../lib/trabajosRecurso.js';

const PATH = '/tmp/trabajos-recurso-test.sqlite';
let db;
beforeEach(() => { for (const x of ['', '-wal', '-shm']) fs.rmSync(PATH + x, { force: true }); db = openDb(PATH); });
afterEach(() => { db.close(); for (const x of ['', '-wal', '-shm']) fs.rmSync(PATH + x, { force: true }); });
const fila = () => db.prepare('SELECT * FROM trabajos_recurso').get();

describe('trabajos durables por recurso', () => {
  it('un aviso nuevo del mismo recurso no crea otra fila: sube la generación y reprograma', () => {
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1', demoraMs: 60_000 });
    const antes = fila().run_after;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1', demoraMs: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM trabajos_recurso').get().n).toBe(1);
    expect(fila().generacion).toBe(2);
    expect(fila().run_after < antes).toBe(true);
    expect(reclamarTrabajos(db, ['order.ml'])).toHaveLength(1); // la coalescencia reprograma, no descarta
  });

  it('un aviso mientras está tomado lo deja dirty y al terminar se repite en vez de cerrarse', () => {
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1' });
    const [t] = reclamarTrabajos(db, ['order.ml']);
    expect(reclamarTrabajos(db, ['order.ml'])).toHaveLength(0); // tomado: nadie más lo toma
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1' });
    expect(fila()).toMatchObject({ estado: 'tomado', dirty: 1, generacion: 2 });
    expect(cerrarTrabajo(db, t)).toMatchObject({ cerrado: false, motivo: 'repite_por_aviso_nuevo' });
    expect(fila().estado).toBe('pendiente');
    const [t2] = reclamarTrabajos(db, ['order.ml']);
    expect(cerrarTrabajo(db, t2).cerrado).toBe(true);
    expect(fila().estado).toBe('hecho');
  });

  it('un trabajo tomado con el lease vencido (worker caído) lo toma otro; el token viejo ya no cierra', () => {
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1' });
    const [viejo] = reclamarTrabajos(db, ['order.ml'], { leaseMs: -1000 });
    const [nuevo] = reclamarTrabajos(db, ['order.ml']);
    expect(nuevo.lease_token).not.toBe(viejo.lease_token);
    expect(cerrarTrabajo(db, viejo)).toMatchObject({ cerrado: false, motivo: 'lease_perdido' });
    expect(cerrarTrabajo(db, nuevo).cerrado).toBe(true);
  });

  it('reencolar vuelve a pendiente con backoff y nunca queda hecho; tras el tope pasa a muerto', () => {
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:A' });
    const [t] = reclamarTrabajos(db, ['stock.bolsa']);
    reencolarTrabajo(db, t, { motivo: 'barrera' });
    expect(fila()).toMatchObject({ estado: 'pendiente', ultimo_error: 'barrera' });
    expect(reclamarTrabajos(db, ['stock.bolsa'])).toHaveLength(0); // aún no vence el backoff
    db.prepare('UPDATE trabajos_recurso SET intentos = 12, estado = ?, lease_token = ? WHERE 1').run('tomado', 'x');
    expect(reencolarTrabajo(db, { ...t, intentos: 12, lease_token: 'x' }).muerto).toBe(true);
    expect(fila().estado).toBe('muerto');
  });

  it('un hecho se reabre con otro aviso', () => {
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1' });
    cerrarTrabajo(db, reclamarTrabajos(db, ['order.ml'])[0]);
    expect(hayTrabajoPendiente(db, 'order.ml')).toBe(false);
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '1' });
    expect(hayTrabajoPendiente(db, 'order.ml', { recurso: '1' })).toBe(true);
  });
});
