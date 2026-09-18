import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { crearMuestreoCola, evaluarAlertasLegado, medirSombraLegado, publicarAlertasLegado } from '../lib/metricasSombra.js';
import { importarPerdidas } from '../lib/emisorSombra.js';

const TEST_DB = './test/tmp-metricas-sombra.sqlite';
let db;
const ahora = Date.parse('2026-09-16T12:00:00.000Z');
const iso = (msAtras) => new Date(ahora - msAtras).toISOString();

let n = 0;
function recibo({ estado = null, razon = null, recibido = iso(60_000), ack = null, completado = null, importado = null, recurso = '/orders/1', topic = 'orders_v2' } = {}) {
  n++;
  db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,resource_id,received_at,correlation_id,dedupe_key,metadata_json,status,
      shadow_status,shadow_reason,ack_at,completed_at,shadow_imported_at)
    VALUES (?,'webhook.received','ml','mercadolibre',?,?,?,?,?,'completed',?,?,?,?,?)`)
    .run(`ev-${n}`, recurso, recibido, `c-${n}`, `d-${n}`, JSON.stringify({ topic }), estado, razon, ack, completado, importado);
  return `ev-${n}`;
}
const ids = (alertas) => alertas.map((a) => a.id).sort();

describe('C8 métricas y alertas de la sombra en el legado', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterAll(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  it('mide estados, razones, latencia de copia y pérdidas sin PII', () => {
    for (const ms of [10, 20, 30, 40, 200]) recibo({ estado: 'copied', ack: iso(5000), completado: iso(5000 - ms) });
    recibo({ estado: 'discarded', razon: 'platform_unavailable', completado: iso(30 * 60_000) });
    recibo({ estado: 'excluded', razon: 'foreign_account' });
    const m = medirSombraLegado(db, { ahoraMs: ahora });
    expect(m.ultimas_24h.por_estado).toEqual({ copied: 5, discarded: 1, excluded: 1 });
    expect(m.ultimas_24h.latencia_copia_p95_ms).toBe(200);
    expect(m.perdidas_sin_importar).toEqual({ cantidad: 1, mas_vieja_s: 1800 });
    expect(JSON.stringify(m)).not.toMatch(/orders\/1|ev-/);
    expect(evaluarAlertasLegado(m)).toEqual([]);
  });

  it('cada alerta tiene su fixture, umbral, responsable y runbook', () => {
    recibo({ estado: 'discarded', razon: 'queue_full' });
    recibo({ estado: 'abandoned', razon: 'response_not_finished' });
    recibo({ estado: 'discarded', razon: 'platform_timeout', completado: iso(2 * 3600_000), recibido: iso(2 * 3600_000) });
    db.prepare("INSERT INTO woo_webhooks_estado (id,topic,status,delivery_url,propio,visto_en,status_desde) VALUES (1,'order.updated','disabled','x',1,?,?)").run(iso(0), iso(0));
    const alertas = evaluarAlertasLegado(medirSombraLegado(db, { ahoraMs: ahora }), { colaSaturadaSostenida: true });
    expect(ids(alertas)).toEqual(['cola_llena', 'cola_saturada', 'perdidas_sin_importar', 'respuesta_no_terminada', 'webhook_woo_inactivo']);
    for (const a of alertas) {
      expect(a, a.id).toMatchObject({ umbral: expect.any(String), responsable: expect.stringMatching(/operaciones|desarrollo/), runbook: expect.stringContaining('sop-sombra.md#') });
    }
  });

  it('cada runbook citado por una alerta existe en el SOP', () => {
    const sop = fs.readFileSync(new URL('../docs/superpowers/specs/e1/sop-sombra.md', import.meta.url), 'utf8');
    recibo({ estado: 'discarded', razon: 'queue_full' });
    recibo({ estado: 'abandoned', razon: 'response_not_finished' });
    recibo({ estado: 'discarded', razon: 'platform_timeout', completado: iso(2 * 3600_000), recibido: iso(2 * 3600_000) });
    db.prepare("INSERT INTO woo_webhooks_estado (id,topic,status,delivery_url,propio,visto_en,status_desde) VALUES (1,'order.updated','disabled','x',1,?,?)").run(iso(0), iso(0));
    for (const a of evaluarAlertasLegado(medirSombraLegado(db, { ahoraMs: ahora }), { colaSaturadaSostenida: true })) {
      expect(sop, a.runbook).toContain(`<a id="${a.runbook.split('#')[1]}"></a>`);
    }
  });

  it('la cola sólo está saturada si todas las muestras de 5 minutos superan el 75 %', () => {
    let profundidad = 200;
    const cola = { estado: () => ({ profundidad, capacidad: 256 }) };
    const m = crearMuestreoCola(cola);
    for (let t = 0; t <= 5 * 60_000; t += 30_000) m.registrar(ahora + t);
    expect(m.saturadaSostenida(ahora + 5 * 60_000)).toBe(true);
    profundidad = 10; m.registrar(ahora + 5 * 60_000 + 30_000);
    expect(m.saturadaSostenida(ahora + 5 * 60_000 + 30_000)).toBe(false);
    // Con menos de cinco minutos de muestras no se afirma saturación sostenida.
    const corta = crearMuestreoCola({ estado: () => ({ profundidad: 250, capacidad: 256 }) });
    corta.registrar(ahora); corta.registrar(ahora + 60_000);
    expect(corta.saturadaSostenida(ahora + 60_000)).toBe(false);
  });

  it('publica alertas como incidentes de la integración sombra y los cierra cuando se van', () => {
    const alerta = { id: 'cola_llena', severidad: 'advertencia', responsable: 'operaciones', umbral: 'x', valor: 1, runbook: 'sop#cola' };
    publicarAlertasLegado(db, [alerta]);
    const activos = () => db.prepare("SELECT tipo_error FROM incidentes_operativos WHERE integracion='sombra' AND estado='activo'").all().map((f) => f.tipo_error);
    expect(activos()).toEqual(['cola_llena']);
    publicarAlertasLegado(db, []);
    expect(activos()).toEqual([]);
  });
});

describe('E1-PGDOWN-01 importación de pérdidas desde el legado', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });

  it('reenvía cada descarte por plataforma caída con su bloque import y lo marca sólo con 202', async () => {
    const a = recibo({ estado: 'discarded', razon: 'platform_unavailable', completado: iso(600_000), recurso: '/orders/11' });
    const b = recibo({ estado: 'discarded', razon: 'platform_timeout', completado: iso(500_000), recurso: '/orders/12' });
    recibo({ estado: 'discarded', razon: 'queue_full', completado: iso(400_000), recurso: '/orders/13' });
    recibo({ estado: 'discarded', razon: 'platform_unavailable', completado: iso(300_000), importado: iso(1000), recurso: '/orders/14' });
    const enviadas = [];
    const r = await importarPerdidas({ db, enviarSenal: async (s) => { enviadas.push(s); } });
    expect(r).toMatchObject({ importadas: 2, invalidas: 0, pendientes: 0, detenida: false });
    expect(enviadas.map((s) => [s.resource_id, s.import.reason])).toEqual([['11', 'platform_unavailable'], ['12', 'platform_timeout']]);
    expect(enviadas[0].import.discarded_at).toBe(iso(600_000));
    const marcados = db.prepare('SELECT event_id FROM integration_events WHERE shadow_imported_at IS NOT NULL ORDER BY event_id').all().map((f) => f.event_id);
    expect(marcados).toEqual(expect.arrayContaining([a, b]));
    // Una segunda pasada no reenvía nada.
    expect((await importarPerdidas({ db, enviarSenal: async () => { throw new Error('no debería'); } })).importadas).toBe(0);
  });

  it('reimporta los descartes por cuenta no configurada cuando la cuenta ya existe', async () => {
    // El 2026-09-17, encender el canario de ML sin la cuenta en SENALES_CUENTAS descartó 347 recibos con esta
    // razón. Al corregir la configuración tienen que recuperarse solos, o esas horas se pierden para siempre.
    const a = recibo({ estado: 'discarded', razon: 'cuenta_no_configurada', completado: iso(600_000), recurso: '/items/MLA1', topic: 'items' });
    const enviadas = [];
    const r = await importarPerdidas({ db, enviarSenal: async (s) => { enviadas.push(s); } });
    expect(r).toMatchObject({ importadas: 1, invalidas: 0, pendientes: 0, detenida: false });
    expect(enviadas[0].import.reason).toBe('cuenta_no_configurada');
    expect(db.prepare('SELECT shadow_imported_at FROM integration_events WHERE event_id = ?').get(a).shadow_imported_at).not.toBeNull();
  });

  it('si la cuenta sigue sin configurar, se detiene en el primero y no martilla', async () => {
    recibo({ estado: 'discarded', razon: 'cuenta_no_configurada', completado: iso(600_000), recurso: '/items/MLA2', topic: 'items' });
    recibo({ estado: 'discarded', razon: 'cuenta_no_configurada', completado: iso(500_000), recurso: '/items/MLA3', topic: 'items' });
    let llamadas = 0;
    const r = await importarPerdidas({ db, enviarSenal: async () => { llamadas++; throw new Error('cuenta_no_configurada'); } });
    expect(r).toMatchObject({ importadas: 0, detenida: true, pendientes: 2 });
    expect(llamadas).toBe(1);
  });

  it('con la plataforma todavía caída se detiene y no marca nada; un recibo inválido no bloquea al resto', async () => {
    recibo({ estado: 'discarded', razon: 'platform_unavailable', completado: iso(600_000), recurso: '/orders/21' });
    recibo({ estado: 'discarded', razon: 'platform_unavailable', completado: iso(500_000), recurso: '/orders/22' });
    let llamadas = 0;
    const caida = await importarPerdidas({ db, enviarSenal: async () => { llamadas++; throw new Error('platform_unavailable'); } });
    expect(caida).toMatchObject({ importadas: 0, detenida: true, pendientes: 2 });
    expect(llamadas).toBe(1);
    const invalido = await importarPerdidas({ db, enviarSenal: async (s) => { if (s.resource_id === '21') throw new Error('invalid_resource'); } });
    expect(invalido).toMatchObject({ importadas: 1, invalidas: 1, pendientes: 1 });
  });
});
