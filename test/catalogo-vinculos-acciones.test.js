import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';
import { ningunoVigente, observacionIncompletaSalud } from '../lib/catalogoVinculos.js';

// Fase D (H1-H5): excepción solo_ml, "ninguno sirve", deshacer/revertir Vincular, deshacer Saltear y franja Estado.
const FILE = './test/tmp-catalogo-vinculos-acciones.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';
const BASE = '/api/catalogo-vinculos';
const FUTURO = '2099-01-01T00:00:00.000Z';

describe('Catálogo y vínculos: acciones de la Fase D', () => {
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
    return a;
  };
  const operador = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const otroOperador = { username: 'bea', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const lector = { username: 'leo', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };
  const admin = { username: 'jose', is_admin: true, permisos: [] };

  function caso(id) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`)
      .run(id, 'Bicicleta Rodado 29 Talle M', `FB-${id}`, 2, ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,canales_json,actualizado_en)
      VALUES (?,?,'','Bicicleta Rodado 29 Talle M','active',NULL,0,2,'[]','["marketplace"]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    return {
      id: db.prepare('SELECT id FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`).id,
      p: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    };
  }
  const estadoCaso = (id) => db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(id);
  const colaIds = async (user = lector) => (await request(app(user)).get(`${BASE}/cola`)).body.data.map((f) => f.caso_id);
  const nOperaciones = () => db.prepare('SELECT COUNT(*) n FROM identidad_operaciones').get().n;
  const cuerpoCaso = (id, extra = {}) => {
    const c = estadoCaso(id);
    return { operation_id: `cmd-${id}-${Math.random().toString(36).slice(2, 8)}`, expected_version: c.expected_version,
      evidence_fingerprint: c.evidencia_fingerprint, ...extra };
  };

  describe('H1. Excepción solo_ml con vencimiento', () => {
    it('el lector recibe 403 y no se crea nada', async () => {
      const c = caso(3001);
      const r = await request(app(lector)).post(`${BASE}/casos/${c.id}/excepcion`).send(cuerpoCaso(c.id, { motivo: 'x', expires_at: FUTURO }));
      expect(r.status).toBe(403);
      expect(estadoCaso(c.id).estado).not.toBe('exceptuado');
    });

    it('valida motivo obligatorio, vencimiento presente, ISO y futuro (422)', async () => {
      const c = caso(3002);
      const a = request(app(operador));
      expect((await a.post(`${BASE}/casos/${c.id}/excepcion`).send(cuerpoCaso(c.id, { expires_at: FUTURO }))).body.error).toMatch(/motivo/);
      expect((await a.post(`${BASE}/casos/${c.id}/excepcion`).send(cuerpoCaso(c.id, { motivo: 'x' }))).status).toBe(422);
      expect((await a.post(`${BASE}/casos/${c.id}/excepcion`).send(cuerpoCaso(c.id, { motivo: 'x', expires_at: 'mañana' }))).body.error).toMatch(/ISO/);
      const pasado = await a.post(`${BASE}/casos/${c.id}/excepcion`).send(cuerpoCaso(c.id, { motivo: 'x', expires_at: '2020-01-01' }));
      expect(pasado.status).toBe(422);
      expect(pasado.body.error).toMatch(/futuro/);
      expect(estadoCaso(c.id).estado).not.toBe('exceptuado');
    });

    it('operador: 201, caso exceptuado, sale de la cola, historial, sin operación remota; repetido = 200', async () => {
      const c = caso(3003);
      expect(await colaIds()).toContain(c.id);
      const ops = nOperaciones();
      const body = cuerpoCaso(c.id, { motivo: 'Sin marketplace, lo maneja el local', expires_at: FUTURO });
      const r = await request(app(operador)).post(`${BASE}/casos/${c.id}/excepcion`).send(body);
      expect(r.status).toBe(201);
      expect(r.body.caso.estado).toBe('exceptuado');
      expect(nOperaciones()).toBe(ops);
      expect(db.prepare('SELECT vence_en,motivo FROM identidad_excepciones WHERE caso_id=?').get(c.id)).toEqual({ vence_en: FUTURO, motivo: 'Sin marketplace, lo maneja el local' });
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE entidad_id=? AND evento='excepcion_solo_ml'").get(c.id).n).toBe(1);
      expect(await colaIds()).not.toContain(c.id);
      const repetido = await request(app(operador)).post(`${BASE}/casos/${c.id}/excepcion`).send(body);
      expect(repetido.status).toBe(200);
      expect(repetido.body.repetido).toBe(true);
    });
  });

  describe('Detalle: campo excepcion (vigente o null)', () => {
    const detalle = async (id) => (await request(app(lector)).get(`${BASE}/casos/${id}`)).body.data;
    const sembrarExcepcion = async (c) => {
      const body = cuerpoCaso(c.id, { motivo: 'Sin marketplace, lo maneja el local', expires_at: FUTURO });
      expect((await request(app(operador)).post(`${BASE}/casos/${c.id}/excepcion`).send(body)).status).toBe(201);
    };

    it('caso sin excepción: excepcion es null', async () => {
      const c = caso(3050);
      expect((await detalle(c.id)).excepcion).toBeNull();
    });

    it('excepción recién creada aparece con tipo, motivo, vence_en, creada_por y creada_en', async () => {
      const c = caso(3051);
      await sembrarExcepcion(c);
      const e = (await detalle(c.id)).excepcion;
      expect(Object.keys(e).sort()).toEqual(['creada_en', 'creada_por', 'motivo', 'tipo', 'vence_en']);
      expect(e).toEqual({ tipo: 'solo_ml', motivo: 'Sin marketplace, lo maneja el local', vence_en: FUTURO,
        creada_por: 'ana', creada_en: expect.any(String) });
    });

    it('desaparece al vencer (vence_en en el pasado, aunque el barrido no haya corrido)', async () => {
      const c = caso(3052);
      await sembrarExcepcion(c);
      db.prepare('UPDATE identidad_excepciones SET vence_en=? WHERE caso_id=?').run('2020-01-01T00:00:00.000Z', c.id);
      expect((await detalle(c.id)).excepcion).toBeNull();
    });

    it('desaparece al invalidarse (activa=0 con invalidada_en)', async () => {
      const c = caso(3053);
      await sembrarExcepcion(c);
      db.prepare("UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='cambio_identidad' WHERE caso_id=?")
        .run(ISO, c.id);
      expect((await detalle(c.id)).excepcion).toBeNull();
    });
  });

  describe('H4. "Ninguno sirve"', () => {
    it('motivo enumerado y lector 403', async () => {
      const c = caso(3010);
      expect((await request(app(lector)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'no_es_ninguno' }))).status).toBe(403);
      const inv = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'otra' }));
      expect(inv.status).toBe(422);
      const largo = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'no_existe_en_woo', nota: 'x'.repeat(501) }));
      expect(largo.status).toBe(422);
    });

    it('saca el caso de la cola, no crea operación ni toca ML; repetir con el mismo operation_id = 200; otro con la misma evidencia = 409', async () => {
      const c = caso(3011);
      const body = cuerpoCaso(c.id, { motivo: 'no_existe_en_woo', nota: 'Es un accesorio' });
      const ops = nOperaciones();
      const cache = db.prepare('SELECT status,available_quantity FROM ml_publicaciones_cache WHERE clave=?').get('MLA3011|');
      const r = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(body);
      expect(r.status).toBe(201);
      expect(await colaIds()).not.toContain(c.id);
      expect(nOperaciones()).toBe(ops);
      expect(db.prepare('SELECT status,available_quantity FROM ml_publicaciones_cache WHERE clave=?').get('MLA3011|')).toEqual(cache);
      const detalle = await request(app(lector)).get(`${BASE}/casos/${c.id}`);
      expect(detalle.body.data.ninguno_sirve).toMatchObject({ motivo: 'no_existe_en_woo', nota: 'Es un accesorio', por: 'ana' });
      // `desde` es el creado_en del evento 'ninguno_sirve' en el historial (mismo criterio que `cierre.desde` en la cola).
      const evNinguno = db.prepare("SELECT creado_en FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? AND evento='ninguno_sirve'").get(c.id);
      expect(detalle.body.data.ninguno_sirve).toEqual({ motivo: 'no_existe_en_woo', nota: 'Es un accesorio', por: 'ana', desde: evNinguno.creado_en });
      expect((await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(body)).body.repetido).toBe(true);
      const otro = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'no_es_ninguno' }));
      expect(otro.status).toBe(409);
    });

    it('reaparece cuando cambia la evidencia; deshacer (z) la vuelve a la cola; deshacer sin marca vigente = 409', async () => {
      const c = caso(3012);
      await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'no_es_ninguno' }));
      expect(await colaIds()).not.toContain(c.id);
      db.prepare("UPDATE identidad_casos SET evidencia_fingerprint='v2:cambiada' WHERE id=?").run(c.id);
      expect(ningunoVigente(db, estadoCaso(c.id))).toBeNull();
      expect(await colaIds()).toContain(c.id);
      // Otra marca con la evidencia nueva, y luego deshacer.
      const marca = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve`).send(cuerpoCaso(c.id, { motivo: 'no_existe_en_woo' }));
      expect(marca.status).toBe(201);
      expect(await colaIds()).not.toContain(c.id);
      const des = await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve/deshacer`).send(cuerpoCaso(c.id));
      expect(des.status).toBe(200);
      expect(await colaIds()).toContain(c.id);
      expect((await request(app(operador)).post(`${BASE}/casos/${c.id}/ninguno-sirve/deshacer`).send(cuerpoCaso(c.id))).status).toBe(409);
    });
  });

  describe('H3. Deshacer un Vincular que no empezó', () => {
    async function vincular(id, user = operador) {
      const c = caso(id);
      const r = await request(app(user)).post(`${BASE}/casos/${c.id}/decisiones`).send(cuerpoCaso(c.id, { tipo: 'vincular', product_id: c.p.id }));
      expect(r.status).toBe(201);
      return { c, opId: r.body.operacion.id, operacion: r.body.operacion };
    }
    const estadoOp = (opId, estado) => db.prepare('UPDATE identidad_operaciones SET estado=? WHERE id=?').run(estado, opId);

    it('la operación en sombra se cancela: estado fallida con cancelada:, caso vuelve al estado previo y historial', async () => {
      const { c, opId } = await vincular(3020);
      expect(estadoCaso(c.id).estado).toBe('pendiente');
      expect(estadoCaso(c.id).responsable).toBe('ana');
      const ops = nOperaciones();
      const r = await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id, { operation_id: 'undo-3020' }));
      expect(r.status).toBe(200);
      expect(r.body.operacion).toMatchObject({ estado: 'fallida' });
      expect(r.body.operacion.ultimo_error).toMatch(/^cancelada: /);
      expect(estadoCaso(c.id)).toMatchObject({ estado: 'urgente', responsable: null });
      expect(nOperaciones()).toBe(ops);
      expect(await colaIds()).toContain(c.id);
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='vinculo_deshecho' AND entidad_id=?").get(c.id).n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='operacion_cancelada_por_deshacer' AND entidad_id=?").get(opId).n).toBe(1);
      // Reintento con el mismo operation_id: repetido, sin cambios.
      const again = await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id, { operation_id: 'undo-3020' }));
      expect(again.body.repetido).toBe(true);
      // Ya cancelada con otro operation_id: 409.
      expect((await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id))).status).toBe(409);
    });

    it('sin datos de versión o evidencia: 422; versión vieja: 409 VERSION_CONFLICT', async () => {
      const { c, opId } = await vincular(3021);
      const sinOp = await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send({ expected_version: 1, evidence_fingerprint: 'x' });
      expect(sinOp.status).toBe(422);
      const vieja = await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send({ operation_id: 'v1', expected_version: 0, evidence_fingerprint: estadoCaso(c.id).evidencia_fingerprint });
      expect(vieja.body.code).toBe('VERSION_CONFLICT');
    });

    it('solo la propia decisión: otro operador 403; admin sí puede', async () => {
      const { c, opId } = await vincular(3022);
      expect((await request(app(otroOperador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id))).status).toBe(403);
      expect((await request(app(lector)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id))).status).toBe(403);
      expect((await request(app(admin)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id))).status).toBe(200);
    });

    it.each(['procesando', 'verificando', 'completada', 'fallida', 'intervencion'])('estado %s: 409 OPERACION_YA_INICIADA y sin cambios', async (estado) => {
      const { c, opId } = await vincular(3023 + ['procesando', 'verificando', 'completada', 'fallida', 'intervencion'].indexOf(estado));
      estadoOp(opId, estado);
      const r = await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('OPERACION_YA_INICIADA');
      expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(opId).estado).toBe(estado);
    });

    it.each(['pendiente', 'shadow', 'bloqueada_impacto'])('estado %s: se puede deshacer', async (estado) => {
      const { c, opId } = await vincular(3030 + ['pendiente', 'shadow', 'bloqueada_impacto'].indexOf(estado));
      estadoOp(opId, estado);
      expect((await request(app(operador)).post(`${BASE}/operaciones/${opId}/deshacer`).send(cuerpoCaso(c.id))).status).toBe(200);
    });

    it('Revertir: una completada encola una operación nueva hacia el SKU anterior (motivo obligatorio)', async () => {
      const previo = caso(3040);
      const { c, opId } = await vincular(3041);
      db.prepare("UPDATE identidad_operaciones SET estado='completada', sku_anterior=? WHERE id=?").run(previo.p.fusion_sku, opId);
      const ops = nOperaciones();
      const sinMotivo = await request(app(operador)).post(`${BASE}/operaciones/${opId}/revertir`).send(cuerpoCaso(c.id));
      expect(sinMotivo.status).toBe(422);
      const r = await request(app(operador)).post(`${BASE}/operaciones/${opId}/revertir`).send(cuerpoCaso(c.id, { motivo: 'Volver al SKU original' }));
      expect(r.status).toBe(201);
      expect(r.body.operacion).toMatchObject({ sku_objetivo: previo.p.fusion_sku, estado: 'shadow' });
      expect(r.body.revierte_operacion_id).toBe(opId);
      expect(nOperaciones()).toBe(ops + 1);
      expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='vinculo_revertido' AND entidad_id=?").get(c.id).n).toBe(1);
    });

    it('Revertir rechaza operaciones no completadas (409) y SKU anterior sin producto (422)', async () => {
      const { c, opId } = await vincular(3045);
      const r1 = await request(app(operador)).post(`${BASE}/operaciones/${opId}/revertir`).send(cuerpoCaso(c.id, { motivo: 'x' }));
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe('INVALID_STATE');
      db.prepare("UPDATE identidad_operaciones SET estado='completada', sku_anterior='FB-NO-EXISTE' WHERE id=?").run(opId);
      const r2 = await request(app(operador)).post(`${BASE}/operaciones/${opId}/revertir`).send(cuerpoCaso(c.id, { motivo: 'x' }));
      expect(r2.status).toBe(422);
    });

    it('Revertir con confirmación de contradicción es solo admin (403 al operador)', async () => {
      const { c, opId } = await vincular(3046);
      db.prepare("UPDATE identidad_operaciones SET estado='completada', sku_anterior='FB-3046' WHERE id=?").run(opId);
      const r = await request(app(operador)).post(`${BASE}/operaciones/${opId}/revertir`).send(cuerpoCaso(c.id, { motivo: 'x', override_contradiccion: true }));
      expect(r.status).toBe(403);
    });
  });

  describe('H3b. Deshacer Saltear', () => {
    it('saltear y luego deshacer vuelve el caso a la cola sin operación; versión vieja 409; sin salteo 409', async () => {
      const c = caso(3050);
      const cola = await colaIds();
      expect(cola).toContain(c.id);
      const sal = await request(app(operador)).post(`${BASE}/casos/${c.id}/saltear`).send({ expected_version: estadoCaso(c.id).expected_version });
      expect(sal.status).toBe(200);
      expect(await colaIds()).not.toContain(c.id);
      const ops = nOperaciones();
      const vieja = await request(app(operador)).post(`${BASE}/casos/${c.id}/deshacer-salteo`).send({ expected_version: 0 });
      expect(vieja.body.code).toBe('VERSION_CONFLICT');
      const des = await request(app(operador)).post(`${BASE}/casos/${c.id}/deshacer-salteo`).send({ expected_version: estadoCaso(c.id).expected_version });
      expect(des.status).toBe(200);
      expect(await colaIds()).toContain(c.id);
      expect(nOperaciones()).toBe(ops);
      expect((await request(app(operador)).post(`${BASE}/casos/${c.id}/deshacer-salteo`).send({ expected_version: estadoCaso(c.id).expected_version })).status).toBe(409);
      expect((await request(app(lector)).post(`${BASE}/casos/${c.id}/deshacer-salteo`).send({ expected_version: 1 })).status).toBe(403);
    });
  });

  describe('H5. Franja Estado y aviso de link de pago', () => {
    it('/estado trae lectura, error, modo y escrituras remotas', async () => {
      db.prepare("UPDATE identidad_config SET ultimo_scan_error='timeout ML' WHERE id=1").run();
      const r = await request(app(lector)).get(`${BASE}/estado`);
      expect(r.status).toBe(200);
      expect(r.body.data.salud).toMatchObject({ error_lectura: 'timeout ML', modo: 'shadow', escrituras_remotas: false });
      expect(r.body.data.salud).toHaveProperty('ultima_lectura_confiable');
    });

    it('detalle del caso marca link_de_pago_sin_marketplace cuando la publicación no está en marketplace', async () => {
      const c = caso(3060);
      expect((await request(app(lector)).get(`${BASE}/casos/${c.id}`)).body.data.link_de_pago_sin_marketplace).toBe(false);
      db.prepare("UPDATE ml_publicaciones_cache SET canales_json='[\"link_de_pago\"]' WHERE clave='MLA3060|'").run();
      const r = await request(app(lector)).get(`${BASE}/casos/${c.id}`);
      expect(r.body.data.link_de_pago_sin_marketplace).toBe(true);
      expect(r.body.data.publicacion ?? r.body.data.caso.publicacion).toMatchObject({ es_marketplace: false });
    });
  });

  describe('Franja Estado: observacion_incompleta (booleano, fail-closed)', () => {
    it('con todas las claves activas con stock observadas: false y sin detalle', async () => {
      caso(3101);
      db.prepare("UPDATE ml_publicaciones_cache SET atributos_json='[]' WHERE clave='MLA3101|'").run();
      const r = await request(app(lector)).get(`${BASE}/estado`);
      expect(r.status).toBe(200);
      expect(r.body.data.salud).toMatchObject({ observacion_incompleta: false, observacion_incompleta_detalle: null, observacion_incompleta_cantidad: 0 });
    });

    it('con una clave activa con stock sin atributos: true con detalle y cantidad', async () => {
      caso(3102);
      db.prepare("UPDATE ml_publicaciones_cache SET atributos_json=NULL WHERE clave='MLA3102|'").run();
      const r = await request(app(lector)).get(`${BASE}/estado`);
      expect(r.body.data.salud.observacion_incompleta).toBe(true);
      expect(r.body.data.salud.observacion_incompleta_cantidad).toBe(1);
      expect(r.body.data.salud.observacion_incompleta_detalle).toMatch(/1 claves/);
      expect(r.body.data.salud.sano).toBe(false);
    });

    it('si no se puede determinar: true (fail-closed), sin detalle numérico', () => {
      const roto = { prepare() { throw new Error('esquema ilegible'); } };
      expect(observacionIncompletaSalud(roto)).toEqual({
        observacion_incompleta: true,
        observacion_incompleta_detalle: 'no se pudo determinar la observación',
        observacion_incompleta_cantidad: null,
      });
    });
  });
});
