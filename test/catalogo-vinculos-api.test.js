import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';
import { resolvePermiso, permiteAcceso } from '../lib/permisos.js';
import { retenerPedidoMl } from '../lib/guardiaMl.js';

const FILE = './test/tmp-catalogo-vinculos-api.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';
const BASE = '/api/catalogo-vinculos';

describe('API de Catálogo y vínculos', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const app = (user) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use(BASE, catalogoVinculosRouter(db));
    a.use('/api/identidad-productos', identidadProductosRouter(db));
    return a;
  };
  const operador = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const lector = { username: 'leo', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };
  const admin = { username: 'jose', is_admin: true, permisos: [] };

  function caso(id, { titulo = 'Bicicleta Rodado 29 Talle M', stock = 2, nombre = 'Bicicleta Rodado 29 Talle M' } = {}) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`).run(id, nombre, `FB-${id}`, stock, ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
      VALUES (?,?,'',?,'active',NULL,0,2,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, titulo, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    return {
      f: db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`),
      p: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    };
  }

  describe('permisos en la tabla', () => {
    it('resuelve las rutas a matcher con el nivel del método', () => {
      expect(resolvePermiso('GET', '/catalogo-vinculos/cola')).toEqual({ anyOf: ['matcher'], nivel: 'read' });
      expect(resolvePermiso('POST', '/catalogo-vinculos/casos/3/decisiones')).toEqual({ anyOf: ['matcher'], nivel: 'write' });
      expect(resolvePermiso('POST', '/catalogo-vinculos/casos/3/notas')).toEqual({ anyOf: ['matcher'], nivel: 'read' });
      expect(permiteAcceso([{ herramienta: 'matcher', nivel: 'read' }], resolvePermiso('POST', '/catalogo-vinculos/casos/3/decisiones'))).toBe(false);
    });
  });

  describe('lecturas', () => {
    it('sin permiso de matcher: 403', async () => {
      const r = await request(app({ username: 'x', is_admin: false, permisos: [] })).get(`${BASE}/cola`);
      expect(r.status).toBe(403);
    });

    it('cola: ordena por plata en juego y por antigüedad, con chips', async () => {
      const a = caso(2001); const b = caso(2002);
      db.prepare("UPDATE identidad_casos SET primera_deteccion_en='2026-10-01T00:00:00Z' WHERE id=?").run(b.f.id);
      db.prepare("UPDATE ml_publicaciones_cache SET status='paused' WHERE clave='MLA2001|'").run();
      const r = await request(app(lector)).get(`${BASE}/cola`);
      expect(r.status).toBe(200);
      // misma plata (0): primero el más antiguo
      expect(r.body.data.map((f) => f.ml_key)).toEqual(['MLA2002|', 'MLA2001|']);
      expect(r.body.data[1].chips).toMatchObject({ pausada: true, hermanas: 0, intervencion: false });
      expect(r.body.data[0]).toMatchObject({ motivo: expect.any(String), plata: 0 });
      const p = await request(app(lector)).get(`${BASE}/cola?filtro=pausadas`);
      expect(p.body.data.map((f) => f.ml_key)).toEqual(['MLA2001|']);
      expect((await request(app(lector)).get(`${BASE}/cola?filtro=zzz`)).status).toBe(422);
      expect(a.f.id).toBeGreaterThan(0);
    });

    it('saltear manda el caso a "salteados" hasta que el caso cambie', async () => {
      const a = caso(2003);
      const r = await request(app(operador)).post(`${BASE}/casos/${a.f.id}/saltear`).send({ expected_version: a.f.expected_version });
      expect(r.status).toBe(200);
      expect((await request(app(operador)).get(`${BASE}/cola`)).body.data).toHaveLength(0);
      const s = await request(app(operador)).get(`${BASE}/cola?filtro=salteados`);
      expect(s.body.data).toMatchObject([{ ml_key: 'MLA2003|', salteado_por: 'ana' }]);
      db.prepare('UPDATE identidad_casos SET expected_version=expected_version+1 WHERE id=?').run(a.f.id);
      expect((await request(app(operador)).get(`${BASE}/cola`)).body.data).toHaveLength(1);
    });

    it('saltear es idempotente y rechaza casos cerrados', async () => {
      const a = caso(2006);
      const body = { expected_version: a.f.expected_version };
      expect((await request(app(operador)).post(`${BASE}/casos/${a.f.id}/saltear`).send(body)).body.repetido).toBeUndefined();
      const otra = await request(app(operador)).post(`${BASE}/casos/${a.f.id}/saltear`).send(body);
      expect(otra.status).toBe(200);
      expect(otra.body).toMatchObject({ repetido: true, salteado_por: 'ana' });
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='caso_salteado'").get().n).toBe(1);
      db.prepare("UPDATE identidad_casos SET estado='resuelto' WHERE id=?").run(a.f.id);
      const cerrado = await request(app(operador)).post(`${BASE}/casos/${a.f.id}/saltear`).send(body);
      expect(cerrado.status).toBe(409);
      expect(cerrado.body.code).toBe('INVALID_STATE');
    });

    it('cola: pagina con limit/offset y filtra con q antes de armar las filas', async () => {
      for (let i = 0; i < 5; i += 1) caso(2300 + i);
      db.prepare("UPDATE ml_publicaciones_cache SET titulo='Casco especial' WHERE clave='MLA2303|'").run();
      const pag = await request(app(lector)).get(`${BASE}/cola?limit=2&offset=1`);
      expect(pag.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
      expect(pag.body.data).toHaveLength(2);
      const q = await request(app(lector)).get(`${BASE}/cola?q=casco`);
      expect(q.body.data.map((f) => f.ml_key)).toEqual(['MLA2303|']);
      expect(q.body.total).toBe(1);
    });

    it('cola: cuenta hermanas activas del ítem sin contar la propia', async () => {
      caso(2310);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA2310|5','MLA2310','5','H','active',?),('MLA2310|6','MLA2310','6','H2','paused',?)`).run(ISO, ISO);
      const r = await request(app(lector)).get(`${BASE}/cola`);
      expect(r.body.data.find((f) => f.ml_key === 'MLA2310|').chips.hermanas).toBe(1);
    });

    it('saltear con versión vieja: 409', async () => {
      const a = caso(2004);
      const r = await request(app(operador)).post(`${BASE}/casos/${a.f.id}/saltear`).send({ expected_version: 99 });
      expect(r.status).toBe(409);
    });

    it('detalle: separa lo observado en ML de lo que manda la regla, y trae la matriz del candidato', async () => {
      const a = caso(2005);
      const r = await request(app(lector)).get(`${BASE}/casos/${a.f.id}?sku=FB-2005`);
      expect(r.status).toBe(200);
      expect(r.body.data.observado_ml).toMatchObject({ estado: 'active', cantidad: 2 });
      expect(r.body.data.regla).toMatchObject({ frena: expect.any(Boolean), motivo: expect.anything() === undefined ? null : expect.anything() });
      expect(r.body.data.matriz).toMatchObject({ veto: false, filas: expect.any(Array) });
      expect(r.body.data.marca).toBeNull();
      expect(r.body.data).toMatchObject({ vinculo_vigente: null, hermanas_item: [], notas: expect.any(Array) });
      db.prepare("INSERT INTO sku_matcher_decisiones(clave,sku,accion,actualizado_en) VALUES ('MLA2005|','FB-2005','confirmar',?)").run(ISO);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA2005|7','MLA2005','7','Hermana','active',?)`).run(ISO);
      const r2 = await request(app(lector)).get(`${BASE}/casos/${a.f.id}`);
      expect(r2.body.data.vinculo_vigente).toMatchObject({ sku: 'FB-2005', accion: 'confirmar' });
      expect(r2.body.data.hermanas_item).toMatchObject([{ clave: 'MLA2005|7', status: 'active' }]);
      expect((await request(app(lector)).get(`${BASE}/casos/9999`)).status).toBe(404);
    });

    it('estado: cada indicador de la salud vieja tiene su campo', async () => {
      const viejo = (await request(app(lector)).get('/api/identidad-productos/resumen')).body.data;
      const nuevo = (await request(app(lector)).get(`${BASE}/estado`)).body.data;
      expect(Object.keys(nuevo).sort()).toEqual(Object.keys(viejo).sort());
    });
  });

  describe('escrituras y permisos', () => {
    const cuerpo = (c, extra) => ({ tipo: 'vincular', product_id: c.p.id, operation_id: `op-${c.f.id}-${Object.keys(extra).join('')}`,
      expected_version: c.f.expected_version, evidence_fingerprint: c.f.evidencia_fingerprint, ...extra });

    it('vincular: el operador crea la decisión (201)', async () => {
      const c = caso(2101);
      const r = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`).send(cuerpo(c, {}));
      expect(r.status).toBe(201);
      expect(r.body.operacion).toMatchObject({ sku_objetivo: 'FB-2101' });
    });

    it('operación duplicada y sin cambio de SKU responden 409 con su código', async () => {
      const c = caso(2110);
      expect((await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`).send(cuerpo(c, {}))).status).toBe(201);
      const f = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(c.f.id);
      const dup = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`)
        .send({ ...cuerpo(c, {}), operation_id: 'otra', expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ code: 'OPERACION_DUPLICADA', operacion_id: expect.any(Number) });
      const s = caso(2111);
      db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-2111',seller_sku_presente=1 WHERE clave='MLA2111|'").run();
      const sin = await request(app(operador)).post(`${BASE}/casos/${s.f.id}/decisiones`).send(cuerpo(s, {}));
      expect(sin.status).toBe(409);
      expect(sin.body.code).toBe('SIN_CAMBIO_SKU');
    });

    it('un lector (matcher:read) no puede decidir', async () => {
      const c = caso(2102);
      expect((await request(app(lector)).post(`${BASE}/casos/${c.f.id}/decisiones`).send(cuerpo(c, {}))).status).toBe(403);
    });

    it('confirmar igual y override_omitir: 403 para el operador, ok para el admin', async () => {
      const c = caso(2103, { titulo: 'Bicicleta Rodado 27 Talle M' });
      for (const extra of [{ override_contradiccion: true, motivo: 'm' }, { override_omitir: true }]) {
        expect((await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`).send(cuerpo(c, extra))).status).toBe(403);
      }
      const ok = await request(app(admin)).post(`${BASE}/casos/${c.f.id}/decisiones`).send(cuerpo(c, { override_contradiccion: true, motivo: 'Título mal escrito' }));
      expect(ok.status).toBe(201);
    });

    it('no sincronizar (a): el operador lo hace y el detalle muestra la marca', async () => {
      const c = caso(2104);
      const r = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`)
        .send({ variante: 'a', motivo: 'Duplicada', expected_sku: null });
      expect(r.status).toBe(201);
      const d = await request(app(lector)).get(`${BASE}/casos/${c.f.id}`);
      expect(d.body.data.marca).toMatchObject({ tipo: 'no_sincronizar', variante: 'a', por: 'ana' });
    });

    it('no sincronizar (b): exige operation_id y confirmar impacto de hermanas', async () => {
      const c = caso(2105);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA2105|9','MLA2105','9','Hermana','active',?)`).run(ISO);
      const sin = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`).send({ variante: 'b', motivo: 'm', expected_sku: null });
      expect(sin.status).toBe(422);
      const conf = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`)
        .send({ variante: 'b', motivo: 'm', expected_sku: null, operation_id: 'nsb-1' });
      expect(conf.status).toBe(409);
      expect(conf.body).toMatchObject({ code: 'SIBLING_IMPACT_CONFIRMATION_REQUIRED', sibling_count: 1 });
      const ok = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`)
        .send({ variante: 'b', motivo: 'm', expected_sku: null, operation_id: 'nsb-1', confirm_sibling_impact: true });
      expect(ok.status).toBe(201);
      const ej = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(ej.body.data.pausas).toMatchObject([{ ml_key: 'MLA2105|', estado: 'shadow' }]);
    });

    it('link de pago: solo admin (403 al operador)', async () => {
      caso(2106);
      const body = { clave: 'MLA2106|', motivo: 'Link de pago', expected_sku: null };
      expect((await request(app(operador)).post(`${BASE}/claves/link-de-pago`).send(body)).status).toBe(403);
      expect((await request(app(admin)).post(`${BASE}/claves/link-de-pago`).send(body)).status).toBe(201);
    });

    it('deshacer la variante (c): 403 para el operador, ok para el admin; (a) lo deshace cualquiera', async () => {
      const a = caso(2107); const c = caso(2108);
      await request(app(operador)).post(`${BASE}/casos/${a.f.id}/no-sincronizar`).send({ variante: 'a', motivo: 'm', expected_sku: null });
      await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`).send({ variante: 'c', motivo: 'm', expected_sku: null });
      const des = (u, clave) => request(app(u)).post(`${BASE}/claves/no-sincronizar/deshacer`).send({ clave, motivo: 'error' });
      expect((await des(operador, 'MLA2107|')).status).toBe(200);
      expect((await des(operador, 'MLA2108|')).status).toBe(403);
      expect((await des(admin, 'MLA2108|')).status).toBe(200);
    });

    it('reintentar, confirmar impacto y destrabar: 403 para el operador', async () => {
      for (const ruta of ['reintentar', 'confirmar-impacto', 'destrabar']) {
        expect((await request(app(operador)).post(`${BASE}/operaciones/1/${ruta}`).send({})).status).toBe(403);
        expect((await request(app(admin)).post(`${BASE}/operaciones/999/${ruta}`).send({ operation_id: 'x' })).status).toBe(404);
      }
    });
  });

  describe('retenidas', () => {
    function retener(orderId, clave) {
      const [item, variacion] = clave.split('|');
      const items = [{ item: { id: item, variation_id: variacion || null, seller_sku: null, title: 'X' }, quantity: 1 }];
      db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run(orderId, ISO);
      db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run(orderId, ISO, ISO);
      retenerPedidoMl(db, { orderId, items, claves: [clave] });
    }

    it('lista las retenidas y avisa si la causa sigue; liberar pide motivo y permiso', async () => {
      caso(2201);
      retener('ORD-R1', 'MLA2201|');
      const l = await request(app(lector)).get(`${BASE}/retenidas`);
      expect(l.body.data).toMatchObject([{ ml_order_id: 'ORD-R1', se_vuelve_a_retener: true }]);
      expect((await request(app(lector)).post(`${BASE}/retenidas/ORD-R1/liberar`).send({ motivo: 'x' })).status).toBe(403);
      expect((await request(app(operador)).post(`${BASE}/retenidas/ORD-R1/liberar`).send({})).status).toBe(422);
      expect((await request(app(operador)).post(`${BASE}/retenidas/ORD-R1/liberar`).send({ motivo: 'Cliente avisó' })).status).toBe(200);
      expect((await request(app(operador)).post(`${BASE}/retenidas/ORD-R1/liberar`).send({ motivo: 'otra vez' })).status).toBe(404);
    });

    it('una venta de "no sincronizar" avisa que se vuelve a retener', async () => {
      const c = caso(2202);
      await request(app(operador)).post(`${BASE}/casos/${c.f.id}/no-sincronizar`).send({ variante: 'a', motivo: 'm', expected_sku: null });
      retener('ORD-R2', 'MLA2202|');
      const l = await request(app(lector)).get(`${BASE}/retenidas`);
      expect(l.body.data[0].se_vuelve_a_retener).toBe(true);
    });
  });
});
