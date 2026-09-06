import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import {
  bootstrapProductosFusion, conflictosDeIdentificador, identificadorPrincipal,
  marcarIdentificadorIncorrecto, reordenarIdentificadores, resolverConflictoIdentificador,
  sembrarIdentificadoresMl,
} from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';

const FILE = './test/tmp-identificadores-ml.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';

function woo(db, { id, sku, gtin = null, padre = null, stock = 2 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,gtin,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, `Producto ${id}`, sku, padre ? 'variation' : 'simple', padre, stock, gtin, ISO);
}

function ml(db, { clave, sku, gtin, stock = 2, status = 'active' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,actualizado_en)
    VALUES (?,?,'','Publicación',?,?,1,?,?,?)`).run(clave, clave.split('|')[0], status, sku, gtin, stock, ISO);
}

const gtinDe = (db, productoId) => db.prepare(
  `SELECT valor_normalizado, valor_crudo, subtipo, fuente, estado, orden
   FROM identificadores_producto WHERE tipo='gtin' AND producto_id=? ORDER BY orden, id`,
).all(productoId);

const idDe = (db, idWoo) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(idWoo).id;

describe('siembra de identificadores GTIN desde ML', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('siembra en forma canónica el GTIN que sólo conocía ML', () => {
    woo(db, { id: 10, sku: 'FB-10' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA1|', sku: 'FB-10', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 1, conflictos: 0, absorbidos: 0 });
    expect(gtinDe(db, idDe(db, 10))).toMatchObject([{
      valor_normalizado: '00602883701731', valor_crudo: '602883701731',
      subtipo: 'upc_a', fuente: 'ml', estado: 'activo',
    }]);
  });

  it('reconoce como el mismo código el que Woo y ML escriben con distinto relleno', () => {
    // El caso que motivó todo: 13 pares de producción diferían sólo en los ceros.
    woo(db, { id: 11, sku: 'FB-11', gtin: '602883701731' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA2|', sku: 'FB-11', gtin: '0602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, conflictos: 0 });
    // Una sola fila: no se duplica el identificador ni se abre un conflicto falso.
    expect(gtinDe(db, idDe(db, 11))).toHaveLength(1);
  });

  it('absorbe las variaciones que heredaron el GTIN del padre', () => {
    // 28 casos de producción: talles de un mismo producto compartiendo código.
    // Es deuda de catálogo, no ambigüedad de identidad: no genera trabajo humano.
    woo(db, { id: 20, sku: 'FB-20', gtin: '602883701731' });
    woo(db, { id: 21, sku: 'FB-21', padre: 20 });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA3|', sku: 'FB-21', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ conflictos: 0, absorbidos: 1 });
    expect(gtinDe(db, idDe(db, 21))).toHaveLength(0);
  });

  it('registra el conflicto entre productos distintos en vez de descartarlo', () => {
    // Antes, el INSERT OR IGNORE hacía desaparecer este caso sin dejar rastro.
    woo(db, { id: 30, sku: 'FB-30', gtin: '602883701731' });
    woo(db, { id: 31, sku: 'FB-31' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA4|', sku: 'FB-31', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ conflictos: 1, absorbidos: 0 });
    expect(gtinDe(db, idDe(db, 31))).toMatchObject([{ estado: 'conflicto', fuente: 'ml' }]);
    // El identificador original no se toca: el conflicto no le saca la identidad a nadie.
    expect(gtinDe(db, idDe(db, 30))).toMatchObject([{ estado: 'activo' }]);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='gtin_en_conflicto'").get().n).toBe(1);
  });

  it('deja pasar el conflicto por el índice parcial pero no dos activos', () => {
    woo(db, { id: 40, sku: 'FB-40', gtin: '602883701731' });
    woo(db, { id: 41, sku: 'FB-41' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA5|', sku: 'FB-41', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);

    expect(() => db.prepare(
      "UPDATE identificadores_producto SET estado='activo' WHERE estado='conflicto'",
    ).run()).toThrow();
  });

  it('deriva las publicaciones sin respaldo en Woo marcando stock y estado', () => {
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA6|', sku: 'NO-EXISTE', gtin: '602883701731', stock: 4 });
    ml(db, { clave: 'MLA7|', sku: 'TAMPOCO', gtin: '4006381333931', stock: 0, status: 'paused' });

    const r = sembrarIdentificadoresMl(db);
    expect(r.sembrados).toBe(0);
    expect(r.sinRespaldoWoo).toEqual([
      { clave: 'MLA6|', seller_sku: 'NO-EXISTE', gtin: '602883701731', stock: 4, activa: true },
      { clave: 'MLA7|', seller_sku: 'TAMPOCO', gtin: '4006381333931', stock: 0, activa: false },
    ]);
  });

  it('no siembra cuando el SKU vive en más de un producto Woo', () => {
    // Ese caso ya lo reporta `sku_no_unico`; elegir acá sería elegir al azar.
    woo(db, { id: 50, sku: 'DUP' });
    woo(db, { id: 51, sku: 'DUP' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA8|', sku: 'DUP', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, conflictos: 0 });
  });

  it('ignora los códigos que no son GTIN válidos', () => {
    woo(db, { id: 60, sku: 'FB-60' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA9|', sku: 'FB-60', gtin: 'N/A' });
    ml(db, { clave: 'MLA10|', sku: 'FB-60', gtin: '4006381333932' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, sinRespaldoWoo: [] });
  });

  it('es idempotente: correrla de nuevo no duplica ni reabre nada', () => {
    woo(db, { id: 70, sku: 'FB-70' });
    woo(db, { id: 71, sku: 'FB-71' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA11|', sku: 'FB-70', gtin: '602883701731' });
    ml(db, { clave: 'MLA12|', sku: 'FB-71', gtin: '602883701731' });

    const primera = sembrarIdentificadoresMl(db);
    const total = db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin'").get().n;
    const segunda = sembrarIdentificadoresMl(db);

    expect(segunda.sembrados).toBe(0);
    expect(segunda.conflictos).toBe(0);
    expect(primera.sembrados + primera.conflictos).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin'").get().n).toBe(total);
  });
});

describe('orden de prioridad de identificadores', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function productoConDos() {
    // Dos códigos legítimos del mismo artículo, como Shimano-JP y Shimano-US.
    woo(db, { id: 80, sku: 'FB-80', gtin: '4524667220343' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA20|', sku: 'FB-80', gtin: '689228220348' });
    sembrarIdentificadoresMl(db);
    return idDe(db, 80);
  }

  it('elige como principal el primero del orden configurado', () => {
    const id = productoConDos();
    expect(gtinDe(db, id)).toHaveLength(2);
    // Con la prioridad por defecto (woo,ml) gana el que Woo ya publica, así el
    // orden inicial no cambia en silencio lo que hoy ve un cliente.
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('04524667220343');
  });

  it('deja reordenar cuál gana, sin perder los otros', () => {
    const id = productoConDos();
    const r = reordenarIdentificadores(db, id, ['00689228220348', '04524667220343']);

    expect(r).toMatchObject({ ok: true, principal: '00689228220348' });
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('00689228220348');
    expect(gtinDe(db, id)).toHaveLength(2);
  });

  it('rechaza una lista que no cubre todos los activos', () => {
    // Completarla sola dejaría al faltante en una posición que nadie eligió,
    // y podría terminar primero.
    const id = productoConDos();
    expect(reordenarIdentificadores(db, id, ['00689228220348'])).toMatchObject({ ok: false });
    expect(reordenarIdentificadores(db, id, ['00689228220348', '00000000000000'])).toMatchObject({ ok: false });
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('04524667220343');
  });

  it('resuelve el principal de forma estable cuando comparten orden', () => {
    // Situación normal tras un backfill: sin desempate por id, la proyección a
    // Woo podría cambiar sola entre dos corridas.
    const id = productoConDos();
    db.prepare("UPDATE identificadores_producto SET orden=10 WHERE tipo='gtin' AND producto_id=?").run(id);
    const primera = identificadorPrincipal(db, id).id;
    expect(identificadorPrincipal(db, id).id).toBe(primera);
  });

  it('respeta la prioridad configurada al sembrar', () => {
    db.prepare("UPDATE identidad_config SET identificadores_prioridad='ml,woo,manual' WHERE id=1").run();
    const id = productoConDos();
    expect(identificadorPrincipal(db, id).fuente).toBe('ml');
  });
});

describe('conflictos de identificador para la bandeja', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('agrupa por código y no por fila, y ordena por stock expuesto en ML', () => {
    // La unidad de trabajo es el código: en producción 41 códigos son 399 filas.
    woo(db, { id: 90, sku: 'FB-90', gtin: '602883701731' });
    woo(db, { id: 91, sku: 'FB-91' });
    woo(db, { id: 92, sku: 'FB-92' });
    woo(db, { id: 93, sku: 'FB-93', gtin: '4006381333931' });
    woo(db, { id: 94, sku: 'FB-94' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA30|', sku: 'FB-91', gtin: '602883701731', stock: 1 });
    ml(db, { clave: 'MLA31|', sku: 'FB-92', gtin: '602883701731', stock: 2 });
    ml(db, { clave: 'MLA32|', sku: 'FB-94', gtin: '4006381333931', stock: 9 });
    sembrarIdentificadoresMl(db);

    const r = conflictosDeIdentificador(db);
    expect(r).toHaveLength(2);
    // El de más stock primero: puede estar descontando del producto equivocado.
    expect(r[0]).toMatchObject({ valor_normalizado: '04006381333931', productos: 2, stock_ml: 9 });
    expect(r[1]).toMatchObject({ valor_normalizado: '00602883701731', productos: 3, stock_ml: 3 });
  });

  it('no reporta un código que un solo producto reclama', () => {
    woo(db, { id: 95, sku: 'FB-95', gtin: '602883701731' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA33|', sku: 'FB-95', gtin: '0602883701731' });
    sembrarIdentificadoresMl(db);

    expect(conflictosDeIdentificador(db)).toEqual([]);
  });

  it('cuenta sólo el stock de publicaciones activas', () => {
    woo(db, { id: 96, sku: 'FB-96', gtin: '602883701731' });
    woo(db, { id: 97, sku: 'FB-97' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA34|', sku: 'FB-97', gtin: '602883701731', stock: 5, status: 'paused' });
    sembrarIdentificadoresMl(db);

    expect(conflictosDeIdentificador(db)[0]).toMatchObject({ stock_ml: 0 });
  });
});

describe('resolución de un conflicto de GTIN', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function conflicto() {
    woo(db, { id: 100, sku: 'FB-100', gtin: '602883701731' });
    woo(db, { id: 101, sku: 'FB-101' });
    woo(db, { id: 102, sku: 'FB-102' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA40|', sku: 'FB-101', gtin: '602883701731' });
    ml(db, { clave: 'MLA41|', sku: 'FB-102', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);
    return { ganador: idDe(db, 101), otros: [idDe(db, 100), idDe(db, 102)] };
  }

  it('deja el código en el producto elegido y marca los demás incorrectos', () => {
    const { ganador, otros } = conflicto();
    const r = resolverConflictoIdentificador(db, '00602883701731', ganador, 'ana', 'el código es de este');

    expect(r).toMatchObject({ ok: true, ganador, descartados: 2 });
    expect(gtinDe(db, ganador)).toMatchObject([{ estado: 'activo' }]);
    for (const o of otros) expect(gtinDe(db, o)).toMatchObject([{ estado: 'incorrecto' }]);
    // El conflicto desaparece de la bandeja.
    expect(conflictosDeIdentificador(db)).toEqual([]);
  });

  it('no borra el descartado ni lo confunde con un histórico', () => {
    // `incorrecto` dice que el código nunca debió estar ahí y hay que corregirlo
    // en el canal; `historico` diría que alguna vez fue válido, y sería falso.
    const { ganador, otros } = conflicto();
    resolverConflictoIdentificador(db, '00602883701731', ganador, 'ana');

    const descartado = db.prepare("SELECT * FROM identificadores_producto WHERE producto_id=? AND tipo='gtin'").get(otros[0]);
    expect(descartado.estado).toBe('incorrecto');
    expect(descartado.resuelto_por).toBe('ana');
    expect(descartado.resuelto_en).toBeTruthy();
  });

  it('registra quién resolvió y por qué', () => {
    const { ganador } = conflicto();
    resolverConflictoIdentificador(db, '00602883701731', ganador, 'ana', 'catálogo lo confirmó');

    const h = db.prepare("SELECT * FROM identidad_historial WHERE evento='conflicto_gtin_resuelto'").get();
    expect(h.actor).toBe('ana');
    expect(JSON.parse(h.detalle_json)).toMatchObject({ ganador, motivo: 'catálogo lo confirmó' });
  });

  it('rechaza un producto que no reclama ese identificador', () => {
    const { ganador } = conflicto();
    const ajeno = ganador + 999;
    expect(resolverConflictoIdentificador(db, '00602883701731', ajeno, 'ana'))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    // Nada cambió: sigue en conflicto.
    expect(conflictosDeIdentificador(db)).toHaveLength(1);
  });

  it('rechaza resolver algo que no está en conflicto', () => {
    woo(db, { id: 110, sku: 'FB-110', gtin: '602883701731' });
    bootstrapProductosFusion(db);
    expect(resolverConflictoIdentificador(db, '00602883701731', idDe(db, 110), 'ana'))
      .toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(resolverConflictoIdentificador(db, '00000000000000', idDe(db, 110), 'ana'))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(resolverConflictoIdentificador(db, '', null, 'ana'))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('libera el índice único antes de activar al ganador', () => {
    // Si el ganador se activara primero, el índice parcial sobre estado='activo'
    // lo rechazaría mientras otra fila del mismo valor siguiera activa.
    const { ganador } = conflicto();
    expect(() => resolverConflictoIdentificador(db, '00602883701731', ganador, 'ana')).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE valor_normalizado='00602883701731' AND estado='activo'").get().n).toBe(1);
  });
});

describe('API de identificadores', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function appCon(nivel) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel }] };
      next();
    });
    app.use('/api/identidad-productos', identidadProductosRouter(db));
    return app;
  }

  function conflicto() {
    woo(db, { id: 120, sku: 'FB-120', gtin: '602883701731' });
    woo(db, { id: 121, sku: 'FB-121' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA50|', sku: 'FB-121', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);
  }

  it('expone los conflictos en el resumen', async () => {
    conflicto();
    const r = await request(appCon('read')).get('/api/identidad-productos/resumen');
    expect(r.status).toBe(200);
    expect(r.body.data.conflictos_gtin).toMatchObject([{ valor_normalizado: '00602883701731', productos: 2 }]);
  });

  it('resuelve el conflicto y deja de listarlo', async () => {
    conflicto();
    const app = appCon('write');
    const r = await request(app).post('/api/identidad-productos/identificadores/conflictos/resolver')
      .send({ valor_normalizado: '00602883701731', producto_id: idDe(db, 121), motivo: 'es de este' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, descartados: 1 });
    expect((await request(app).get('/api/identidad-productos/resumen')).body.data.conflictos_gtin).toEqual([]);
  });

  it('no deja resolver con permiso de sólo lectura', async () => {
    conflicto();
    const r = await request(appCon('read')).post('/api/identidad-productos/identificadores/conflictos/resolver')
      .send({ valor_normalizado: '00602883701731', producto_id: idDe(db, 121) });
    expect(r.status).toBe(403);
    expect(conflictosDeIdentificador(db)).toHaveLength(1);
  });

  it('reordena la prioridad de un producto', async () => {
    woo(db, { id: 130, sku: 'FB-130', gtin: '4524667220343' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA51|', sku: 'FB-130', gtin: '689228220348' });
    sembrarIdentificadoresMl(db);
    const id = idDe(db, 130);

    const r = await request(appCon('write')).put(`/api/identidad-productos/productos/${id}/identificadores/orden`)
      .send({ valores: ['00689228220348', '04524667220343'] });

    expect(r.status).toBe(200);
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('00689228220348');
  });

  it('rechaza una lista incompleta con 422 y no toca el orden', async () => {
    woo(db, { id: 131, sku: 'FB-131', gtin: '4524667220343' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA52|', sku: 'FB-131', gtin: '689228220348' });
    sembrarIdentificadoresMl(db);
    const id = idDe(db, 131);

    const app = appCon('write');
    expect((await request(app).put(`/api/identidad-productos/productos/${id}/identificadores/orden`)
      .send({ valores: ['00689228220348'] })).status).toBe(422);
    expect((await request(app).put(`/api/identidad-productos/productos/${id}/identificadores/orden`)
      .send({})).status).toBe(422);
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('04524667220343');
  });
});

describe('marcar un identificador como incorrecto', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('saca de la bandeja el identificador que no le corresponde al producto', () => {
    woo(db, { id: 140, sku: 'FB-140', gtin: '602883701731' });
    woo(db, { id: 141, sku: 'FB-141' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA60|', sku: 'FB-141', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);

    const r = marcarIdentificadorIncorrecto(db, idDe(db, 141), '00602883701731', 'ana', 'no es de este producto');
    expect(r).toMatchObject({ ok: true });
    expect(gtinDe(db, idDe(db, 141))).toMatchObject([{ estado: 'incorrecto' }]);
    expect(conflictosDeIdentificador(db)).toEqual([]);
  });

  it('protege al producto de quedarse sin identidad por accidente', () => {
    // Dejar un producto sin GTIN tiene que ser una decisión, no un efecto colateral.
    woo(db, { id: 142, sku: 'FB-142', gtin: '602883701731' });
    bootstrapProductosFusion(db);
    const id = idDe(db, 142);

    expect(marcarIdentificadorIncorrecto(db, id, '00602883701731', 'ana'))
      .toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(gtinDe(db, id)).toMatchObject([{ estado: 'activo' }]);

    // Con la confirmación explícita sí: es el caso de las bicicletas Venzo, que
    // no tienen código universal posible y deben quedar sin GTIN.
    expect(marcarIdentificadorIncorrecto(db, id, '00602883701731', 'ana', 'sin código posible', { permitirUnico: true }))
      .toMatchObject({ ok: true });
    expect(gtinDe(db, id)).toMatchObject([{ estado: 'incorrecto' }]);
  });

  it('deja marcar el activo cuando el producto conserva otro', () => {
    woo(db, { id: 143, sku: 'FB-143', gtin: '4524667220343' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA61|', sku: 'FB-143', gtin: '689228220348' });
    sembrarIdentificadoresMl(db);
    const id = idDe(db, 143);

    expect(marcarIdentificadorIncorrecto(db, id, '04524667220343', 'ana')).toMatchObject({ ok: true });
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('00689228220348');
  });

  it('registra quién y por qué, con el estado previo', () => {
    woo(db, { id: 144, sku: 'FB-144', gtin: '602883701731' });
    woo(db, { id: 145, sku: 'FB-145' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA62|', sku: 'FB-145', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);

    marcarIdentificadorIncorrecto(db, idDe(db, 145), '00602883701731', 'ana', 'GTIN ajeno');
    const h = db.prepare("SELECT * FROM identidad_historial WHERE evento='gtin_marcado_incorrecto'").get();
    expect(h.actor).toBe('ana');
    expect(JSON.parse(h.detalle_json)).toMatchObject({ motivo: 'GTIN ajeno', estado_previo: 'conflicto' });
  });

  it('rechaza un identificador que el producto no tiene', () => {
    woo(db, { id: 146, sku: 'FB-146' });
    bootstrapProductosFusion(db);
    expect(marcarIdentificadorIncorrecto(db, idDe(db, 146), '00602883701731', 'ana'))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('no revive un identificador ya marcado incorrecto', () => {
    woo(db, { id: 147, sku: 'FB-147', gtin: '602883701731' });
    woo(db, { id: 148, sku: 'FB-148' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA63|', sku: 'FB-148', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);
    const id = idDe(db, 148);

    marcarIdentificadorIncorrecto(db, id, '00602883701731', 'ana');
    expect(marcarIdentificadorIncorrecto(db, id, '00602883701731', 'ana'))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
