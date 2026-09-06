import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import {
  archivarIdentidadesMlHuerfanas, auditarIdentidadProductos, bootstrapProductosFusion, clavesAfectadasPorBajaWoo,
  clavesEsperandoProteccion, conciliacionIdentidad, procesarOperacionesIdentidad, protegerPorBajaWoo,
} from '../lib/identidadProductos.js';

const FILE = './test/tmp-proteccion-woo.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';

function woo(db, { id, sku, stock = 3 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
    VALUES (?,?,?,'simple',?,?)`).run(id, `Producto ${id}`, sku, stock, ISO);
}

function ml(db, { clave, sku, stock = 2, status = 'active', canales = '["marketplace"]' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,canales_json,actualizado_en)
    VALUES (?,?,'','Publicación',?,?,1,?,?,?)`)
    .run(clave, clave.split('|')[0], status, sku, stock, canales, ISO);
}

// `pedidos_cache` la crea el router de preparación, no el esquema base: se replica acá para
// poder probar la retención de verdad en vez de saltearla.
function crearPedidosCache(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
    clave TEXT PRIMARY KEY, canal TEXT, ml_order_id TEXT, wc_order_id INTEGER,
    items_json TEXT, actualizado_en TEXT)`).run();
}

function pedidoMl(db, { orderId, sku, wcOrderId = 0 }) {
  crearPedidosCache(db);
  db.prepare(`INSERT INTO pedidos_cache (clave,canal,ml_order_id,wc_order_id,items_json,actualizado_en)
    VALUES (?, 'ml', ?, ?, ?, ?)`)
    .run('ml-' + orderId, String(orderId), wcOrderId, JSON.stringify([{ sku, cantidad: 1 }]), ISO);
  db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id,wc_order_id,creado_en) VALUES (?,?,?)')
    .run(String(orderId), wcOrderId, ISO);
}

const idDe = (db, idWoo) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(idWoo).id;

describe('protección Woo→ML: la mitad que no escribe en ML', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('exige que la baja esté confirmada antes de tocar nada', () => {
    // Un webhook espurio o una lectura a medias retendría pedidos de productos vivos.
    woo(db, { id: 10, sku: 'FB-10' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA1|', sku: 'FB-10' });

    expect(protegerPorBajaWoo(db, { idWoo: 10, sku: 'FB-10' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(clavesEsperandoProteccion(db)).toEqual([]);
  });

  it('abre un caso woo_ml crítico por cada clave ML afectada', () => {
    woo(db, { id: 11, sku: 'FB-11' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA2|', sku: 'FB-11', stock: 5 });

    const r = protegerPorBajaWoo(db, { idWoo: 11, sku: 'FB-11', confirmado: true }, 'ana');
    expect(r).toMatchObject({ ok: true, claves: 1, casos: 1, operaciones: 1 });

    const caso = db.prepare("SELECT * FROM identidad_casos WHERE direccion='woo_ml'").get();
    expect(caso).toMatchObject({ ml_key: 'MLA2|', estado: 'urgente', severidad: 'critica', clasificacion: 'baja_woo' });
    expect(clavesEsperandoProteccion(db)).toHaveLength(1);
  });

  it('encuentra la publicación por SKU aunque nunca se haya verificado su identidad', () => {
    // La identidad activa cubre lo que Fusion verificó; una publicación puede llevar el SKU sin
    // haber llegado nunca a verificarse, y es justo la que nadie miró.
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA3|', sku: 'HUERFANO-1' });

    expect(clavesAfectadasPorBajaWoo(db, { sku: 'HUERFANO-1' })).toHaveLength(1);
    expect(protegerPorBajaWoo(db, { sku: 'HUERFANO-1', confirmado: true })).toMatchObject({ claves: 1, casos: 1 });
  });

  it('ignora los links de pago de Mercado Pago', () => {
    // No se venden por el marketplace: no hay stock que proteger ni preparación que frenar.
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA4|', sku: 'MP-1', canales: '["mp-merchants","mp-link"]' });

    expect(clavesAfectadasPorBajaWoo(db, { sku: 'MP-1' })).toEqual([]);
  });

  it('retiene los pedidos que todavía no bajaron a Woo', () => {
    woo(db, { id: 12, sku: 'FB-12' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA5|', sku: 'FB-12' });
    pedidoMl(db, { orderId: 5001, sku: 'FB-12' });

    const r = protegerPorBajaWoo(db, { idWoo: 12, sku: 'FB-12', confirmado: true });
    expect(r.pedidos_retenidos).toBe(1);
    const ret = db.prepare("SELECT * FROM guardia_ml_pedidos_retenidos WHERE estado='retenido'").get();
    expect(ret).toMatchObject({ ml_order_id: '5001', motivo: 'baja_woo' });
  });

  it('no retiene un pedido ya sincronizado a Woo', () => {
    // El cliente compró y la unidad salió: retenerlo no devuelve nada y frena una preparación.
    woo(db, { id: 13, sku: 'FB-13' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA6|', sku: 'FB-13' });
    pedidoMl(db, { orderId: 5002, sku: 'FB-13', wcOrderId: 777 });

    expect(protegerPorBajaWoo(db, { idWoo: 13, sku: 'FB-13', confirmado: true }).pedidos_retenidos).toBe(0);
  });

  it('es idempotente: el mismo webhook repetido no duplica casos ni retenciones', () => {
    // Los webhooks de Woo llegan repetidos con normalidad.
    woo(db, { id: 14, sku: 'FB-14' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA7|', sku: 'FB-14' });
    pedidoMl(db, { orderId: 5003, sku: 'FB-14' });

    const primera = protegerPorBajaWoo(db, { idWoo: 14, sku: 'FB-14', confirmado: true });
    const segunda = protegerPorBajaWoo(db, { idWoo: 14, sku: 'FB-14', confirmado: true });

    expect(primera).toMatchObject({ casos: 1, pedidos_retenidos: 1 });
    expect(segunda).toMatchObject({ casos: 0, pedidos_retenidos: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE direccion='woo_ml'").get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_pedidos_retenidos').get().n).toBe(1);
  });

  it('no inventa trabajo cuando no hay ninguna publicación viva', () => {
    woo(db, { id: 15, sku: 'FB-15' });
    bootstrapProductosFusion(db);
    expect(protegerPorBajaWoo(db, { idWoo: 15, sku: 'FB-15', confirmado: true }))
      .toEqual({ ok: true, claves: 0, casos: 0, operaciones: 0, pedidos_retenidos: 0 });
  });

  it('ordena por stock expuesto: primero lo que más se puede vender sin tener', () => {
    woo(db, { id: 16, sku: 'FB-16' });
    woo(db, { id: 17, sku: 'FB-17' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA8|', sku: 'FB-16', stock: 1 });
    ml(db, { clave: 'MLA9|', sku: 'FB-17', stock: 9 });
    protegerPorBajaWoo(db, { idWoo: 16, sku: 'FB-16', confirmado: true });
    protegerPorBajaWoo(db, { idWoo: 17, sku: 'FB-17', confirmado: true });

    expect(clavesEsperandoProteccion(db).map((x) => x.ml_key)).toEqual(['MLA9|', 'MLA8|']);
  });
});

describe('protección Woo→ML: la operación remota', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function conProteccion() {
    woo(db, { id: 30, sku: 'FB-30' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA30|', sku: 'FB-30', stock: 4 });
    return protegerPorBajaWoo(db, { idWoo: 30, sku: 'FB-30', confirmado: true });
  }

  it('nace en shadow mientras las escrituras remotas estén apagadas', () => {
    // Desplegar esto no enciende nada por sí solo.
    db.prepare("UPDATE identidad_config SET modo='shadow', escrituras_remotas_habilitadas=0 WHERE id=1").run();
    conProteccion();
    const op = db.prepare("SELECT * FROM identidad_operaciones WHERE tipo='proteccion_woo'").get();
    expect(op).toMatchObject({ estado: 'shadow', paso_actual: 'zero', stock_objetivo: 0 });
    expect(op.sku_objetivo).toBeNull();
    expect(op.decision_id).toBeNull();
  });

  it('queda pendiente cuando las escrituras están habilitadas', () => {
    db.prepare("UPDATE identidad_config SET modo='enforced', escrituras_remotas_habilitadas=1 WHERE id=1").run();
    conProteccion();
    expect(db.prepare("SELECT estado FROM identidad_operaciones WHERE tipo='proteccion_woo'").get().estado).toBe('pendiente');
  });

  it('el esquema rechaza una corrección de SKU sin decisión ni objetivo', () => {
    // El invariante vive en la base: una corrección sin decisión sería una escritura remota
    // que nadie pidió, que es lo que la saga existe para evitar.
    woo(db, { id: 31, sku: 'FB-31' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA31|', sku: 'FB-31' });
    protegerPorBajaWoo(db, { idWoo: 31, sku: 'FB-31', confirmado: true });
    expect(() => db.prepare("UPDATE identidad_operaciones SET tipo='correccion_sku' WHERE tipo='proteccion_woo'").run())
      .toThrow();
  });

  it('el worker no la toca con las escrituras apagadas', async () => {
    db.prepare("UPDATE identidad_config SET modo='shadow', escrituras_remotas_habilitadas=0 WHERE id=1").run();
    conProteccion();
    const r = await procesarOperacionesIdentidad(db, { setStock: async () => { throw new Error('no debería escribir'); } });
    expect(r).toMatchObject({ omitido: 'escrituras_remotas_deshabilitadas', procesadas: 0 });
  });

  it('pone stock cero, lo verifica contra ML y cierra el caso', async () => {
    db.prepare("UPDATE identidad_config SET modo='enforced', escrituras_remotas_habilitadas=1, lote_max=1 WHERE id=1").run();
    conProteccion();
    const escrituras = [];
    const adapter = {
      setStock: async (clave, cantidad) => { escrituras.push([clave, cantidad]); return { ok: true }; },
      // `observed_at` es obligatorio: el ejecutor sólo da por buena una lectura fresca,
      // así que un mock sin fecha se comporta como una respuesta ambigua y no confirma.
      read: async () => ({ ok: true, stock: 0, seller_sku: 'FB-30', observed_at: new Date().toISOString() }),
    };
    await procesarOperacionesIdentidad(db, adapter);

    expect(escrituras).toEqual([['MLA30|', 0]]);
    const op = db.prepare("SELECT * FROM identidad_operaciones WHERE tipo='proteccion_woo'").get();
    expect(op.estado).toBe('completada');
    expect(db.prepare("SELECT estado FROM identidad_casos WHERE direccion='woo_ml'").get().estado).toBe('verificado');
  });

  it('no cierra el caso si ML no confirma el cero', async () => {
    db.prepare("UPDATE identidad_config SET modo='enforced', escrituras_remotas_habilitadas=1, lote_max=1 WHERE id=1").run();
    conProteccion();
    const adapter = {
      setStock: async () => ({ ok: true }),
      read: async () => ({ ok: true, stock: 4, seller_sku: 'FB-30', observed_at: new Date().toISOString() }),
    };
    await procesarOperacionesIdentidad(db, adapter);
    await procesarOperacionesIdentidad(db, adapter);

    const op = db.prepare("SELECT * FROM identidad_operaciones WHERE tipo='proteccion_woo'").get();
    expect(op.estado).not.toBe('completada');
    expect(db.prepare("SELECT estado FROM identidad_casos WHERE direccion='woo_ml'").get().estado).not.toBe('verificado');
  });

  it('respeta el canario: no toca claves fuera de la lista', async () => {
    db.prepare("UPDATE identidad_config SET modo='enforced', escrituras_remotas_habilitadas=1, canario_ml_key='OTRA|' WHERE id=1").run();
    conProteccion();
    const adapter = { setStock: async () => { throw new Error('no debería escribir'); }, read: async () => ({ ok: true, stock: 0 }) };
    const r = await procesarOperacionesIdentidad(db, adapter);
    expect(r.procesadas ?? 0).toBe(0);
  });
});

describe('contador humano separado del trabajo del worker', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('un caso ya decidido, esperando al worker, no cuenta como trabajo humano', () => {
    // Antes `urgentes` incluía `pendiente`, así que el contador decía que había más trabajo
    // del que la cola mostraba: alguien veía un número y no encontraba qué hacer.
    woo(db, { id: 40, sku: 'FB-40' });
    bootstrapProductosFusion(db);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,canales_json,atributos_json,actualizado_en)
      VALUES ('MLA40|','MLA40','','Publicación','active','FB-40',1,3,'["marketplace"]','[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'sistema', { lecturaConfiable: true });

    const caso = db.prepare("SELECT id FROM identidad_casos WHERE ml_key='MLA40|'").get();
    db.prepare("UPDATE identidad_casos SET estado='pendiente' WHERE id=?").run(caso.id);

    const c = conciliacionIdentidad(db);
    expect(c.esperando_operacion).toBe(1);
    expect(c.urgentes).toBe(0);
  });

  it('el gate de conciliación sigue exigiendo que toda clave esté en alguna categoría', () => {
    // Sacar `pendiente` de urgentes sin sumarlo aparte dejaría un agujero por el que el
    // tablero anunciaría "conciliado" con casos sin resolver.
    woo(db, { id: 41, sku: 'FB-41' });
    bootstrapProductosFusion(db);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,canales_json,atributos_json,actualizado_en)
      VALUES ('MLA41|','MLA41','','Publicación','active','FB-41',1,3,'["marketplace"]','[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'sistema', { lecturaConfiable: true });
    db.prepare("UPDATE identidad_casos SET estado='pendiente' WHERE ml_key='MLA41|'").run();

    const c = conciliacionIdentidad(db);
    expect(c.auditadas).toBe(c.verificadas + c.excepciones + c.urgentes + c.esperando_operacion);
    expect(c.conciliado).toBe(true);
  });
});

describe('archivado de identidades ML huérfanas', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function identidadMl(db2, clave, productoId) {
    db2.prepare(`INSERT INTO identidades_canal
      (producto_id,canal,external_key,activa,observado_en,evidencia_fingerprint,creado_en,actualizado_en)
      VALUES (?,'ml',?,1,?,'fp',?,?)`).run(productoId, clave, ISO, ISO, ISO);
  }

  it('exige lectura confiable: con un scan acotado archivaría identidades vivas', () => {
    // El criterio es «no está en el cache», así que sin scan completo lo que falta puede ser
    // simplemente lo que no se leyó esta vez.
    woo(db, { id: 50, sku: 'FB-50' });
    bootstrapProductosFusion(db);
    identidadMl(db, 'MLA50|', idDe(db, 50));

    expect(archivarIdentidadesMlHuerfanas(db)).toMatchObject({ ok: false, code: 'LECTURA_NO_CONFIABLE', archivadas: 0 });
    expect(db.prepare("SELECT activa FROM identidades_canal WHERE canal='ml'").get().activa).toBe(1);
  });

  it('archiva la identidad cuya publicación ya no existe', () => {
    woo(db, { id: 51, sku: 'FB-51' });
    bootstrapProductosFusion(db);
    identidadMl(db, 'MLA51|', idDe(db, 51));

    expect(archivarIdentidadesMlHuerfanas(db, { lecturaConfiable: true })).toMatchObject({ ok: true, archivadas: 1 });
    const i = db.prepare("SELECT * FROM identidades_canal WHERE canal='ml'").get();
    expect(i.activa).toBe(0);
    expect(i.archivado_en).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='identidad_ml_archivada'").get().n).toBe(1);
  });

  it('no toca la identidad cuya publicación sigue en el cache', () => {
    woo(db, { id: 52, sku: 'FB-52' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA52|', sku: 'FB-52' });
    identidadMl(db, 'MLA52|', idDe(db, 52));

    expect(archivarIdentidadesMlHuerfanas(db, { lecturaConfiable: true })).toMatchObject({ archivadas: 0 });
    expect(db.prepare("SELECT activa FROM identidades_canal WHERE canal='ml'").get().activa).toBe(1);
  });

  it('no borra: deja la fila archivada para que la reactivación pueda recuperarla', () => {
    woo(db, { id: 53, sku: 'FB-53' });
    bootstrapProductosFusion(db);
    identidadMl(db, 'MLA53|', idDe(db, 53));
    archivarIdentidadesMlHuerfanas(db, { lecturaConfiable: true });

    expect(db.prepare("SELECT COUNT(*) n FROM identidades_canal WHERE canal='ml'").get().n).toBe(1);
  });
});
