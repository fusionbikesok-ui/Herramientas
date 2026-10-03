import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import { crearPlataformaStub } from '../scripts/qa/plataforma-stub.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { firmarInterno, cargarKeyringInternoActivo, cargarKeyringInterno } from '../lib/internoHmac.js';
import { bandejaIdentidadRouter } from '../routes/bandejaIdentidad.js';

const CLAVE = crypto.randomBytes(32);
const KEYRING = { activeKeyId: 'qa-1', keys: { 'qa-1': CLAVE } };
const UUID_CASO = '00000000-0000-4000-8000-000000000001';

function escuchar(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}

async function firmado(base, metodo, ruta, cuerpo, { clave = CLAVE, headers = {}, ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(18).toString('base64url') } = {}) {
  const buf = cuerpo === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(cuerpo));
  const path = metodo === 'GET' ? ruta : ruta.split('?')[0];
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: {
      ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
      'x-fusion-key-id': 'qa-1', 'x-fusion-timestamp': String(ts), 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmarInterno(clave, String(ts), nonce, metodo, path, buf), ...headers,
    },
    ...(cuerpo === undefined ? {} : { body: buf }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('plataforma-stub (QA)', () => {
  let stub; let base;
  beforeAll(async () => {
    stub = crearPlataformaStub({ claves: KEYRING.keys });
    base = await escuchar(stub.servidor);
  });
  afterAll(() => new Promise((r) => stub.servidor.close(r)));

  describe('autenticación HMAC real', () => {
    it('rechaza sin firma, con firma mala, clave equivocada, ventana vencida y nonce repetido', async () => {
      expect((await fetch(`${base}/internal/v1/identidad/casos`)).status).toBe(401);
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos', undefined, { clave: crypto.randomBytes(32) })).status).toBe(401);
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos', undefined, { ts: Math.floor(Date.now() / 1000) - 400 })).status).toBe(401);
      const nonce = crypto.randomBytes(18).toString('base64url');
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos', undefined, { nonce })).status).toBe(200);
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos', undefined, { nonce })).status).toBe(401);
    });
    it('los GET firman la query: cambiarla invalida la firma', async () => {
      const ts = Math.floor(Date.now() / 1000); const nonce = crypto.randomBytes(18).toString('base64url');
      const firma = firmarInterno(CLAVE, String(ts), nonce, 'GET', '/internal/v1/identidad/casos?grupo=1', Buffer.alloc(0));
      const res = await fetch(`${base}/internal/v1/identidad/casos?grupo=3`, { headers: { 'x-fusion-key-id': 'qa-1', 'x-fusion-timestamp': String(ts), 'x-fusion-nonce': nonce, 'x-fusion-signature': firma } });
      expect(res.status).toBe(401);
    });
  });

  describe('cola y detalle', () => {
    it('cola: contadores, orden por grupo y forma exacta de cada caso', async () => {
      const r = await firmado(base, 'GET', '/internal/v1/identidad/casos');
      expect(r.status).toBe(200);
      expect(r.body.casos.map((c) => c.grupo)).toEqual([1, 3, 3, 3, 4, 5, 6]);
      expect(r.body.contadores).toEqual({ conflictos: 0, d5: 1, sku_exacto: 0, activas_con_stock: 3, resto: 1, confirmable: 1, sin_titulo: 1, apartados: 0, no_decidibles: 0 });
      expect(r.body.siguiente).toBeNull();
      expect(r.body.casos[0]).toMatchObject({ d5: true, apartado: false, confirmar: null,
        publicacion: expect.objectContaining({ recurso: 'MLA1000002', link_ml: 'https://articulo.mercadolibre.com.ar/MLA-1000002' }) });
      const confirmable = r.body.casos.find((c) => c.grupo === 5);
      expect(confirmable.confirmar).toEqual({ variant_id: expect.any(String), sku: 'FB-3001' });
    });
    it('un caso trae publicacion.posible_duplicado en el detalle', async () => {
      const r = await firmado(base, 'GET', '/internal/v1/identidad/casos/00000000-0000-4000-8000-000000000007');
      expect(r.status).toBe(200);
      expect(r.body.publicacion.posible_duplicado).toEqual({ recurso: 'MLA1000002', sku: 'FB-2001' });
    });
    it('pagina por cursor sin repetir ni saltear casos', async () => {
      const p1 = await firmado(base, 'GET', '/internal/v1/identidad/casos?limit=2');
      expect(p1.body.casos).toHaveLength(2);
      expect(p1.body.siguiente).toBeTruthy();
      const p2 = await firmado(base, 'GET', `/internal/v1/identidad/casos?limit=10&cursor=${p1.body.siguiente}`);
      expect(p2.body.casos).toHaveLength(5);
      const ids = [...p1.body.casos, ...p2.body.casos].map((c) => c.id);
      expect(new Set(ids).size).toBe(7);
    });
    it('valida la query y el cursor', async () => {
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos?limit=0')).body.code).toBe('invalid_query');
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos?x=1')).body.code).toBe('invalid_query');
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos?cursor=basura')).body.code).toBe('invalid_cursor');
    });
    it('detalle: caso normal con candidatos y explicación; sin atributos ML; con foto', async () => {
      const normal = await firmado(base, 'GET', `/internal/v1/identidad/casos/${UUID_CASO}`);
      expect(normal.status).toBe(200);
      expect(normal.body.candidatos).toHaveLength(3);
      expect(normal.body.candidatos[0].explicacion).toEqual({ atributos: expect.any(Array), otros_atributos: expect.any(Array) });
      expect(normal.body.publicacion.atributos).toMatchObject({ color: 'Negro' });
      const sinAtr = await firmado(base, 'GET', '/internal/v1/identidad/casos/00000000-0000-4000-8000-000000000003');
      expect(sinAtr.body.publicacion.atributos).toEqual({});
      expect(sinAtr.body.candidatos[0].explicacion.atributos.every((a) => a.marca === 'falta')).toBe(true);
      const foto = await firmado(base, 'GET', '/internal/v1/identidad/casos/00000000-0000-4000-8000-000000000004');
      expect(foto.body.publicacion.foto).toMatch(/^data:image\/svg\+xml/);
    });
    it('detalle: 404 con id inválido o inexistente', async () => {
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos/no-es-uuid')).body.code).toBe('caso_inexistente');
      expect((await firmado(base, 'GET', '/internal/v1/identidad/casos/00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    });
    it('busca variantes por SKU exacto (primero) o título, con explicación si viene caso_id', async () => {
      const r = await firmado(base, 'GET', '/internal/v1/identidad/variantes?q=fb-1001');
      expect(r.body.variantes[0]).toMatchObject({ sku: 'FB-1001' });
      expect(r.body.variantes[0].explicacion).toBeUndefined();
      const t = await firmado(base, 'GET', `/internal/v1/identidad/variantes?q=casco&caso_id=${UUID_CASO}`);
      expect(t.body.variantes.length).toBeGreaterThanOrEqual(3);
      expect(t.body.variantes[0].explicacion).toEqual({ atributos: [], otros_atributos: expect.any(Array) });
      expect((await firmado(base, 'GET', '/internal/v1/identidad/variantes?q=')).body.code).toBe('invalid_query');
    });
  });

  describe('decidir y apartar (estado en memoria, idempotentes)', () => {
    const decision = (extra = {}) => ({ expected_version: 1, eleccion: 'vincular', variant_id: '00000000-0000-4000-8000-000000000201', actor: { usuario: 'ana', es_admin: false }, ...extra });
    const H = (k) => ({ 'idempotency-key': k });

    it('exige Idempotency-Key, cuerpo válido y expected_version vigente', async () => {
      stub.reiniciar();
      const ruta = `/internal/v1/identidad/casos/${UUID_CASO}/decisiones`;
      expect((await firmado(base, 'POST', ruta, decision())).body.code).toBe('idempotency_key_requerida');
      expect((await firmado(base, 'POST', ruta, { ...decision(), extra: 1 }, { headers: H('clave-12345') })).body.code).toBe('invalid_body');
      expect((await firmado(base, 'POST', ruta, decision({ expected_version: 7 }), { headers: H('clave-v7-aa') })).body.code).toBe('version_conflict');
      expect((await firmado(base, 'POST', ruta, decision({ variant_id: '00000000-0000-4000-8000-0000000009ff' }), { headers: H('clave-var-aa') })).body.code).toBe('variante_invalida');
    });
    it('vincular cierra el caso y lo saca de la cola; repetir la misma clave devuelve lo mismo; otra clave sobre caso cerrado da 409', async () => {
      stub.reiniciar();
      const ruta = `/internal/v1/identidad/casos/${UUID_CASO}/decisiones`;
      const a = await firmado(base, 'POST', ruta, decision(), { headers: H('clave-ok-0001') });
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ decision_id: expect.any(String), version: 2, vinculo: 'vinculada' });
      const b = await firmado(base, 'POST', ruta, decision(), { headers: H('clave-ok-0001') });
      expect(b.body).toEqual(a.body);
      expect((await firmado(base, 'POST', ruta, decision({ motivo: 'otro' }), { headers: H('clave-ok-0001') })).body.code).toBe('idempotency_mismatch');
      expect((await firmado(base, 'POST', ruta, decision({ expected_version: 2 }), { headers: H('clave-ok-0002') })).body.code).toBe('caso_cerrado');
      const cola = await firmado(base, 'GET', '/internal/v1/identidad/casos');
      expect(cola.body.casos.find((c) => c.id === UUID_CASO)).toBeUndefined();
      const det = await firmado(base, 'GET', `/internal/v1/identidad/casos/${UUID_CASO}`);
      expect(det.body.estado).toBe('closed');
      expect(det.body.historial[0]).toMatchObject({ eleccion: 'vincular', sku: 'FB-1001', actor: 'ana' });
    });
    it('confirmar sólo vale sobre la variante ya vinculada del caso confirmable', async () => {
      stub.reiniciar();
      const ruta = '/internal/v1/identidad/casos/00000000-0000-4000-8000-000000000005/decisiones';
      const mala = await firmado(base, 'POST', ruta, decision({ confirmar: true }), { headers: H('clave-conf-01') });
      expect(mala.body.code).toBe('confirmar_invalido');
      const buena = await firmado(base, 'POST', ruta, decision({ confirmar: true, variant_id: '00000000-0000-4000-8000-000000000206' }), { headers: H('clave-conf-02') });
      expect(buena.status).toBe(200);
    });
    it('omitir devuelve vinculo omitida', async () => {
      stub.reiniciar();
      const r = await firmado(base, 'POST', `/internal/v1/identidad/casos/${UUID_CASO}/decisiones`, { expected_version: 1, eleccion: 'omitir', actor: { usuario: 'ana', es_admin: true } }, { headers: H('clave-omi-01') });
      expect(r.body.vinculo).toBe('omitida');
    });
    it('apartar mueve el caso al grupo 7 y desapartar lo devuelve; desapartar sin apartar da 409', async () => {
      stub.reiniciar();
      const ruta = `/internal/v1/identidad/casos/${UUID_CASO}/apartar`;
      const cuerpo = (v) => ({ expected_version: v, actor: { usuario: 'ana', es_admin: false } });
      expect((await firmado(base, 'DELETE', ruta, cuerpo(1), { headers: H('clave-des-01') })).body.code).toBe('no_apartado');
      const a = await firmado(base, 'POST', ruta, cuerpo(1), { headers: H('clave-apa-01') });
      expect(a.body).toEqual({ version: 2 });
      let cola = await firmado(base, 'GET', '/internal/v1/identidad/casos');
      expect(cola.body.contadores.apartados).toBe(1);
      expect(cola.body.casos.at(-1)).toMatchObject({ id: UUID_CASO, grupo: 7, apartado: true });
      expect((await firmado(base, 'DELETE', ruta, cuerpo(2), { headers: H('clave-des-02') })).body).toEqual({ version: 3 });
      cola = await firmado(base, 'GET', '/internal/v1/identidad/casos');
      expect(cola.body.contadores.apartados).toBe(0);
    });
  });

  it('rutas desconocidas dan 404', async () => {
    expect((await firmado(base, 'GET', '/internal/v1/identidad/nada')).status).toBe(404);
  });

  describe('de punta a punta con el proxy real del legado (routes/bandejaIdentidad.js)', () => {
    let app; let servidorApp; let urlApp;
    beforeAll(async () => {
      stub.reiniciar();
      app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { username: 'ana', is_admin: false }; next(); });
      app.use('/api/bandeja-identidad', bandejaIdentidadRouter({ url: base, keyring: KEYRING }));
      servidorApp = app.listen(0, '127.0.0.1');
      await new Promise((r) => servidorApp.on('listening', r));
      urlApp = `http://127.0.0.1:${servidorApp.address().port}`;
    });
    afterAll(() => new Promise((r) => servidorApp.close(r)));

    it('GET /casos ya no da 503: el proxy firma y el stub verifica', async () => {
      const r = await fetch(`${urlApp}/api/bandeja-identidad/casos`);
      expect(r.status).toBe(200);
      expect((await r.json()).casos).toHaveLength(7);
    });
    it('detalle, variantes y decidir pasan por el proxy; el actor sale de la sesión', async () => {
      const det = await fetch(`${urlApp}/api/bandeja-identidad/casos/${UUID_CASO}`);
      expect((await det.json()).candidatos).toHaveLength(3);
      const v = await fetch(`${urlApp}/api/bandeja-identidad/variantes?q=casco`);
      expect((await v.json()).variantes.length).toBeGreaterThan(0);
      const d = await fetch(`${urlApp}/api/bandeja-identidad/casos/${UUID_CASO}/decisiones`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'clave-proxy-01' },
        body: JSON.stringify({ expected_version: 1, eleccion: 'vincular', variant_id: '00000000-0000-4000-8000-000000000201', actor: { usuario: 'intruso', es_admin: true } }),
      });
      expect(d.status).toBe(200);
      const det2 = await (await fetch(`${urlApp}/api/bandeja-identidad/casos/${UUID_CASO}`)).json();
      expect(det2.historial[0].actor).toBe('ana');
    });
    it('con keyring distinto el proxy recibe 401 de la plataforma', async () => {
      const otro = express();
      otro.use((req, _res, next) => { req.user = { username: 'ana', is_admin: false }; next(); });
      otro.use('/api/bandeja-identidad', bandejaIdentidadRouter({ url: base, keyring: { activeKeyId: 'qa-1', keys: { 'qa-1': crypto.randomBytes(32) } } }));
      const s = otro.listen(0, '127.0.0.1'); await new Promise((r) => s.on('listening', r));
      const r = await fetch(`http://127.0.0.1:${s.address().port}/api/bandeja-identidad/casos`);
      expect(r.status).toBe(401);
      await new Promise((res) => s.close(res));
    });
  });
});

describe('keyring de QA generado como lo hace qa.sh', () => {
  it('el formato (printf + openssl rand -base64 32, modo 600) lo aceptan el emisor y el verificador', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-keyring-'));
    try {
      const f = path.join(dir, 'keyring.json');
      const clave = execFileSync('openssl', ['rand', '-base64', '32']).toString().trim();
      fs.writeFileSync(f, `{"activeKeyId":"qa-1","keys":{"qa-1":"${clave}"}}\n`, { mode: 0o600 });
      expect(cargarKeyringInternoActivo(f).activeKeyId).toBe('qa-1');
      expect(cargarKeyringInterno(f)['qa-1']).toHaveLength(32);
      fs.chmodSync(f, 0o644);
      expect(() => cargarKeyringInterno(f)).toThrow(/legible por grupo/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
