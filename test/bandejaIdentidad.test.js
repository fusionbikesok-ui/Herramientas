/**
 * E3 corte 1 T3 y T6 — lógica pura de la bandeja (sin DOM, sin fetch) y el proxy firmado.
 * La firma del proxy se verifica contra el `verificarInterna` REAL de la plataforma (TS):
 * si los dos lados divergen, este test falla.
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import Fastify from '../plataforma/node_modules/fastify/fastify.js';
import { bandejaIdentidadRouter } from '../routes/bandejaIdentidad.js';
import { resolvePermiso, permiteAcceso } from '../lib/permisos.js';
import { crearOrigenes, verificarInterna } from '../plataforma/src/seguridad/interna.ts';

// Importar lógica pura
const mod = await import('../public/bandeja-identidad/logica.js');
const L = mod.default?.marca ? mod.default : mod.marca ? mod : (globalThis.BandejaLogica ?? globalThis.window?.BandejaLogica);

const clave = crypto.randomBytes(32);
const keyring = { activeKeyId: 'k1', keys: { k1: clave } };
const origenes = crearOrigenes('127.0.0.1/32');
const ID = '01a0d35c-0974-7c07-9e44-19e759f67daa';

/** Una "plataforma" falsa que verifica la firma con el verificador real y guarda lo recibido. */
function plataformaFalsa(estado = 200, cuerpoRespuesta = { ok: true }) {
  const recibidos = [];
  const fetch = async (destino, init) => {
    const cuerpo = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    const v = verificarInterna({
      keyring, origenes, direccion: '127.0.0.1', headers: init.headers, metodo: init.method,
      path: destino.pathname + destino.search, cuerpo, ahoraMs: Date.now(),
    });
    recibidos.push({ metodo: init.method, ruta: destino.pathname + destino.search, cuerpo: cuerpo.toString('utf8'), firmaValida: v.ok, headers: init.headers });
    return { status: estado, json: async () => cuerpoRespuesta };
  };
  return { fetch, recibidos };
}

function app({ user, fetch, url = 'http://plataforma.interna:3100', kr = keyring }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (user) req.user = user; next(); });
  a.use('/api/bandeja-identidad', bandejaIdentidadRouter({ url, keyring: kr, fetch }));
  return a;
}
const operador = { id: 2, username: 'maria', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
const auditor = { id: 3, username: 'auditor', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };

describe('E3 T3 — lógica pura de teclas y acciones', () => {
  it('1/2/3 seleccionan si existe el candidato y Enter vincula', () => {
    expect(L.accionDeTecla('2', { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' })).toEqual({ tipo: 'seleccionar', n: 2 });
    expect(L.accionDeTecla('Enter', { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' })).toEqual({ tipo: 'vincular' });
    expect(L.accionDeTecla('3', { confirmable: false, nCandidatos: 2, tipoCaso: 'sku_pendiente' })).toBeNull();
  });

  it('? aparta, a es ayuda, O omite por ahora, N no existe', () => {
    const c = { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' };
    expect(L.accionDeTecla('?', c)).toEqual({ tipo: 'apartar' });
    expect(L.accionDeTecla('a', c)).toEqual({ tipo: 'ayuda' });
    expect(L.accionDeTecla('o', c)).toEqual({ tipo: 'omitir_por_ahora' });
    expect(L.accionDeTecla('n', c)).toEqual({ tipo: 'no_existe' });
    expect(L.accionDeTecla('s', c)).toBeNull(); // la omisión permanente ya no tiene tecla
  });

  it('en confirmable Enter confirma y X rechaza', () => {
    const c = { confirmable: true, nCandidatos: 0, tipoCaso: 'omitida_revisar' };
    expect(L.accionDeTecla('Enter', c)).toEqual({ tipo: 'confirmar' });
    expect(L.accionDeTecla('x', c)).toEqual({ tipo: 'rechazar' });
  });

  it('siguienteNoSalteado no da vueltas infinitas', () => {
    const cola = [{ id: 'a' }, { id: 'b' }];
    expect(L.siguienteNoSalteado(cola, 0, new Set(['b']))).toBe(-1);
    expect(L.siguienteNoSalteado(cola, 0, new Set())).toBe(1);
  });

  it('indiceNoSalteado: T5, hallazgo Media de Codex — J/K salta los salteados igual que avanzar()', () => {
    const cola = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // b está salteado: desde a, avanzar (delta +1) tiene que ir directo a c.
    expect(L.indiceNoSalteado(cola, 0, 1, new Set(['b']))).toBe(2);
    // desde c, retroceder (delta -1) también tiene que saltear b y llegar a a.
    expect(L.indiceNoSalteado(cola, 2, -1, new Set(['b']))).toBe(0);
  });

  it('indiceNoSalteado: sin salteados de por medio, es un paso simple', () => {
    const cola = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(L.indiceNoSalteado(cola, 0, 1, new Set())).toBe(1);
    expect(L.indiceNoSalteado(cola, 2, -1, new Set())).toBe(1);
  });

  it('indiceNoSalteado: en el límite de la cola, o con todos los restantes salteados, da -1', () => {
    const cola = [{ id: 'a' }, { id: 'b' }];
    expect(L.indiceNoSalteado(cola, 1, 1, new Set())).toBe(-1); // ya es el último
    expect(L.indiceNoSalteado(cola, 0, -1, new Set())).toBe(-1); // ya es el primero
    expect(L.indiceNoSalteado(cola, 0, 1, new Set(['b']))).toBe(-1); // el único siguiente está salteado
  });
});

describe('E3 T4 — «Por qué» y atributos iguales colapsados', () => {
  it('porQue: todo coincide arma una sola frase de coincidencia', () => {
    const o = { explicacion: { atributos: [{ nombre: 'modelo', marca: 'coincide' }, { nombre: 'color', marca: 'coincide' }, { nombre: 'talle', marca: 'coincide' }] } };
    expect(L.porQue(o)).toBe('Modelo, color y talle coinciden.');
  });

  it('porQue: difiere y falta arman dos frases separadas por ";"', () => {
    const o = { explicacion: { atributos: [{ nombre: 'color', marca: 'difiere' }, { nombre: 'talle', marca: 'falta' }] } };
    expect(L.porQue(o)).toBe('El color difiere; el talle falta.');
  });

  it('porQue: equivalente cuenta como coincidencia', () => {
    const o = { explicacion: { atributos: [{ nombre: 'rodado', marca: 'equivalente' }] } };
    expect(L.porQue(o)).toBe('Rodado coincide.');
  });

  it('porQue: sin atributos para comparar lo dice explícito', () => {
    expect(L.porQue({ explicacion: {} })).toBe('Sin atributos para comparar.');
    expect(L.porQue(null)).toBe('Sin atributos para comparar.');
  });

  it('atributosIguales: sólo los que tienen la MISMA marca en TODOS los candidatos', () => {
    const opciones = [
      { explicacion: { atributos: [{ nombre: 'marca', marca: 'coincide' }, { nombre: 'color', marca: 'coincide' }] } },
      { explicacion: { atributos: [{ nombre: 'marca', marca: 'coincide' }, { nombre: 'color', marca: 'difiere' }] } },
    ];
    expect(L.atributosIguales(opciones)).toEqual(['marca']);
  });

  it('atributosIguales: un atributo que falta en algún candidato no cuenta como igual', () => {
    const opciones = [
      { explicacion: { atributos: [{ nombre: 'marca', marca: 'coincide' }] } },
      { explicacion: { atributos: [] } },
    ];
    expect(L.atributosIguales(opciones)).toEqual([]);
  });

  it('atributosIguales: sin candidatos, no hay iguales', () => {
    expect(L.atributosIguales([])).toEqual([]);
  });

  it('atributosIguales: coincide y equivalente NO se agrupan entre sí (marca exacta, no "misma conclusión")', () => {
    // Decisión explícita (hallazgo Media de Codex en T4): "Iguales" resume la MISMA evidencia visual (la
    // marca que ve el operador en la celda, ✓ vs ≈ son símbolos distintos), no la misma conclusión para
    // decidir. Si mañana se quiere agrupar por conclusión, este test es el que hay que cambiar a propósito.
    const opciones = [
      { explicacion: { atributos: [{ nombre: 'rodado', marca: 'coincide' }] } },
      { explicacion: { atributos: [{ nombre: 'rodado', marca: 'equivalente' }] } },
    ];
    expect(L.atributosIguales(opciones)).toEqual([]);
  });

  it('atributosIguales: se sostiene con 3+ candidatos (todos coincide menos uno)', () => {
    const opciones = [
      { explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }] } },
      { explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }] } },
      { explicacion: { atributos: [{ nombre: 'color', marca: 'difiere' }] } },
    ];
    expect(L.atributosIguales(opciones)).toEqual([]);
  });

  it('porQue: sólo diferencias (sin coincidencias ni faltantes)', () => {
    const o = { explicacion: { atributos: [{ nombre: 'color', marca: 'difiere' }, { nombre: 'talle', marca: 'difiere' }] } };
    expect(L.porQue(o)).toBe('Los atributos color y talle difieren.');
  });

  it('porQue: sólo faltantes', () => {
    const o = { explicacion: { atributos: [{ nombre: 'talle', marca: 'falta' }] } };
    expect(L.porQue(o)).toBe('El talle falta.');
  });

  it('porQue: toma otros_atributos además de atributos', () => {
    const o = { explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }], otros_atributos: [{ nombre: 'marca', marca: 'difiere' }] } };
    expect(L.porQue(o)).toBe('Color coincide; el marca difiere.');
  });
});

describe('E3 T6 proxy de la bandeja de identidad', () => {
  it('el actor y es_admin salen de la sesión aunque el cliente mande otros (elevación)', async () => {
    const p = plataformaFalsa(200, { decision_id: 'd', version: 2, vinculo: 'x' });
    const r = await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/decisiones`)
      .set('Idempotency-Key', 'clave-1234')
      .send({ expected_version: 1, eleccion: 'omitir', es_admin: true, usuario: 'otro', actor: { usuario: 'jose', es_admin: true } });
    expect(r.status).toBe(200);
    const enviado = JSON.parse(p.recibidos[0].cuerpo);
    expect(enviado.actor).toEqual({ usuario: 'maria', es_admin: false });
    expect(enviado).not.toHaveProperty('es_admin');
    expect(enviado).not.toHaveProperty('usuario');
    expect(p.recibidos[0].firmaValida).toBe(true);
  });

  it('un admin de la sesión viaja como es_admin:true', async () => {
    const p = plataformaFalsa();
    await request(app({ user: { ...operador, username: 'jose', is_admin: true }, fetch: p.fetch }))
      .post(`/api/bandeja-identidad/casos/${ID}/decisiones`).set('Idempotency-Key', 'clave-1234').send({ expected_version: 1, eleccion: 'omitir' });
    expect(JSON.parse(p.recibidos[0].cuerpo).actor).toEqual({ usuario: 'jose', es_admin: true });
  });

  it('reenvía la Idempotency-Key y sin ella responde 422 sin llamar a la plataforma', async () => {
    const p = plataformaFalsa();
    const a = app({ user: operador, fetch: p.fetch });
    expect((await request(a).post(`/api/bandeja-identidad/casos/${ID}/decisiones`).send({ expected_version: 1, eleccion: 'omitir' })).status).toBe(422);
    expect(p.recibidos).toHaveLength(0);
    await request(a).post(`/api/bandeja-identidad/casos/${ID}/decisiones`).set('Idempotency-Key', 'mi-clave-99').send({ expected_version: 1, eleccion: 'omitir' });
    expect(p.recibidos[0].headers['idempotency-key']).toBe('mi-clave-99');
  });

  it('POST con JSON no canónico: la firma cubre los bytes exactos que se envían (verificada por el verificador real)', async () => {
    const p = plataformaFalsa();
    await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/decisiones`)
      .set('Idempotency-Key', 'clave-1234').send({ eleccion: 'vincular', motivo: 'ñandú "raro"  ', expected_version: 3, variant_id: ID });
    expect(p.recibidos[0].firmaValida).toBe(true);
  });

  it('confirmar (punto A) viaja al cuerpo cuando el cliente lo manda', async () => {
    const p = plataformaFalsa();
    await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/decisiones`)
      .set('Idempotency-Key', 'clave-1234').send({ expected_version: 1, eleccion: 'vincular', variant_id: ID, confirmar: true });
    expect(JSON.parse(p.recibidos[0].cuerpo).confirmar).toBe(true);
  });

  it('sin confirmar en el cuerpo del cliente, no se agrega solo', async () => {
    const p = plataformaFalsa();
    await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/decisiones`)
      .set('Idempotency-Key', 'clave-1234').send({ expected_version: 1, eleccion: 'omitir' });
    expect(JSON.parse(p.recibidos[0].cuerpo).confirmar).toBeUndefined();
  });

  it('GET con query: la ruta firmada es la enviada (ida y vuelta con caracteres especiales)', async () => {
    const p = plataformaFalsa();
    const a = app({ user: operador, fetch: p.fetch });
    await request(a).get('/api/bandeja-identidad/variantes').query({ q: 'casco ñandú 50% a_b' });
    await request(a).get('/api/bandeja-identidad/casos').query({ limit: '2', tipo: 'sku_pendiente', extra: 'no-pasa' });
    expect(p.recibidos.map((x) => x.firmaValida)).toEqual([true, true]);
    expect(decodeURIComponent(p.recibidos[0].ruta.split('q=')[1].replace(/\+/g, ' '))).toBe('casco ñandú 50% a_b');
    expect(p.recibidos[1].ruta).not.toContain('extra');
  });

  it('el filtro por grupo de los chips llega a la plataforma (y firmado)', async () => {
    const p = plataformaFalsa();
    await request(app({ user: operador, fetch: p.fetch })).get('/api/bandeja-identidad/casos').query({ grupo: '1', limit: '50' });
    expect(new URL(p.recibidos[0].ruta, 'http://x').searchParams.get('grupo')).toBe('1');
    expect(p.recibidos[0].firmaValida).toBe(true);
  });

  it('contra un Fastify real: la firma de un GET con query especial la acepta verificarInterna con el req.url que ve Fastify', async () => {
    const visto = [];
    const f = Fastify();
    f.get('/internal/v1/identidad/variantes', async (req) => {
      const v = verificarInterna({ keyring, origenes, direccion: '127.0.0.1', headers: req.headers, metodo: 'GET', path: req.url, cuerpo: Buffer.alloc(0), ahoraMs: Date.now() });
      visto.push({ ok: v.ok, q: req.query.q });
      return { variantes: [] };
    });
    await f.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${f.server.address().port}`;
      const r = await request(app({ user: operador, fetch: globalThis.fetch, url })).get('/api/bandeja-identidad/variantes').query({ q: 'casco ñandú 50% a_b' });
      expect(r.status).toBe(200);
      expect(visto).toEqual([{ ok: true, q: 'casco ñandú 50% a_b' }]);
    } finally { await f.close(); }
  });

  it('el detalle valida el id y firma el GET', async () => {
    const p = plataformaFalsa();
    const a = app({ user: operador, fetch: p.fetch });
    expect((await request(a).get('/api/bandeja-identidad/casos/no-es-uuid')).status).toBe(404);
    expect((await request(a).get(`/api/bandeja-identidad/casos/${ID}`)).status).toBe(200);
    expect(p.recibidos).toHaveLength(1);
    expect(p.recibidos[0]).toMatchObject({ metodo: 'GET', ruta: `/internal/v1/identidad/casos/${ID}`, firmaValida: true });
  });

  it('pasa tal cual el estado y el cuerpo de la plataforma (409 version_conflict)', async () => {
    const p = plataformaFalsa(409, { code: 'version_conflict', details: { version_actual: 4 } });
    const r = await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/decisiones`)
      .set('Idempotency-Key', 'clave-1234').send({ expected_version: 1, eleccion: 'omitir' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'version_conflict', details: { version_actual: 4 } });
  });

  it('plataforma caída o lenta: 502 plataforma_no_responde', async () => {
    const r = await request(app({ user: operador, fetch: async () => { throw new Error('ECONNREFUSED'); } })).get('/api/bandeja-identidad/casos');
    expect(r).toMatchObject({ status: 502, body: { code: 'plataforma_no_responde' } });
  });

  it('sin configuración: 503 bandeja_no_configurada', async () => {
    const r = await request(app({ user: operador, fetch: async () => ({}), url: null })).get('/api/bandeja-identidad/casos');
    expect(r).toMatchObject({ status: 503, body: { code: 'bandeja_no_configurada' } });
  });

  it('permisos: ver requiere matcher:read; decidir, matcher:write; sin matcher, 403', () => {
    const lectura = [{ herramienta: 'matcher', nivel: 'read' }];
    expect(permiteAcceso(lectura, resolvePermiso('GET', '/bandeja-identidad/casos'))).toBe(true);
    expect(permiteAcceso(lectura, resolvePermiso('POST', `/bandeja-identidad/casos/${ID}/decisiones`))).toBe(false);
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'write' }], resolvePermiso('POST', `/bandeja-identidad/casos/${ID}/decisiones`))).toBe(true);
    expect(permiteAcceso([{ herramienta: 'stock', nivel: 'write' }], resolvePermiso('GET', '/bandeja-identidad/casos'))).toBe(false);
  });

  it('apartar: POST reenvía expected_version, motivo y la Idempotency-Key, e inyecta actor desde la sesión', async () => {
    const p = plataformaFalsa(200, { version: 2 });
    const r = await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .set('Idempotency-Key', 'clave-apartar-1')
      .send({ expected_version: 1, motivo: 'no estoy seguro', actor: { usuario: 'jose', es_admin: true }, usuario: 'otro', es_admin: true });
    expect(r.status).toBe(200);
    expect(p.recibidos[0]).toMatchObject({ metodo: 'POST', ruta: `/internal/v1/identidad/casos/${ID}/apartar`, firmaValida: true });
    expect(p.recibidos[0].headers['idempotency-key']).toBe('clave-apartar-1');
    const enviado = JSON.parse(p.recibidos[0].cuerpo);
    expect(enviado).toMatchObject({ expected_version: 1, motivo: 'no estoy seguro', actor: { usuario: 'maria', es_admin: false } });
    expect(enviado).not.toHaveProperty('es_admin');
    expect(enviado).not.toHaveProperty('usuario');
  });

  it('apartar: sin Idempotency-Key responde 422 sin llamar a la plataforma', async () => {
    const p = plataformaFalsa();
    const r = await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .send({ expected_version: 1 });
    expect(r.status).toBe(422);
    expect(p.recibidos).toHaveLength(0);
  });

  it('apartar: valida el :id como UUID (404 si no lo es)', async () => {
    const p = plataformaFalsa();
    const r = await request(app({ user: operador, fetch: p.fetch })).post('/api/bandeja-identidad/casos/no-es-uuid/apartar')
      .set('Idempotency-Key', 'clave-1').send({ expected_version: 1 });
    expect(r.status).toBe(404);
    expect(p.recibidos).toHaveLength(0);
  });

  it('apartar: pasa tal cual el estado y el cuerpo de la plataforma (409 version_conflict)', async () => {
    const p = plataformaFalsa(409, { code: 'version_conflict' });
    const r = await request(app({ user: operador, fetch: p.fetch })).post(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .set('Idempotency-Key', 'clave-1').send({ expected_version: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'version_conflict' });
  });

  it('desapartar: el actor y es_admin del body del DELETE se ignoran (elevación)', async () => {
    const p = plataformaFalsa(200, { version: 3 });
    const r = await request(app({ user: operador, fetch: p.fetch })).delete(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .set('Idempotency-Key', 'clave-elevacion-1')
      .send({ expected_version: 2, es_admin: true, usuario: 'otro', actor: { usuario: 'jose', es_admin: true } });
    expect(r.status).toBe(200);
    const enviado = JSON.parse(p.recibidos[0].cuerpo);
    expect(enviado.actor).toEqual({ usuario: 'maria', es_admin: false });
    expect(enviado).not.toHaveProperty('es_admin');
    expect(enviado).not.toHaveProperty('usuario');
  });

  it('desapartar: DELETE reenvía expected_version, motivo y la Idempotency-Key, e inyecta actor desde la sesión', async () => {
    const p = plataformaFalsa(200, { version: 3 });
    const r = await request(app({ user: operador, fetch: p.fetch })).delete(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .set('Idempotency-Key', 'clave-desapartar-1')
      .send({ expected_version: 2, motivo: 'ya lo decidí', actor: { usuario: 'jose', es_admin: true } });
    expect(r.status).toBe(200);
    expect(p.recibidos[0]).toMatchObject({ metodo: 'DELETE', ruta: `/internal/v1/identidad/casos/${ID}/apartar`, firmaValida: true });
    expect(p.recibidos[0].headers['idempotency-key']).toBe('clave-desapartar-1');
    const enviado = JSON.parse(p.recibidos[0].cuerpo);
    expect(enviado).toMatchObject({ expected_version: 2, motivo: 'ya lo decidí', actor: { usuario: 'maria', es_admin: false } });
  });

  it('desapartar: sin Idempotency-Key responde 422 sin llamar a la plataforma', async () => {
    const p = plataformaFalsa();
    const r = await request(app({ user: operador, fetch: p.fetch })).delete(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .send({ expected_version: 1 });
    expect(r.status).toBe(422);
    expect(p.recibidos).toHaveLength(0);
  });

  it('desapartar: valida el :id como UUID (404 si no lo es)', async () => {
    const p = plataformaFalsa();
    const r = await request(app({ user: operador, fetch: p.fetch })).delete('/api/bandeja-identidad/casos/no-es-uuid/apartar')
      .set('Idempotency-Key', 'clave-1').send({ expected_version: 1 });
    expect(r.status).toBe(404);
    expect(p.recibidos).toHaveLength(0);
  });

  it('desapartar: pasa tal cual el estado y el cuerpo de la plataforma (409 no_apartado)', async () => {
    const p = plataformaFalsa(409, { code: 'no_apartado' });
    const r = await request(app({ user: operador, fetch: p.fetch })).delete(`/api/bandeja-identidad/casos/${ID}/apartar`)
      .set('Idempotency-Key', 'clave-1').send({ expected_version: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'no_apartado' });
  });

  it('permisos: apartar y desapartar requieren matcher:write; el auditor (sólo lectura) recibe 403 en los dos', () => {
    const soloLectura = auditor.permisos;
    expect(permiteAcceso(soloLectura, resolvePermiso('POST', `/bandeja-identidad/casos/${ID}/apartar`))).toBe(false);
    expect(permiteAcceso(soloLectura, resolvePermiso('DELETE', `/bandeja-identidad/casos/${ID}/apartar`))).toBe(false);
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'write' }], resolvePermiso('POST', `/bandeja-identidad/casos/${ID}/apartar`))).toBe(true);
    expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'write' }], resolvePermiso('DELETE', `/bandeja-identidad/casos/${ID}/apartar`))).toBe(true);
  });
});
