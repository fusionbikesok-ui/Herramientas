import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  marcarSombra, abandonarHuerfanas, abandonarVencidos, purgarSombra,
  permitirCuentaAjena, reiniciarDefensaCuentaAjena, crearColaSombra,
  copiaHabilitada, bootId, sombraLimites,
} from '../lib/sombra.js';

const TEST_DB = './test/tmp-sombra.sqlite';
let db;

function evento(id, { status = 'pending', recibido = '2026-09-16T00:00:00.000Z', sombra = null, boot = null } = {}) {
  db.prepare(`INSERT INTO integration_events
    (event_id,event_type,channel,source,external_event_id,resource_id,received_at,correlation_id,dedupe_key,status,shadow_status,boot_id)
    VALUES (?,'webhook.received','ml','mercadolibre',?,?,?,?,?,?,?,?)`)
    .run(id, `fp-${id}`, `/orders/${id}`, recibido, `corr-${id}`, `dk-${id}`, status, sombra, boot);
  return id;
}

const sombraDe = (id) => db.prepare('SELECT shadow_status, shadow_reason, ack_at, enqueue_at, completed_at, boot_id, attempt_id FROM integration_events WHERE event_id=?').get(id);

describe('E1-RCP-01 ciclo de vida de la copia de sombra', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
    reiniciarDefensaCuentaAjena();
  });
  afterAll(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  it('la copia nace apagada y sólo se enciende con el flag exacto', () => {
    expect(copiaHabilitada({})).toBe(false);
    expect(copiaHabilitada({ SOMBRA_COPIA_ENABLED: 'false' })).toBe(false);
    expect(copiaHabilitada({ SOMBRA_COPIA_ENABLED: '1' })).toBe(false);
    expect(copiaHabilitada({ SOMBRA_COPIA_ENABLED: 'true' })).toBe(true);
  });

  it('rechaza un estado o una razón que el esquema no puede validar', () => {
    evento('ev-1');
    expect(() => marcarSombra(db, 'ev-1', 'inventado')).toThrow(/estado de sombra inválido/);
    expect(() => marcarSombra(db, 'ev-1', 'discarded', { razon: 'porque_si' })).toThrow(/razón de sombra inválida/);
    // Y no deja la fila a medio marcar.
    expect(sombraDe('ev-1').shadow_status).toBeNull();
  });

  it('no inventa filas: marcar un evento inexistente no escribe nada', () => {
    expect(marcarSombra(db, 'no-existe', 'queued')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
  });

  it('abandona lo que quedó activo de otro proceso y lo vencido del propio', () => {
    evento('ev-otro', { sombra: 'attempting', boot: 'boot-viejo' });
    evento('ev-mio-vencido', { sombra: 'attempting', boot: bootId, recibido: new Date(Date.now() - 5 * 60_000).toISOString() });
    evento('ev-mio-fresco', { sombra: 'attempting', boot: bootId, recibido: new Date().toISOString() });

    expect(abandonarHuerfanas(db)).toBe(1);
    expect(sombraDe('ev-otro')).toMatchObject({ shadow_status: 'abandoned', shadow_reason: 'process_stopped' });
    // El del proceso actual no se toca por antigüedad de boot.
    expect(sombraDe('ev-mio-vencido').shadow_status).toBe('attempting');

    expect(abandonarVencidos(db, 60_000)).toBe(1);
    expect(sombraDe('ev-mio-vencido')).toMatchObject({ shadow_status: 'abandoned', shadow_reason: 'process_stopped' });
    expect(sombraDe('ev-mio-fresco').shadow_status).toBe('attempting');
  });

  it('la purga sólo borra sombra terminada con trabajo legacy cerrado', () => {
    const viejo = new Date(Date.now() - 401 * 24 * 60 * 60 * 1000).toISOString();
    const reciente = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    evento('purgable', { status: 'completed', sombra: 'copied', recibido: viejo });
    evento('viejo-pero-en-curso', { status: 'processing', sombra: 'copied', recibido: viejo });
    evento('viejo-sombra-activa', { status: 'completed', sombra: 'queued', recibido: viejo });
    evento('reciente', { status: 'completed', sombra: 'copied', recibido: reciente });
    db.prepare("INSERT INTO integration_event_history (event_id,stage,to_status,correlation_id,created_at) VALUES ('purgable','webhook.persist','pending','corr-purgable',?)").run(viejo);

    expect(purgarSombra(db)).toBe(1);
    const quedan = db.prepare('SELECT event_id FROM integration_events ORDER BY event_id').all().map((f) => f.event_id);
    expect(quedan).toEqual(['reciente', 'viejo-pero-en-curso', 'viejo-sombra-activa']);
    // El historial del evento purgado se va con él: no queda huérfano.
    expect(db.prepare("SELECT COUNT(*) n FROM integration_event_history WHERE event_id='purgable'").get().n).toBe(0);
  });

  it('E1-RCP-02 la defensa de cuenta ajena corta por IP y ventana, y limpia su mapa', () => {
    for (let i = 0; i < 20; i++) expect(permitirCuentaAjena('1.2.3.4')).toBe(true);
    expect(permitirCuentaAjena('1.2.3.4')).toBe(false);
    // Otra IP no queda castigada por la primera.
    expect(permitirCuentaAjena('5.6.7.8')).toBe(true);
    // Pasada la ventana, la misma IP vuelve a poder.
    expect(permitirCuentaAjena('1.2.3.4', Date.now() + 61 * 60 * 1000)).toBe(true);
  });
});

describe('E1-QUE-01 cola posterior al ACK', () => {
  // Las colas creadas en un test se detienen antes de rotar la base: si no, un intento en vuelo
  // escribe contra la conexión que el beforeEach siguiente ya cerró.
  const colas = [];
  const nuevaCola = (opciones) => { const c = crearColaSombra(opciones); colas.push(c); return c; };

  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterEach(async () => { while (colas.length) await colas.pop().detener(); });

  it('copia un aviso y deja el ciclo completo con tiempos', async () => {
    evento('ev-ok');
    let termino = false;
    const cola = nuevaCola({ db, enviar: async () => undefined, alFinalizar: () => { termino = true; } });
    expect(cola.encolar('ev-ok')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(termino).toBe(true);
    const fila = sombraDe('ev-ok');
    expect(fila.shadow_status).toBe('copied');
    expect(fila.enqueue_at).toBeTruthy();
    expect(fila.completed_at).toBeTruthy();
    expect(fila.boot_id).toBe(bootId);
    expect(fila.attempt_id).toBeTruthy();
    expect(cola.estado()).toMatchObject({ copiados: 1, descartados: 0, profundidad: 0 });
  });

  it('un solo intento: la plataforma caída descarta y no reintenta', async () => {
    evento('ev-caida');
    let llamadas = 0;
    const cola = nuevaCola({ db, enviar: async () => { llamadas += 1; throw new Error('sin ruta al host'); } });
    cola.encolar('ev-caida');
    await new Promise((r) => setTimeout(r, 30));
    expect(llamadas).toBe(1);
    expect(sombraDe('ev-caida')).toMatchObject({ shadow_status: 'discarded', shadow_reason: 'platform_unavailable' });
  });

  it('respeta el timeout de 250 ms y no espera a una plataforma lenta', async () => {
    evento('ev-lento');
    const cola = nuevaCola({ db, timeoutMs: 20, enviar: () => new Promise((r) => setTimeout(r, 500)) });
    cola.encolar('ev-lento');
    await new Promise((r) => setTimeout(r, 80));
    expect(sombraDe('ev-lento')).toMatchObject({ shadow_status: 'discarded', shadow_reason: 'platform_timeout' });
    expect(cola.estado().timeouts).toBe(1);
  });

  it('cola llena descarta en el acto, sin promesa suelta', async () => {
    const cola = nuevaCola({ db, capacidad: 2, concurrencia: 1, enviar: () => new Promise((r) => setTimeout(r, 200)) });
    for (const id of ['a', 'b', 'c', 'd']) evento(id);
    // El primero pasa a en vuelo; b y c llenan la cola; d se descarta de forma síncrona.
    expect(cola.encolar('a')).toBe(true);
    expect(cola.encolar('b')).toBe(true);
    expect(cola.encolar('c')).toBe(true);
    expect(cola.encolar('d')).toBe(false);
    expect(sombraDe('d')).toMatchObject({ shadow_status: 'discarded', shadow_reason: 'queue_full' });
    expect(cola.estado()).toMatchObject({ llenos: 1, capacidad: 2 });
  });

  it('no supera la concurrencia configurada', async () => {
    for (const id of ['x1', 'x2', 'x3', 'x4']) evento(id);
    let enVuelo = 0; let pico = 0;
    const cola = nuevaCola({
      db,
      concurrencia: 2,
      enviar: async () => {
        enVuelo += 1; pico = Math.max(pico, enVuelo);
        await new Promise((r) => setTimeout(r, 20));
        enVuelo -= 1;
      },
    });
    for (const id of ['x1', 'x2', 'x3', 'x4']) cola.encolar(id);
    await new Promise((r) => setTimeout(r, 200));
    expect(pico).toBe(2);
    expect(cola.estado()).toMatchObject({ copiados: 4, profundidad: 0 });
    expect(sombraLimites.CONCURRENCIA).toBe(2);
  });

  it('detener abandona lo no intentado, espera lo en vuelo y no escribe después del cierre', async () => {
    for (const id of ['d1', 'd2', 'd3']) evento(id);
    let sueltos = 0;
    process.on('unhandledRejection', () => { sueltos += 1; });
    const cola = crearColaSombra({
      db, concurrencia: 1, enviar: () => new Promise((r) => setTimeout(r, 40)),
    });
    for (const id of ['d1', 'd2', 'd3']) cola.encolar(id);

    const final = await cola.detener();
    // d1 estaba en vuelo y se esperó; d2 y d3 nunca se intentaron y quedan abandonados con razón.
    expect(sombraDe('d1').shadow_status).toBe('copied');
    for (const id of ['d2', 'd3']) {
      expect(sombraDe(id), id).toMatchObject({ shadow_status: 'abandoned', shadow_reason: 'process_stopped' });
    }
    expect(final).toMatchObject({ detenida: true, detenidos: 2, enVuelo: 0, profundidad: 0 });
    // Detenida no acepta más trabajo en vuelo, y cerrar la base no produce rechazos sueltos.
    db.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(sueltos).toBe(0);
    process.removeAllListeners('unhandledRejection');
  });
});
