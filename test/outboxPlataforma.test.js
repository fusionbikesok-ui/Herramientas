/**
 * E2 T1 tarea 9 — outbox durable del legado hacia la plataforma.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  encolarEventoPlataforma, crearDespachadorOutbox, estadoOutbox, crearEnvioEventoCatalogo,
  RechazoPlataforma, capturaHabilitada, backoffMs, RUTA_EVENTOS_CATALOGO, revisarOutbox, iniciarOutboxPlataforma,
} from '../lib/outboxPlataforma.js';
import { firmarInterno } from '../lib/internoHmac.js';

const TEST_DB = './test/tmp-outbox-plataforma.sqlite';
const CON = { OUTBOX_PLATAFORMA_CAPTURA: 'true' };
let db;

const filas = () => db.prepare('SELECT evento_id, estado, intentos, ultimo_error FROM outbox_plataforma ORDER BY id').all();
const encolar = (id, extra = {}) => encolarEventoPlataforma(db, 'matcher.decision', { recurso: id }, { eventoId: id, env: CON, ...extra });

/** Un reloj que el test mueve a mano. */
function reloj(inicio = '2026-09-19T00:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { ahora: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

describe('E2-OBX-01 outbox del legado hacia la plataforma', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterAll(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  it('la captura nace apagada y sólo se enciende con el valor exacto', () => {
    expect(capturaHabilitada({})).toBe(false);
    expect(capturaHabilitada({ OUTBOX_PLATAFORMA_CAPTURA: '1' })).toBe(false);
    expect(capturaHabilitada({ OUTBOX_PLATAFORMA_CAPTURA: 'true' })).toBe(true);
    expect(encolarEventoPlataforma(db, 'matcher.decision', {}, { env: {} })).toBeNull();
    expect(filas()).toEqual([]);
  });

  it('el cambio y su evento son atómicos: si el cambio falla, no queda evento', () => {
    db.exec('CREATE TABLE cambio (x TEXT NOT NULL)');
    const hacer = db.transaction((valor) => {
      encolar('e1');
      db.prepare('INSERT INTO cambio (x) VALUES (?)').run(valor);
    });
    expect(() => hacer(null)).toThrow();
    expect(filas()).toEqual([]);
    hacer('ok');
    expect(filas()).toHaveLength(1);
  });

  it('encolar no llama a la red: la respuesta HTTP del legado no espera al envío', () => {
    let llamadas = 0;
    crearDespachadorOutbox({ db, enviar: async () => { llamadas++; } });
    encolar('e1');
    expect(llamadas).toBe(0);
    expect(filas()[0].estado).toBe('pendiente');
  });

  it('con la plataforma caída el evento queda pendiente con backoff, y al volver sale una sola vez', async () => {
    const r = reloj();
    let caida = true; const enviados = [];
    const d = crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async (e) => { if (caida) throw new Error('plataforma_no_disponible'); enviados.push(e.evento_id); } });
    encolar('e1', { ahora: r.ahora() });
    expect(await d.unaVuelta()).toMatchObject({ reintentar: 1 });
    expect(filas()[0]).toMatchObject({ estado: 'pendiente', intentos: 1, ultimo_error: 'plataforma_no_disponible' });
    caida = false;
    // Antes del backoff no se reintenta.
    expect(await d.unaVuelta()).toMatchObject({ enviados: 0 });
    r.avanzar(backoffMs(1));
    expect(await d.unaVuelta()).toMatchObject({ enviados: 1 });
    await d.unaVuelta();
    expect(enviados).toEqual(['e1']);
    expect(filas()[0].estado).toBe('enviado');
  });

  it('respeta el orden: si uno falla, los siguientes esperan sin gastar intentos', async () => {
    const r = reloj(); const enviados = [];
    const d = crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async (e) => { if (e.evento_id === 'e2' && enviados.length < 2) throw new Error('x'); enviados.push(e.evento_id); } });
    for (const id of ['e1', 'e2', 'e3']) encolar(id, { ahora: r.ahora() });
    await d.unaVuelta();
    expect(filas().map((f) => [f.evento_id, f.estado, f.intentos])).toEqual([['e1', 'enviado', 1], ['e2', 'pendiente', 1], ['e3', 'pendiente', 0]]);
    r.avanzar(backoffMs(1));
    enviados.push('forzar');
    await d.unaVuelta();
    expect(enviados).toEqual(['e1', 'forzar', 'e2', 'e3']);
  });

  it('un rechazo de la plataforma no se reintenta, queda marcado y no frena a los demás', async () => {
    const d = crearDespachadorOutbox({ db, enviar: async (e) => { if (e.evento_id === 'e1') throw new RechazoPlataforma('evento_invalido'); } });
    encolar('e1'); encolar('e2');
    expect(await d.unaVuelta()).toMatchObject({ rechazados: 1, enviados: 1 });
    expect(filas().map((f) => f.estado)).toEqual(['rechazado', 'enviado']);
    expect(await d.unaVuelta()).toMatchObject({ enviados: 0, rechazados: 0 });
  });

  it('un lease vencido (proceso muerto a mitad de un envío) se vuelve a tomar', async () => {
    const r = reloj();
    encolar('e1', { ahora: r.ahora() });
    // Un despachador reclama y "muere": nunca termina su envío.
    const muerto = crearDespachadorOutbox({ db, ahora: r.ahora, leaseMs: 60_000, enviar: () => new Promise(() => {}) });
    void muerto.unaVuelta();
    expect(filas()[0].estado).toBe('enviando');
    const enviados = [];
    const vivo = crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async (e) => { enviados.push(e.evento_id); } });
    await vivo.unaVuelta();
    expect(enviados).toEqual([]);
    r.avanzar(60_001);
    await vivo.unaVuelta();
    expect(enviados).toEqual(['e1']);
  });

  it('dos despachadores a la vez no mandan dos veces el mismo evento', async () => {
    const enviados = [];
    const lento = async (e) => { await new Promise((ok) => setTimeout(ok, 5)); enviados.push(e.evento_id); };
    for (let i = 0; i < 20; i++) encolar(`e${i}`);
    const a = crearDespachadorOutbox({ db, enviar: lento, lote: 7 });
    const b = crearDespachadorOutbox({ db, enviar: lento, lote: 7 });
    for (let i = 0; i < 3; i++) await Promise.all([a.unaVuelta(), b.unaVuelta()]);
    expect(enviados.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `e${i}`).sort());
  });

  it('al apagar, lo reclamado y no enviado vuelve a pendiente sin gastar el intento', async () => {
    let d;
    d = crearDespachadorOutbox({ db, enviar: async () => { d.detener(); } });
    encolar('e1'); encolar('e2');
    await d.unaVuelta();
    expect(filas().map((f) => [f.estado, f.intentos])).toEqual([['enviado', 1], ['pendiente', 0]]);
  });

  it('el estado cuenta atrasados y rechazados para la alerta', async () => {
    const r = reloj();
    encolar('e1', { ahora: r.ahora() });
    r.avanzar(31 * 60_000);
    encolar('e2', { ahora: r.ahora() });
    expect(estadoOutbox(db, { minutos: 30, ahora: r.ahora() })).toEqual({ atrasados: 1, pendientes: 2, rechazados: 0 });
  });

  it('los enviados se purgan a los 30 días; los pendientes y rechazados no', async () => {
    const r = reloj();
    const d = crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async (e) => { if (e.evento_id === 'e2') throw new RechazoPlataforma('x'); } });
    encolar('e1', { ahora: r.ahora() }); encolar('e2', { ahora: r.ahora() });
    await d.unaVuelta();
    r.avanzar(31 * 86_400_000);
    encolar('e3', { ahora: r.ahora() });
    await crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async () => { throw new Error('caida'); } }).unaVuelta();
    expect(filas().map((f) => f.evento_id)).toEqual(['e2', 'e3']);
  });

  describe('alerta y arranque', () => {
    const incidentes = () => db.prepare("SELECT tipo_error, estado FROM incidentes_operativos WHERE proceso = 'outbox_plataforma' ORDER BY tipo_error").all();

    it('eventos atrasados abren incidente, y se cierra solo cuando salen', async () => {
      const r = reloj();
      encolar('e1', { ahora: r.ahora() });
      r.avanzar(31 * 60_000);
      revisarOutbox(db, { ahora: r.ahora() });
      expect(incidentes()).toEqual([{ tipo_error: 'outbox_atrasada', estado: 'activo' }]);
      await crearDespachadorOutbox({ db, ahora: r.ahora, enviar: async () => {} }).unaVuelta();
      revisarOutbox(db, { ahora: r.ahora() });
      expect(incidentes()).toEqual([{ tipo_error: 'outbox_atrasada', estado: 'resuelto' }]);
    });

    it('un rechazo abre su propio incidente', async () => {
      encolar('e1');
      await crearDespachadorOutbox({ db, enviar: async () => { throw new RechazoPlataforma('x'); } }).unaVuelta();
      revisarOutbox(db);
      expect(incidentes()).toEqual([{ tipo_error: 'outbox_rechazada', estado: 'activo' }]);
    });

    it('el despachador nace apagado, y con media configuración no arranca ni rompe', () => {
      const errores = []; const log = { log: () => {}, error: (m) => errores.push(m) };
      expect(iniciarOutboxPlataforma(db, { env: {}, log })).toBeNull();
      expect(iniciarOutboxPlataforma(db, { env: { OUTBOX_PLATAFORMA_ENVIO: 'true' }, log })).toBeNull();
      expect(errores[0]).toMatch(/despachador apagado/);
      const d = iniciarOutboxPlataforma(db, {
        env: { OUTBOX_PLATAFORMA_ENVIO: 'true', SOMBRA_PLATAFORMA_URL: 'http://x', SOMBRA_KEYRING_FILE: '/k' }, log,
        cargarKeyring: () => ({ activeKeyId: 'k1', keys: { k1: Buffer.alloc(32) } }),
      });
      expect(d).not.toBeNull();
      d.detener();
    });
  });

  describe('envío firmado a la plataforma', () => {
    const clave = Buffer.alloc(32, 3);
    const keyring = { activeKeyId: 'k1', keys: { k1: clave } };
    const conRespuesta = (status, capturas = []) => crearEnvioEventoCatalogo({
      url: 'http://plataforma:3201', keyring,
      fetch: async (url, init) => { capturas.push({ url: String(url), init }); return { status, body: null }; },
    });

    it('manda el evento firmado a la ruta de eventos del catálogo', async () => {
      const capturas = [];
      await conRespuesta(200, capturas)({ evento_id: 'e1', tipo: 'matcher.decision', payload: { recurso: 'MLA1' } });
      const { url, init } = capturas[0];
      expect(url).toBe(`http://plataforma:3201${RUTA_EVENTOS_CATALOGO}`);
      expect(JSON.parse(init.body.toString())).toEqual({ evento_id: 'e1', recurso: 'MLA1' });
      const h = init.headers;
      expect(h['x-fusion-signature']).toBe(firmarInterno(clave, h['x-fusion-timestamp'], h['x-fusion-nonce'], 'POST', RUTA_EVENTOS_CATALOGO, init.body));
    });

    it('400 es rechazo definitivo; 401, 409, 500 y la red caída son transitorios', async () => {
      const ev = { evento_id: 'e1', tipo: 'matcher.decision', payload: {} };
      await expect(conRespuesta(400)(ev)).rejects.toBeInstanceOf(RechazoPlataforma);
      for (const s of [401, 409, 500]) {
        const p = conRespuesta(s)(ev);
        await expect(p).rejects.toThrow(`plataforma_${s}`);
        await expect(p).rejects.not.toBeInstanceOf(RechazoPlataforma);
      }
      const red = crearEnvioEventoCatalogo({ url: 'http://x', keyring, fetch: async () => { throw new Error('ECONNREFUSED'); } });
      await expect(red(ev)).rejects.toThrow('plataforma_no_disponible');
    });
  });
});
