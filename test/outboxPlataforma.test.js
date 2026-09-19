/**
 * E2 T1 tarea 9 — outbox durable del legado hacia la plataforma.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  encolarEventoPlataforma, crearDespachadorOutbox, estadoOutbox, crearEnvioEventoCatalogo,
  RechazoPlataforma, capturaHabilitada, backoffMs, RUTA_EVENTOS_CATALOGO, RUTA_EVENTOS_IDENTIDAD, revisarOutbox, iniciarOutboxPlataforma,
  sincronizarCaptura, traducirEvento,
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

  describe('captura por triggers (tarea 10)', () => {
    const outbox = () => db.prepare('SELECT tipo, payload FROM outbox_plataforma ORDER BY id').all().map((f) => ({ tipo: f.tipo, ...JSON.parse(f.payload) }));
    const capturar = (on) => sincronizarCaptura(db, on ? CON : {});
    const decision = (clave, sku, accion = 'confirmar') => db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES (?, ?, ?, ?)').run(clave, sku, accion, '2026-09-19');

    it('con la captura apagada los cambios no dejan eventos', () => {
      capturar(false);
      decision('MLA1|', 'FB-1');
      expect(outbox()).toEqual([]);
    });

    it('alta, cambio y baja de una decisión dejan su evento, en la misma transacción', () => {
      capturar(true);
      decision('MLA1|', 'FB-1');
      db.prepare("UPDATE sku_matcher_decisiones SET sku = 'FB-2' WHERE clave = 'MLA1|'").run();
      db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave = 'MLA1|'").run();
      expect(outbox().map((e) => [e.op, e.clave, e.sku ?? null])).toEqual([['vigente', 'MLA1|', 'FB-1'], ['vigente', 'MLA1|', 'FB-2'], ['borrada', 'MLA1|', null]]);
      // Atomicidad: si la transacción del cambio se deshace, su evento también.
      expect(() => db.transaction(() => { decision('MLA2|', 'FB-3'); throw new Error('falla'); })()).toThrow();
      expect(outbox()).toHaveLength(3);
    });

    it('reescribir una decisión igual no es un evento', () => {
      capturar(true);
      decision('MLA1|', 'FB-1');
      db.prepare("UPDATE sku_matcher_decisiones SET actualizado_en = '2026-09-20', wc_nombre = 'x' WHERE clave = 'MLA1|'").run();
      expect(outbox()).toHaveLength(1);
    });

    it('las tres formas de escribir que usa el legado quedan capturadas', () => {
      capturar(true);
      db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES ('MLA1|', 'FB-1', 'asignar', 'x')").run();
      db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES ('MLA1|', 'FB-2', 'asignar', 'x')").run();
      db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES ('MLA1|', 'FB-3', 'confirmar', 'x')
                  ON CONFLICT(clave) DO UPDATE SET sku = excluded.sku, accion = excluded.accion`).run();
      // INSERT OR IGNORE sobre una clave existente no cambia nada: no es un evento.
      db.prepare("INSERT OR IGNORE INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES ('MLA1|', 'FB-9', 'confirmar', 'x')").run();
      expect(outbox().map((e) => e.sku)).toEqual(['FB-1', 'FB-2', 'FB-3']);
    });

    it('en identidad, sólo los cambios de estado o severidad son eventos, no la detección periódica', () => {
      capturar(true);
      const id = db.prepare(`INSERT INTO identidad_casos (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, primera_deteccion_en, ultima_deteccion_en)
        VALUES ('ml_fusion', 'MLA5|', 'sin_match', 'pendiente', 'normal', 'f', 'x', 'x')`).run().lastInsertRowid;
      db.prepare("UPDATE identidad_casos SET ultima_deteccion_en = 'y', evidencia_fingerprint = 'g' WHERE id = ?").run(id);
      db.prepare("UPDATE identidad_casos SET estado = 'resuelto' WHERE id = ?").run(id);
      expect(outbox().map((e) => [e.tipo, e.estado])).toEqual([['identidad.caso', 'pendiente'], ['identidad.caso', 'resuelto']]);
    });
  });

  describe('traducción al formato de la plataforma', () => {
    const ev = (payload, tipo = 'matcher.decision') => traducirEvento({ evento_id: 'e', tipo, payload, creado_en: '2026-09-19T00:00:00.000Z' });

    it('las decisiones automáticas entran como del sistema, con su motivo', () => {
      expect(ev({ op: 'vigente', clave: 'MLA1|', sku: 'FB-1', accion: 'asignar', origen: 'auto_seller_sku', confirmado_por: null }).cuerpo)
        .toMatchObject({ actor: 'sistema', motivo: 'autoasignación por SKU', confirmado_por: null });
      expect(ev({ op: 'vigente', clave: 'MLA1|', sku: 'FB-1', accion: 'confirmar', origen: 'identidad_productos', confirmado_por: 'sistema' }).cuerpo)
        .toMatchObject({ actor: 'sistema', motivo: 'identidad de productos' });
      expect(ev({ op: 'vigente', clave: 'MLA1|7', sku: 'FB-1', accion: 'confirmar', origen: null, confirmado_por: 'jose' }).cuerpo)
        .toMatchObject({ actor: 'persona', confirmado_por: 'jose', recurso: 'MLA1', variacion: '7' });
    });

    it('omitir va sin SKU, y una baja es revocar', () => {
      expect(ev({ op: 'vigente', clave: 'MLA1|', sku: '', accion: 'omitir' }).cuerpo).toMatchObject({ accion: 'omitir', sku: null });
      expect(ev({ op: 'borrada', clave: 'MLA1|' }).cuerpo).toMatchObject({ accion: 'revocar', sku: null });
    });

    it('una clave o una acción que la plataforma no aceptaría se rechaza acá', () => {
      expect(() => ev({ op: 'vigente', clave: 'MLA1', accion: 'confirmar' })).toThrow(RechazoPlataforma);
      expect(() => ev({ op: 'vigente', clave: 'MLA1|', accion: 'inventada' })).toThrow(RechazoPlataforma);
    });

    it('un caso de identidad va a su ruta, con prioridad y si sigue abierto', () => {
      const r = ev({ id: 7, ml_key: 'MLA9|', estado: 'pendiente', severidad: 'critica', clasificacion: 'c', direccion: 'ml_fusion' }, 'identidad.caso');
      expect(r.ruta).toBe(RUTA_EVENTOS_IDENTIDAD);
      expect(r.cuerpo).toMatchObject({ caso_legado: '7', recurso: 'MLA9', prioridad: 'urgente', abierto: true });
      expect(ev({ id: 7, ml_key: 'MLA9|', estado: 'verificado', severidad: 'normal' }, 'identidad.caso').cuerpo).toMatchObject({ abierto: false, prioridad: 'normal' });
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
      await conRespuesta(200, capturas)({ evento_id: 'e1', tipo: 'matcher.decision', creado_en: '2026-09-19T01:00:00.000Z',
        payload: { op: 'vigente', clave: 'MLA1|', sku: 'FB-1', accion: 'confirmar', origen: null, confirmado_por: 'jose' } });
      const { url, init } = capturas[0];
      expect(url).toBe(`http://plataforma:3201${RUTA_EVENTOS_CATALOGO}`);
      expect(JSON.parse(init.body.toString())).toMatchObject({ evento_id: 'e1', recurso: 'MLA1', variacion: '', sku: 'FB-1' });
      const h = init.headers;
      expect(h['x-fusion-signature']).toBe(firmarInterno(clave, h['x-fusion-timestamp'], h['x-fusion-nonce'], 'POST', RUTA_EVENTOS_CATALOGO, init.body));
    });

    it('400 es rechazo definitivo; 401, 409, 500 y la red caída son transitorios', async () => {
      const ev = { evento_id: 'e1', tipo: 'matcher.decision', creado_en: '2026-09-19T01:00:00.000Z', payload: { op: 'borrada', clave: 'MLA1|' } };
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
