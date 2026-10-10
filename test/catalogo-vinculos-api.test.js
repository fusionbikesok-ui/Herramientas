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
import { parametrosEjecucion } from '../lib/catalogoVinculos.js';

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

    it('cada retenida trae titulo (de la publicación) e importe (suma de unit_price × cantidad)', async () => {
      caso(2203);
      const items = [
        { item: { id: 'MLA2203', variation_id: null, seller_sku: null, title: 'Título del pedido' }, quantity: 2, unit_price: 100.5 },
        { item: { id: 'MLA2203', variation_id: null, seller_sku: null, title: 'Título del pedido' }, quantity: 1, unit_price: 50 },
      ];
      db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run('ORD-P1', ISO);
      db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run('ORD-P1', ISO, ISO);
      retenerPedidoMl(db, { orderId: 'ORD-P1', items, claves: ['MLA2203|'] });
      const l = await request(app(lector)).get(`${BASE}/retenidas`);
      expect(l.body.data[0]).toMatchObject({ ml_order_id: 'ORD-P1', titulo: 'Bicicleta Rodado 29 Talle M', importe: 251 });
    });

    it('sin precio en los ítems, importe null; sin publicación en cache, titulo cae al del pedido; nunca rompe', async () => {
      const sinPrecio = [{ item: { id: 'MLA9901', variation_id: null, seller_sku: null, title: 'Del pedido' }, quantity: 1 }];
      db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run('ORD-P2', ISO);
      db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run('ORD-P2', ISO, ISO);
      retenerPedidoMl(db, { orderId: 'ORD-P2', items: sinPrecio, claves: ['MLA9901|'] });
      db.prepare(`INSERT INTO guardia_ml_pedidos_retenidos (ml_order_id,motivo,items_json,creado_en,actualizado_en)
        VALUES ('ORD-P3','sin_cobertura','no es json',?,?)`).run(ISO, ISO);
      const l = await request(app(lector)).get(`${BASE}/retenidas`);
      expect(l.status).toBe(200);
      const byId = Object.fromEntries(l.body.data.map((f) => [f.ml_order_id, f]));
      expect(byId['ORD-P2']).toMatchObject({ titulo: 'Del pedido', importe: null });
      expect(byId['ORD-P3']).toMatchObject({ titulo: null, importe: null, claves: [] });
    });
  });

  describe('publicaciones de un producto', () => {
    it('404 si el producto no existe', async () => {
      const r = await request(app(lector)).get(`${BASE}/productos/99999/publicaciones`);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('producto sin vínculo: data vacío', async () => {
      const c = caso(2301);
      const r = await request(app(lector)).get(`${BASE}/productos/${c.p.id}/publicaciones`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, data: [] });
    });

    it('lista las publicaciones con asignar/confirmar del SKU Woo del producto; ignora omitir', async () => {
      const c = caso(2302);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA2302|7','MLA2302','7','Variación 7','paused',?)`).run(ISO);
      db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA2302|','FB-2302','asignar',?)").run(ISO);
      db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA2302|7','FB-2302','omitir',?)").run(ISO);
      const r = await request(app(lector)).get(`${BASE}/productos/${c.p.id}/publicaciones`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, data: [{ clave: 'MLA2302|', titulo: 'Bicicleta Rodado 29 Talle M', status: 'active' }] });
    });
  });

  describe('ejecución: canceladas no cuentan como fallidas', () => {
    // identidad_operaciones no tiene estado 'cancelada' (CHECK de 082/091): Fase B la guarda como 'fallida' con
    // ultimo_error 'cancelada: …'. La API la reconoce por ese marcador y la expone como estado 'cancelada'.
    function opConEstado(id, { sku_anterior, sku_objetivo, estado, ultimo_error }) {
      const c = caso(id);
      return request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`)
        .send({ tipo: 'vincular', product_id: c.p.id, operation_id: `op-${id}`, expected_version: c.f.expected_version, evidence_fingerprint: c.f.evidencia_fingerprint })
        .then(() => db.prepare('UPDATE identidad_operaciones SET sku_anterior=?, sku_objetivo=?, estado=?, ultimo_error=? WHERE operation_id=?')
          .run(sku_anterior, sku_objetivo, estado, ultimo_error, `op-${id}`));
    }

    it('una cancelada (no-op) y una fallida real: fallidas=1, canceladas=1, estado y motivo por operación', async () => {
      await opConEstado(2501, { sku_anterior: 'FB-2501', sku_objetivo: 'FB-2501', estado: 'fallida', ultimo_error: 'cancelada: sku_anterior == sku_objetivo (no-op de SKU)' });
      await opConEstado(2502, { sku_anterior: 'VIEJO', sku_objetivo: 'FB-2502', estado: 'fallida', ultimo_error: 'ML rechazó el SKU' });
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.status).toBe(200);
      expect(r.body.data.fallidas).toBe(1);
      expect(r.body.data.canceladas_total).toBe(1);
      const noop = r.body.data.canceladas.items.find((o) => o.ml_key === 'MLA2501|');
      expect(noop).toMatchObject({ estado: 'cancelada', estado_db: 'fallida', motivo_cancelacion: 'sin_cambio_sku' });
      expect(r.body.data.operaciones.find((o) => o.ml_key === 'MLA2501|')).toBeUndefined();
      const real = r.body.data.operaciones.find((o) => o.ml_key === 'MLA2502|');
      expect(real).toMatchObject({ estado: 'fallida', estado_db: 'fallida', motivo_cancelacion: null });
    });

    it('cancelación explícita (sku distinto): motivo_cancelacion es el texto tras el prefijo', async () => {
      await opConEstado(2503, { sku_anterior: 'A', sku_objetivo: 'B', estado: 'fallida', ultimo_error: 'cancelada: duplicada de otra clave' });
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.body.data.fallidas).toBe(0);
      expect(r.body.data.canceladas_total).toBe(1);
      expect(r.body.data.operaciones).toEqual([]);
      expect(r.body.data.canceladas.items[0]).toMatchObject({ estado: 'cancelada', motivo_cancelacion: 'duplicada de otra clave' });
    });

    it('pausas: fallida cuenta en fallidas; cancelada cuenta en canceladas', async () => {
      db.prepare(`INSERT INTO identidad_pausas (operation_id,ml_key,item_id,motivo,estado,creada_por,creada_en,actualizada_en)
        VALUES ('p-f','MLA9001|','MLA9001','m','fallida','ana',?,?), ('p-c','MLA9002|','MLA9002','m','cancelada','ana',?,?)`).run(ISO, ISO, ISO, ISO);
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.body.data.fallidas).toBe(1);
      expect(r.body.data.canceladas_total).toBe(1);
    });

    it('estado de salud: operaciones_pendientes excluye canceladas', async () => {
      await opConEstado(2504, { sku_anterior: 'FB-2504', sku_objetivo: 'FB-2504', estado: 'fallida', ultimo_error: 'cancelada: sku_anterior == sku_objetivo (no-op de SKU)' });
      const r = await request(app(lector)).get(`${BASE}/estado`);
      expect(r.body.data.salud.operaciones_pendientes).toBe(0);
      expect(r.body.data.salud.operaciones_canceladas).toBe(1);
    });
  });

  describe('ejecución: variaciones de las operaciones con impacto en hermanas', () => {
    it('sin operaciones: listas vacías y contadores en cero', async () => {
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ operaciones: [], pausas: [], fallidas: 0, pausas_con_riesgo: 0 });
    });

    it('operación sin hermanas: variaciones [] y impacto_hermanas numérico 0', async () => {
      const c = caso(2401);
      await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`)
        .send({ tipo: 'vincular', product_id: c.p.id, operation_id: 'op-2401', expected_version: c.f.expected_version, evidence_fingerprint: c.f.evidencia_fingerprint });
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.body.data.operaciones).toMatchObject([{ ml_key: 'MLA2401|', impacto_hermanas: 0, variaciones: [] }]);
    });

    it('operación con hermanas: variaciones [{clave,titulo,status}] e impacto_hermanas sigue numérico', async () => {
      const c = caso(2402);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA2402|9','MLA2402','9','Hermana 9','active',?)`).run(ISO);
      const dec = await request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`)
        .send({ tipo: 'vincular', product_id: c.p.id, operation_id: 'op-2402', expected_version: c.f.expected_version, evidence_fingerprint: c.f.evidencia_fingerprint, confirm_sibling_impact: true });
      expect(dec.status).toBe(201);
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      const op = r.body.data.operaciones.find((o) => o.ml_key === 'MLA2402|');
      expect(op.impacto_hermanas).toBe(1);
      expect(typeof op.impacto_hermanas).toBe('number');
      expect(op.variaciones).toEqual([{ clave: 'MLA2402|9', titulo: 'Hermana 9', status: 'active' }]);
    });
  });

  describe('ejecución: secciones separadas, paginación y búsqueda', () => {
    // Operación base por la API (queda 'intervencion'), y clones directos en la tabla con mismo caso/decisión.
    function sembrarOperaciones() {
      const c = caso(9000);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
        VALUES ('MLA8888|','MLA8888','','Rodado Especial','active',?)`).run(ISO);
      return request(app(operador)).post(`${BASE}/casos/${c.f.id}/decisiones`)
        .send({ tipo: 'vincular', product_id: c.p.id, operation_id: 'base', expected_version: c.f.expected_version, evidence_fingerprint: c.f.evidencia_fingerprint })
        .then(() => {
          db.prepare("UPDATE identidad_operaciones SET estado='intervencion', ultimo_error='revisar', sku_objetivo='FB-9000', ml_key='MLA8888|' WHERE operation_id='base'").run();
          const clonar = db.prepare(`INSERT INTO identidad_operaciones (operation_id,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,
            stock_objetivo,estado,ultimo_error,iniciada_en,actualizada_en,completada_en)
            SELECT ?,caso_id,decision_id,producto_id,?,?,?,stock_objetivo,?,?,?,?,? FROM identidad_operaciones WHERE operation_id='base'`);
          const minuto = (i) => new Date(Date.parse(ISO) + i * 60000).toISOString();
          for (let i = 0; i < 60; i++) {
            const sku = i === 5 ? 'ZZ-UNICO' : 'FB-C';
            clonar.run(`c-${i}`, `MLA5${i}|`, 'FB-C', sku, 'completada', null, ISO, minuto(i), minuto(i));
          }
          for (let i = 0; i < 3; i++) clonar.run(`x-${i}`, `MLA7${i}|`, 'FB-X', 'FB-X', 'fallida', `cancelada: motivo ${i}`, ISO, minuto(i), null);
          clonar.run('f-real', 'MLA8000|', 'A', 'B', 'fallida', 'ML rechazó', ISO, minuto(100), null);
        });
    }

    it('operaciones = solo accionables; completadas y canceladas aparte con total real', async () => {
      await sembrarOperaciones();
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.status).toBe(200);
      const estados = r.body.data.operaciones.map((o) => o.estado).sort();
      expect(estados).toEqual(['fallida', 'intervencion']);
      expect(r.body.data.completadas.total).toBe(60);
      expect(r.body.data.completadas.items).toHaveLength(50);
      expect(r.body.data.canceladas.total).toBe(3);
      expect(r.body.data.canceladas.items).toHaveLength(3);
      expect(r.body.data.canceladas.items[0]).toMatchObject({ estado: 'cancelada', estado_db: 'fallida' });
      expect(r.body.data.canceladas_total).toBe(3);
      expect(r.body.data.fallidas).toBe(1);
    });

    it('completadas_offset=50 devuelve las 10 restantes; total sigue en 60', async () => {
      await sembrarOperaciones();
      const r = await request(app(lector)).get(`${BASE}/ejecucion?completadas_offset=50`);
      expect(r.body.data.completadas.total).toBe(60);
      expect(r.body.data.completadas.items).toHaveLength(10);
      expect(r.body.data.completadas.items[0].ml_key).toBe('MLA59|');
    });

    it('orden reciente primero (actualizada_en desc) en completadas y canceladas', async () => {
      await sembrarOperaciones();
      const r = await request(app(lector)).get(`${BASE}/ejecucion`);
      expect(r.body.data.completadas.items[0].ml_key).toBe('MLA559|');
      expect(r.body.data.completadas.items[1].ml_key).toBe('MLA558|');
      expect(r.body.data.completadas.items[49].ml_key).toBe('MLA510|');
      expect(r.body.data.canceladas.items.map((o) => o.ml_key)).toEqual(['MLA72|', 'MLA71|', 'MLA70|']);
    });

    it('canceladas_offset y limite=5 paginan la sección canceladas', async () => {
      await sembrarOperaciones();
      const r = await request(app(lector)).get(`${BASE}/ejecucion?limite=2&canceladas_offset=2`);
      expect(r.body.data.canceladas.total).toBe(3);
      expect(r.body.data.canceladas.items.map((o) => o.ml_key)).toEqual(['MLA70|']);
      expect(r.body.data.completadas.items).toHaveLength(2);
    });

    it('q filtra por SKU, clave/MLA y título en todas las secciones (case-insensitive)', async () => {
      await sembrarOperaciones();
      const sku = await request(app(lector)).get(`${BASE}/ejecucion?q=zz-unico`);
      expect(sku.body.data.completadas).toMatchObject({ total: 1 });
      expect(sku.body.data.completadas.items[0].ml_key).toBe('MLA55|');
      expect(sku.body.data.canceladas.total).toBe(0);

      const clave = await request(app(lector)).get(`${BASE}/ejecucion?q=MLA71`);
      expect(clave.body.data.canceladas).toMatchObject({ total: 1 });
      expect(clave.body.data.canceladas.items[0].ml_key).toBe('MLA71|');

      const titulo = await request(app(lector)).get(`${BASE}/ejecucion?q=RODADO%20especial`);
      expect(titulo.body.data.operaciones.map((o) => o.operation_id)).toEqual(['base']);
      expect(titulo.body.data.completadas.total).toBe(0);
      // Contadores globales: no dependen de q.
      expect(titulo.body.data.canceladas_total).toBe(3);
    });

    it('limite: default 50, máximo 200 y valores inválidos al default', async () => {
      expect(parametrosEjecucion({})).toEqual({ q: '', limite: 50, completadas_offset: 0, canceladas_offset: 0 });
      expect(parametrosEjecucion({ limite: '500' }).limite).toBe(200);
      expect(parametrosEjecucion({ limite: '0' }).limite).toBe(50);
      expect(parametrosEjecucion({ limite: 'abc' }).limite).toBe(50);
      expect(parametrosEjecucion({ completadas_offset: '-4' }).completadas_offset).toBe(0);
      expect(parametrosEjecucion({ q: ['a', 'b'] }).q).toBe('');
      await sembrarOperaciones();
      const r = await request(app(lector)).get(`${BASE}/ejecucion?limite=500`);
      expect(r.body.data.completadas.items).toHaveLength(60);
    });
  });
});
