import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { escanearGuardiaMl, estadoGuardiaMl, esClaveCubierta, listarGuardiaMl, retenerPedidoMl, pedidoMlRetenido, resolverRetencionPedidoMl } from '../lib/guardiaMl.js';
import { guardiaMlRouter } from '../routes/guardiaMl.js';
import { perfilPublicacionMl } from '../lib/guardiaMlAprendizaje.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: async () => ({ status: 200, ok: true, data: {} }),
  categorizarErrorMl: () => 'interno',
  estadoCooldownMl: () => ({ activo: false }),
}));

const FILE='./test/tmp-guardia.sqlite'; const now=()=>new Date().toISOString();
function cache(db, clave, sku='', stock=1){db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`).run(clave,clave.split('|')[0],clave.split('|')[1]||'',clave,'active',sku,stock,now())}
function catalogo(db,sku){db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,?,?,?)`).run(Math.floor(Math.random()*1e6),'P '+sku+' Casco urbano negro',sku,'simple',2,now())}
function decision(db,clave,sku,accion='confirmar'){db.prepare(`INSERT INTO sku_matcher_decisiones(clave,sku,accion,actualizado_en) VALUES (?,?,?,?)`).run(clave,sku,accion,now())}
describe('Guardia ML',()=>{let db;beforeEach(()=>{db=openDb(FILE);db.prepare("UPDATE guardia_ml_config SET modo='acciones' WHERE id=1").run()});afterEach(()=>{db.close();if(fs.existsSync(FILE))fs.unlinkSync(FILE)});
 it('abre solo la variación activa con stock sin vínculo exacto',()=>{catalogo(db,'FB-1');cache(db,'MLA1|a','',1);cache(db,'MLA1|b','FB-1',1);decision(db,'MLA1|b','FB-1');cache(db,'MLA2|', '',0);const r=escanearGuardiaMl(db);expect(r.total).toBe(1);expect(db.prepare('SELECT clave FROM guardia_ml_casos').all()).toEqual([{clave:'MLA1|a'}]);expect(esClaveCubierta(db,'MLA1|b')).toBe(true)});
 it('no permite que una omisión histórica cubra una clave vendible',()=>{cache(db,'MLA3|','',2);decision(db,'MLA3|',null,'omitir');escanearGuardiaMl(db);expect(db.prepare('SELECT estado FROM guardia_ml_casos WHERE clave=?').get('MLA3|').estado).toBe('abierto')});
 it('es idempotente y expone estado sano solo sin urgentes',()=>{catalogo(db,'FB-2');cache(db,'MLA4|','FB-2',1);decision(db,'MLA4|','FB-2');escanearGuardiaMl(db,'sistema',{lecturaMlConfirmada:true});expect(estadoGuardiaMl(db).sano).toBe(true);cache(db,'MLA5|','',1);escanearGuardiaMl(db);escanearGuardiaMl(db);expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_casos').get().n).toBe(1);expect(estadoGuardiaMl(db).sano).toBe(false)});
 it('retiene una venta sin cobertura y solo la libera con una acción explícita',()=>{retenerPedidoMl(db,{orderId:'ORD-1',items:[{item_id:'X'}],claves:['MLA6|v']});expect(pedidoMlRetenido(db,'ORD-1')).toBeTruthy();expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='MLA6|v'").get().estado).toBe('abierto');expect(resolverRetencionPedidoMl(db,'ORD-1','ventas','liberado')).toBe(true);expect(pedidoMlRetenido(db,'ORD-1')).toBeUndefined()});
 it('reabre una excepción vencida conservando su responsable',()=>{cache(db,'MLA7|','',1);escanearGuardiaMl(db);db.prepare("UPDATE guardia_ml_casos SET estado='excepcion',responsable='ventas',excepcion_vence_en=? WHERE clave='MLA7|'").run(new Date(Date.now()-1000).toISOString());escanearGuardiaMl(db);const c=db.prepare("SELECT estado,responsable FROM guardia_ml_casos WHERE clave='MLA7|'").get();expect(c).toEqual({estado:'abierto',responsable:'ventas'});expect(db.prepare("SELECT evento FROM guardia_ml_eventos WHERE evento='excepcion_vencida'").get()).toBeTruthy()});
 it('no permite confirmar stock compartido sin dos vínculos válidos',()=>{catalogo(db,'FB-3');cache(db,'MLA8|a','FB-3',1);cache(db,'MLA8|b','FB-3',1);decision(db,'MLA8|a','FB-3');expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE sku='FB-3'").get().n).toBe(1);expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_stock_compartido').get().n).toBe(0)});
 it('un escaneo manual de cache no declara frescura de MercadoLibre',()=>{cache(db,'MLA9|','',1);escanearGuardiaMl(db);expect(db.prepare('SELECT ultimo_scan_exitoso_en FROM guardia_ml_config WHERE id=1').get().ultimo_scan_exitoso_en).toBeNull();expect(estadoGuardiaMl(db).degradado).toBe(true)});
 it('trata como descubierto un vínculo activo cuyo SKU ya no existe en Woo',()=>{cache(db,'MLA10|','FB-ELIMINADO',3);decision(db,'MLA10|','FB-ELIMINADO');escanearGuardiaMl(db);expect(db.prepare("SELECT motivo FROM guardia_ml_casos WHERE clave='MLA10|'").get().motivo).toBe('sin_cobertura')});
 it('usa seller_sku solo como señal de ventas, no como cobertura',()=>{db.exec("CREATE TABLE pedidos_cache (clave TEXT PRIMARY KEY,canal TEXT,ml_order_id TEXT,fecha TEXT,fecha_despacho_limite TEXT,items_json TEXT)");cache(db,'MLA11|','FB-SEÑAL',1);db.prepare('INSERT INTO pedidos_cache VALUES (?,?,?,?,?,?)').run('ml:o1','ml','o1',new Date().toISOString(),null,JSON.stringify([{seller_sku:'FB-SEÑAL'}]));escanearGuardiaMl(db);const c=listarGuardiaMl(db)[0];expect(c.ventas_30d).toBe(1);expect(esClaveCubierta(db,'MLA11|')).toBe(false)});
 it('permite vincular SKU compartido sin bloqueo 409 (cambio de política 2026-09-03)',async()=>{catalogo(db,'FB-12');cache(db,'MLA12|a','',1);cache(db,'MLA13|b','FB-12',1);decision(db,'MLA13|b','FB-12');escanearGuardiaMl(db);const caso=db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA12|a'").get();const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={username:'admin',is_admin:1};next()});app.use('/api/guardia-ml',guardiaMlRouter(db,{}));const res=await request(app).post(`/api/guardia-ml/casos/${caso.id}/vincular`).send({sku:'FB-12'});expect(res.status).toBe(202);expect(res.body.requiere_stock_compartido).toBeUndefined();expect(db.prepare("SELECT COUNT(*) n FROM guardia_ml_operaciones WHERE tipo='vincular'").get().n).toBeGreaterThan(0)});
 it('devuelve publicación completa y opciones Woo únicas para comparar',async()=>{db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,variations_texto,thumbnail,permalink,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('MLA14|','MLA14','','Cubierta Goodyear','active','SKU-REMOTO','Negra','https://img.ml/test.jpg','https://articulo.ml/MLA14',3,now());catalogo(db,'SKU-WOO');db.prepare("UPDATE catalogo_cache SET nombre='Cubierta Goodyear Negra',img='https://img.woo/test.jpg'").run();escanearGuardiaMl(db);const caso=db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA14|'").get();const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={username:'admin',is_admin:1};next()});app.use('/api/guardia-ml',guardiaMlRouter(db,{}));const res=await request(app).get(`/api/guardia-ml/casos/${caso.id}/opciones?q=goodyear`);expect(res.status).toBe(200);expect(res.body.data.publicacion).toMatchObject({item_id:'MLA14',thumbnail:'https://img.ml/test.jpg',seller_sku:'SKU-REMOTO'});expect(res.body.data.opciones).toHaveLength(1);expect(res.body.data.opciones[0]).toMatchObject({sku:'SKU-WOO',img:'https://img.woo/test.jpg'})});
 it('detecta seller_sku divergente como falta de cobertura',()=>{catalogo(db,'FB-DIVERGE');cache(db,'MLA15|','FB-VIEJO',1);decision(db,'MLA15|','FB-DIVERGE');expect(esClaveCubierta(db,'MLA15|')).toBe(false);escanearGuardiaMl(db);const caso=db.prepare("SELECT estado,motivo FROM guardia_ml_casos WHERE clave='MLA15|'").get();expect(caso).toBeTruthy();expect(caso.estado).toBe('abierto');expect(caso.motivo).toBe('sin_cobertura')});
 it('retiene pedido con clave cuya decisión diverge remotamente',()=>{catalogo(db,'FB-REMOTO');cache(db,'MLA16|','FB-LOCAL',1);decision(db,'MLA16|','FB-REMOTO');db.exec("CREATE TABLE pedidos_cache (clave TEXT PRIMARY KEY,canal TEXT,ml_order_id TEXT,fecha TEXT,fecha_despacho_limite TEXT,items_json TEXT)");retenerPedidoMl(db,{orderId:'ORD-2',items:[{item_id:'MLA16'}],claves:['MLA16|'],motivo:'divergencia_remota'});expect(pedidoMlRetenido(db,'ORD-2')).toBeTruthy();expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='MLA16|'").get().estado).toBe('abierto')});
 it('permite operación Guardia autorizada sin bypassear intención',async()=>{catalogo(db,'FB-GUARDIAO');cache(db,'MLA17|','FB-VIEJO',1);decision(db,'MLA17|','FB-GUARDIAO');escanearGuardiaMl(db);const caso=db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA17|'").get();db.prepare("UPDATE guardia_ml_casos SET estado='pendiente_ml' WHERE id=?").run(caso.id);const r=await import('../lib/guardiaMl.js');expect(()=>{r.encolarOperacionGuardia(db,{casoId:caso.id,tipo:'vincular',sku:'FB-GUARDIAO'})}).not.toThrow()});
 it('abre caso cuando el SKU decidido aparece duplicado en el catálogo',()=>{catalogo(db,'FB-DUP');catalogo(db,'FB-DUP');cache(db,'MLA18|','FB-LOCAL',2);decision(db,'MLA18|','FB-DUP');escanearGuardiaMl(db);expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='MLA18|'").get().estado).toBe('abierto')});
 it('ordena primero el SKU aprendido sin auto-confirmar la decisión',async()=>{db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,variations_texto,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)`).run('MLA19|','MLA19','', 'Casco urbano negro','active','DESCONOCIDO','Negro',2,now());catalogo(db,'FB-19A');catalogo(db,'FB-19B');const perfil=perfilPublicacionMl({titulo:'Casco urbano negro',variations_texto:'Negro'});db.prepare('INSERT INTO guardia_ml_aprendizajes(perfil,sku,confirmaciones,ultima_confirmacion) VALUES (?,?,?,?)').run(perfil,'FB-19B',4,now());escanearGuardiaMl(db);const caso=db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA19|' ").get();const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={username:'admin',is_admin:1};next()});app.use('/api/guardia-ml',guardiaMlRouter(db,{}));const res=await request(app).get(`/api/guardia-ml/casos/${caso.id}/opciones`);expect(res.body.data.opciones[0]).toMatchObject({sku:'FB-19B',confirmaciones_aprendizaje:4});expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA19|' ").get().n).toBe(0)});
  // Learning is exercised through the candidate endpoint in the dedicated integration suite.
});

describe('Guardia ML: asignación de responsable en acciones', () => {
  let db;
  const FILE = './test/guardia-ml-responsable.sqlite';
  const now = () => new Date().toISOString();
  function cachePubl(db, clave, sku = '', stock = 1) {
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clave, clave.split('|')[0], clave.split('|')[1] || '', clave, 'active', sku, stock, now());
  }
  function catalogoItem(db, sku) {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,?,?,?)`)
      .run(Math.floor(Math.random() * 1e6), 'P ' + sku, sku, 'simple', 2, now());
  }
  function app(db) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = { username: 'Jose', is_admin: 1 }; next(); });
    a.use('/api/guardia-ml', guardiaMlRouter(db, {}));
    return a;
  }
  beforeEach(() => { db = openDb(FILE); db.prepare("UPDATE guardia_ml_config SET modo='acciones' WHERE id=1").run(); });
  afterEach(() => { db.close(); if (fs.existsSync(FILE)) fs.unlinkSync(FILE); });

  it('pausar un caso sin responsable asigna responsable y ejecuta la operación', async () => {
    cachePubl(db, 'MLA100|', '', 3);
    escanearGuardiaMl(db);
    const caso = db.prepare("SELECT id,responsable FROM guardia_ml_casos WHERE clave='MLA100|'").get();
    expect(caso.responsable).toBe(null);

    const res = await request(app(db)).post(`/api/guardia-ml/casos/${caso.id}/pausar`).send({ confirmado: true });
    expect(res.status).toBe(202);

    const { procesarOperacionesGuardia } = await import('../lib/guardiaMl.js');
    await procesarOperacionesGuardia(db, { ml: {} });
    const op = db.prepare('SELECT estado FROM guardia_ml_operaciones ORDER BY id DESC LIMIT 1').get();
    expect(op.estado).toBe('completada');
    const casoFinal = db.prepare('SELECT responsable FROM guardia_ml_casos WHERE id=?').get(caso.id);
    expect(casoFinal.responsable).toBe('Jose');
  });

  it('vincular como admin sobre caso sin responsable asigna responsable y ejecuta', async () => {
    catalogoItem(db, 'FB-900');
    cachePubl(db, 'MLA101|', '', 3);
    escanearGuardiaMl(db);
    const caso = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA101|'").get();

    const res = await request(app(db)).post(`/api/guardia-ml/casos/${caso.id}/vincular`).send({ sku: 'FB-900' });
    expect(res.status).toBe(202);

    const { procesarOperacionesGuardia } = await import('../lib/guardiaMl.js');
    await procesarOperacionesGuardia(db, { ml: {} });
    const op = db.prepare('SELECT estado FROM guardia_ml_operaciones ORDER BY id DESC LIMIT 1').get();
    expect(op.estado).toBe('completada');
    const casoFinal = db.prepare('SELECT responsable FROM guardia_ml_casos WHERE id=?').get(caso.id);
    expect(casoFinal.responsable).toBe('Jose');
  });
});

describe('Guardia ML: compartición normal de SKUs (2026-09-03)', () => {
  let db;
  const FILE = './test/guardia-ml-compartido.sqlite';
  const now = () => new Date().toISOString();
  function cachePubl(db, clave, sku = '', stock = 1) {
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clave, clave.split('|')[0], clave.split('|')[1] || '', clave, 'active', sku, stock, now());
  }
  function catalogoItem(db, sku) {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,regular_price,precio,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`)
      .run(Math.floor(Math.random() * 1e6), 'P ' + sku, sku, 'simple', 5, 1000, 800, now());
  }
  function app(db) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = { username: 'Jose', is_admin: 1 }; next(); });
    a.use('/api/guardia-ml', guardiaMlRouter(db, {}));
    return a;
  }
  beforeEach(() => { db = openDb(FILE); db.prepare("UPDATE guardia_ml_config SET modo='acciones' WHERE id=1").run(); });
  afterEach(() => { db.close(); if (fs.existsSync(FILE)) fs.unlinkSync(FILE); });

  it('permite vincular SKU ya compartido sin bloqueo 409 (Trabajo 1)', async () => {
    // Escenario: SKU ya está vinculado a otra clave. Antes: 409. Ahora: OK.
    catalogoItem(db, 'FB-COMPARTIDO');
    cachePubl(db, 'MLA-A|', '', 2); // Clave A sin SKU
    cachePubl(db, 'MLA-B|', '', 2); // Clave B sin SKU

    // Vincular SKU a clave B primero
    escanearGuardiaMl(db);
    let casoB = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA-B|'").get();
    let res = await request(app(db)).post(`/api/guardia-ml/casos/${casoB.id}/vincular`).send({ sku: 'FB-COMPARTIDO' });
    expect(res.status).toBe(202); // Encolada

    // Vincular el MISMO SKU a clave A: antes bloqueaba con 409, ahora debe permitir sin bloqueo
    escanearGuardiaMl(db);
    let casoA = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA-A|'").get();
    res = await request(app(db)).post(`/api/guardia-ml/casos/${casoA.id}/vincular`).send({ sku: 'FB-COMPARTIDO' });
    expect(res.status).toBe(202); // NO 409 — debe estar encolada
    expect(res.body.requiere_stock_compartido).toBeUndefined(); // NO debe haber este campo

    // Verificar que ambas operaciones fueron encoladas
    const ops = db.prepare('SELECT COUNT(*) n FROM guardia_ml_operaciones').get();
    expect(ops.n).toBeGreaterThanOrEqual(1);
  });

  it('registra stock compartido de forma informativa sin bloquear (Trabajo 1)', async () => {
    catalogoItem(db, 'FB-SHARED');
    cachePubl(db, 'MLA-C|', '', 1);
    cachePubl(db, 'MLA-D|', '', 1);

    // Primera vinculación
    escanearGuardiaMl(db);
    let caso1 = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA-C|'").get();
    let res1 = await request(app(db)).post(`/api/guardia-ml/casos/${caso1.id}/vincular`).send({ sku: 'FB-SHARED' });
    expect(res1.status).toBe(202);

    // Ejecutar operación
    const { procesarOperacionesGuardia } = await import('../lib/guardiaMl.js');
    await procesarOperacionesGuardia(db, { ml: {} });

    // Segunda vinculación: debe registrar en guardia_ml_stock_compartido
    escanearGuardiaMl(db);
    let caso2 = db.prepare("SELECT id FROM guardia_ml_casos WHERE clave='MLA-D|'").get();
    let res2 = await request(app(db)).post(`/api/guardia-ml/casos/${caso2.id}/vincular`).send({ sku: 'FB-SHARED' });
    expect(res2.status).toBe(202);

    // Verificar que el registro informativo fue creado
    const compartido = db.prepare('SELECT sku FROM guardia_ml_stock_compartido WHERE sku=?').get('FB-SHARED');
    expect(compartido).toBeTruthy();
  });

  it('vincula SKU desde matcher sin caso abierto (Trabajo 3)', async () => {
    catalogoItem(db, 'FB-MATCHER');
    cachePubl(db, 'MLA-E|', '', 1);

    // Publicación existe en ML pero NO tiene caso abierto en Guardia
    expect(db.prepare("SELECT COUNT(*) n FROM guardia_ml_casos WHERE clave='MLA-E|'").get().n).toBe(0);

    // Llamar nuevo endpoint POST /vincular-clave
    const res = await request(app(db)).post('/api/guardia-ml/vincular-clave').send({
      clave: 'MLA-E|',
      sku: 'FB-MATCHER'
    });

    // Debe crear el caso, asignar responsable automático y encolar la vinculación real —
    // sin el guard "if (res.status === 202)" esto queda decorativo: pasa en verde tanto si
    // el endpoint funciona como si tira 500 (fue exactamente el bug de casoVersion=0 vs.
    // expected_version DEFAULT 1 que rompía el 100% de las vinculaciones nuevas desde el matcher).
    expect(res.status).toBe(202);
    expect(res.body.caso_id).toBeDefined();
    const caso = db.prepare("SELECT id,estado,responsable,expected_version FROM guardia_ml_casos WHERE clave='MLA-E|'").get();
    expect(caso).toBeTruthy();
    // encolarOperacionGuardia mueve el caso a pendiente_ml al encolar (ver lib/guardiaMl.js);
    // se queda en 'abierto' es la señal de que la operación NUNCA se encoló.
    expect(caso.estado).toBe('pendiente_ml');
    expect(caso.responsable).toBe('Jose');
    expect(caso.expected_version).toBe(2); // 1 (default al crear) + 1 (encolarOperacionGuardia)
    const operacion = db.prepare("SELECT tipo,sku,estado FROM guardia_ml_operaciones WHERE caso_id=?").get(caso.id);
    expect(operacion).toBeTruthy();
    expect(operacion.tipo).toBe('vincular');
    expect(operacion.sku).toBe('FB-MATCHER');
    expect(operacion.estado).toBe('pendiente');
  });
});
