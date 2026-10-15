// Fase E-4: "envíos". Trabajo durable shipment.project: un aviso `shipments` de ML se relee y se aplica a Preparación solo si es el
// envío vigente de la orden. Decisiones de José (2026-10-15): cancelación con la preparación en curso, cambio de logística, chips.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarEnvioMl, procesarTrabajosRecurso } from '../routes/sync.js';
import { ensureTables, syncPedidosCache } from '../routes/preparacion.js';
import { registrarWebhookMl } from '../lib/workerIntegrationJobs.js';
import { encolarTrabajo } from '../lib/trabajosRecurso.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn(async () => ({ data: [] })) }));
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-shipment-project.${process.pid}.sqlite`;
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://x.test', ck: 'a', cs: 'b' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };

let db, ml;
const ts = () => new Date().toISOString();

function seedPrep(dbx, { orden = 'ORD-1', levantado = false, estado = 'en_preparacion' } = {}) {
  const p = dbx.prepare("INSERT INTO preparaciones (canal, clave, ml_order_id, estado, creado_en) VALUES ('ml', ?, ?, ?, ?)")
    .run(`ml:${orden}`, orden, estado, ts());
  dbx.prepare('INSERT INTO preparacion_items (preparacion_id, sku, nombre, cantidad_esperada, cantidad_escaneada) VALUES (?, ?, ?, 1, ?)')
    .run(p.lastInsertRowid, 'BIKE-001', 'Bici', levantado ? 1 : 0);
  return p.lastInsertRowid;
}
function seedGestion(dbx, orden = 'ORD-1', shipment = '555') {
  dbx.prepare("INSERT INTO gestion_pedidos (fuente, external_id, ml_shipment_id, importado_en, actualizado_en) VALUES ('mercadolibre', ?, ?, ?, ?)")
    .run(orden, shipment, ts(), ts());
}
const estadoPrep = (id) => db.prepare('SELECT estado FROM preparaciones WHERE id = ?').get(id).estado;
const incidente = (prefijo) => db.prepare('SELECT * FROM incidentes_operativos WHERE tipo_error LIKE ?').all(`${prefijo}%`);
const trabajo = (recurso) => db.prepare("SELECT * FROM trabajos_recurso WHERE tipo = 'shipment.project' AND recurso = ?").get(recurso);

function instalarMl({ envio, orden, items } = {}) {
  ml = {
    envio: { id: 555, status: 'ready_to_ship', substatus: 'ready_to_print', logistic_type: 'self_service', ...(envio || {}) },
    orden: { id: 'ORD-1', status: 'paid', shipping: { id: 555 }, order_items: [], ...(orden || {}) },
    items: items ?? [{ order_id: 'ORD-1' }],
    http: {}, gets: [],
  };
  mlFetch.mockImplementation(async (_db, _cfg, _m, path) => {
    ml.gets.push(path);
    if (/^\/shipments\/\d+\/items/.test(path)) return { status: ml.http.items ?? 200, data: ml.items, headers: {} };
    if (/^\/shipments\/\d+/.test(path)) return { status: ml.http.envio ?? 200, data: ml.envio, headers: {} };
    if (/^\/orders\//.test(path)) return { status: ml.http.orden ?? 200, data: ml.orden, headers: {} };
    return { status: 404, data: {}, headers: {} };
  });
}

beforeEach(() => { limpiarDb(); db = openDb(TEST_DB); ensureTables(db); mlFetch.mockReset(); });
afterEach(() => { db.close(); limpiarDb(); });

describe('E-4: envío cancelado con la preparación en curso', () => {
  it('con ítems levantados → devolución pendiente + incidente de aviso', async () => {
    const id = seedPrep(db, { levantado: true }); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'pack_splitted' } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r.estado).toBe('hecho');
    expect(estadoPrep(id)).toBe('cancelada_pendiente_devolucion');
    const inc = incidente('envio_cancelado_ORD-1');
    expect(inc).toHaveLength(1);
    expect(inc[0].severidad).toBe('advertencia');
  });

  it('sin ítems levantados → cancelada sin retiro + incidente de aviso', async () => {
    const id = seedPrep(db, { levantado: false }); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'pack_splitted' } });
    await procesarEnvioMl(db, CFG, '555');
    expect(estadoPrep(id)).toBe('cancelada_sin_retiro_registrado');
    expect(incidente('envio_cancelado_ORD-1')).toHaveLength(1);
  });

  it('closed_by_user (cambio de tipo de envío) espera sin cancelar', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'closed_by_user' } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r).toMatchObject({ estado: 'reencolar', diferido: true });
    expect(estadoPrep(id)).toBe('en_preparacion');
    expect(incidente('envio_cancelado_')).toHaveLength(0);
  });

  it('closed_by_user agotadas las esperas NO cancela: abre envio_cerrado_sin_resolver y deja la preparación', async () => {
    const id = seedPrep(db, { levantado: true }); seedGestion(db);
    encolarTrabajo(db, { tipo: 'shipment.project', recurso: '555' });
    db.prepare("UPDATE trabajos_recurso SET diferidos = 5 WHERE tipo = 'shipment.project' AND recurso = '555'").run();
    instalarMl({ envio: { status: 'cancelled', substatus: 'closed_by_user' } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r.estado).toBe('hecho');
    expect(estadoPrep(id)).toBe('en_preparacion');
    expect(incidente('envio_cerrado_sin_resolver_ORD-1')).toHaveLength(1);
    expect(incidente('envio_cancelado_')).toHaveLength(0);
  });

  it('closed_by_user con la orden cancelled lo resuelve la ruta de orden: el envío no toca la preparación', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'closed_by_user' }, orden: { status: 'cancelled' } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r.estado).toBe('hecho');
    expect(estadoPrep(id)).toBe('en_preparacion');
    expect(incidente('envio_')).toHaveLength(0);
  });

  it('closed_by_user con shipping.id nuevo en la orden procesa el envío nuevo', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'closed_by_user' }, orden: { shipping: { id: 888 } } });
    await procesarEnvioMl(db, CFG, '555');
    expect(estadoPrep(id)).toBe('en_preparacion');
    expect(trabajo('888')).toBeTruthy();
  });

  it('doble cancelled del mismo envío: una sola devolución y un solo incidente', async () => {
    const id = seedPrep(db, { levantado: true }); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'pack_splitted' } });
    await procesarEnvioMl(db, CFG, '555');
    await procesarEnvioMl(db, CFG, '555');
    expect(estadoPrep(id)).toBe('cancelada_pendiente_devolucion');
    expect(db.prepare('SELECT COUNT(*) AS n FROM preparacion_devoluciones WHERE preparacion_id = ?').get(id).n).toBe(1);
    expect(incidente('envio_cancelado_ORD-1')).toHaveLength(1);
  });

  it('un envío obsoleto (la orden ya tiene otro) no cancela y encola el vigente', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { status: 'cancelled', substatus: 'pack_splitted' }, orden: { shipping: { id: 777 } } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r.estado).toBe('hecho');
    expect(estadoPrep(id)).toBe('en_preparacion');
    expect(trabajo('777')).toBeTruthy();
  });
});

describe('E-4: cambio de logística', () => {
  it('sigue local → actualiza tipo y substatus sin frenar la preparación', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { logistic_type: 'self_service', substatus: 'printed' } });
    await procesarEnvioMl(db, CFG, '555');
    expect(estadoPrep(id)).toBe('en_preparacion');
    const c = db.prepare("SELECT logistic_type, substatus FROM pedidos_cache WHERE clave = 'ml:ORD-1'").get();
    expect(c).toMatchObject({ logistic_type: 'self_service', substatus: 'printed' });
    expect(incidente('envio_pasa_a_full_')).toHaveLength(0);
  });

  it('pasa a Full → sale de la cola + incidente de aviso', async () => {
    seedPrep(db); seedGestion(db);
    db.prepare("INSERT INTO pedidos_cache (clave, canal, ml_order_id, estado_envio, items_json, actualizado_en) VALUES ('ml:ORD-1', 'ml', 'ORD-1', 'pendiente', '[]', ?)").run(ts());
    instalarMl({ envio: { logistic_type: 'fulfillment' } });
    await procesarEnvioMl(db, CFG, '555');
    expect(db.prepare("SELECT estado_envio FROM pedidos_cache WHERE clave = 'ml:ORD-1'").get().estado_envio).toBe('no_elegible');
    expect(incidente('envio_pasa_a_full_ORD-1')).toHaveLength(1);
  });
});

describe('E-4: Full sin preparación en curso', () => {
  it('sale de la cola y avisa aunque no haya preparación', async () => {
    seedGestion(db);
    db.prepare("INSERT INTO pedidos_cache (clave, canal, ml_order_id, estado_envio, items_json, actualizado_en) VALUES ('ml:ORD-1', 'ml', 'ORD-1', 'pendiente', '[]', ?)").run(ts());
    instalarMl({ envio: { logistic_type: 'fulfillment' } });
    await procesarEnvioMl(db, CFG, '555');
    expect(incidente('envio_pasa_a_full_ORD-1')).toHaveLength(1);
  });
});

describe('E-4: ya salió, mapeo y errores', () => {
  it('envío shipped marca la preparación como enviada', async () => {
    const id = seedPrep(db); seedGestion(db);
    instalarMl({ envio: { status: 'shipped', substatus: null } });
    await procesarEnvioMl(db, CFG, '555');
    expect(estadoPrep(id)).not.toBe('en_preparacion');
  });

  it('sin fila en gestion_pedidos mapea por /shipments/{id}/items', async () => {
    seedPrep(db);
    instalarMl({ envio: { substatus: 'printed' } });
    const r = await procesarEnvioMl(db, CFG, '555');
    expect(r.estado).toBe('hecho');
    expect(ml.gets.some((p) => /\/shipments\/555\/items/.test(p))).toBe(true);
    expect(db.prepare("SELECT substatus FROM pedidos_cache WHERE clave = 'ml:ORD-1'").get()?.substatus).toBe('printed');
  });

  it('sin orden conocida difiere; agotadas las esperas cierra con aviso', async () => {
    instalarMl({ items: [] });
    expect(await procesarEnvioMl(db, CFG, '555')).toMatchObject({ estado: 'reencolar', diferido: true });
    expect(ml.gets.filter((p) => /^\/shipments\/555$/.test(p))).toHaveLength(0); // solo /items mientras queden reintentos
    encolarTrabajo(db, { tipo: 'shipment.project', recurso: '555' });
    db.prepare("UPDATE trabajos_recurso SET diferidos = 12 WHERE tipo = 'shipment.project' AND recurso = '555'").run();
    expect((await procesarEnvioMl(db, CFG, '555')).estado).toBe('hecho');
    expect(incidente('envio_sin_orden_555')).toHaveLength(1);
  });

  it('429 difiere, 404 cierra, 500 reintenta', async () => {
    seedGestion(db);
    instalarMl({}); ml.http.envio = 429;
    expect(await procesarEnvioMl(db, CFG, '555')).toMatchObject({ estado: 'reencolar', diferido: true });
    ml.http.envio = 404;
    expect((await procesarEnvioMl(db, CFG, '555')).estado).toBe('hecho');
    ml.http.envio = 500;
    expect(await procesarEnvioMl(db, CFG, '555')).toMatchObject({ estado: 'reencolar' });
  });
});

describe('E-4: volumen', () => {
  it('un aviso repetido con la misma firma no relee la orden', async () => {
    seedPrep(db); seedGestion(db);
    instalarMl({ envio: { substatus: 'printed' } });
    await procesarEnvioMl(db, CFG, '555');
    const ordenes = () => ml.gets.filter((p) => p.startsWith('/orders/')).length;
    expect(ordenes()).toBe(1);
    await procesarEnvioMl(db, CFG, '555');
    expect(ordenes()).toBe(1);
    ml.envio.substatus = 'delayed';
    await procesarEnvioMl(db, CFG, '555');
    expect(ordenes()).toBe(2);
  });
});

describe('E-4: carrera con syncPedidosCache', () => {
  it('un volcado que arrancó antes no repone en la cola un envío que el webhook retiró', async () => {
    seedPrep(db); seedGestion(db);
    db.prepare("INSERT INTO pedidos_cache (clave, canal, ml_order_id, estado_envio, items_json, actualizado_en) VALUES ('ml:ORD-1', 'ml', 'ORD-1', 'pendiente', '[]', ?)").run(ts());
    const woo = (await import('../routes/woo.js')).wooFetch;
    woo.mockResolvedValue({ data: [] });
    instalarMl({});
    const base = mlFetch.getMockImplementation();
    let reentrando = false;
    mlFetch.mockImplementation(async (d, c, m, path, ...resto) => {
      if (path.startsWith('/orders/search')) {
        return { status: 200, data: { results: [{ id: 'ORD-1', status: 'paid', date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 555 }, order_items: [] }], paging: { total: 1 } }, headers: {} };
      }
      if (path === '/shipments/555' && !reentrando) {
        // El barrido lee el envío (todavía ready_to_ship) y, ANTES de volcar, llega el webhook con el envío cancelado.
        reentrando = true;
        const lecturaVieja = { status: 200, data: { id: 555, status: 'ready_to_ship', logistic_type: 'self_service' }, headers: {} };
        ml.envio = { id: 555, status: 'cancelled', substatus: 'pack_splitted', logistic_type: 'self_service' };
        await procesarEnvioMl(db, CFG, '555');
        return lecturaVieja;
      }
      return base(d, c, m, path, ...resto);
    });
    await syncPedidosCache(db, { ...CFG, andreaniStatus: 'lpaandreani', enviadoAndreaniStatus: 'enviadoandreani' });
    expect(db.prepare("SELECT estado_envio FROM pedidos_cache WHERE clave = 'ml:ORD-1'").get().estado_envio).toBe('no_elegible');
  });
});

describe('E-4: webhook y dedupe por recurso', () => {
  const aviso = (id, n) => ({ topic: 'shipments', resource: `/shipments/${id}`, user_id: 99999, application_id: 1, sent: ts(), attempts: 1, received: ts(), _id: `n-${n}` });

  it('el aviso encola UN trabajo por envío aunque lleguen varios', () => {
    registrarWebhookMl(db, aviso(555, 1));
    registrarWebhookMl(db, aviso(555, 2));
    registrarWebhookMl(db, aviso(556, 3));
    expect(db.prepare("SELECT COUNT(*) AS n FROM trabajos_recurso WHERE tipo = 'shipment.project'").get().n).toBe(2);
    expect(trabajo('555')).toBeTruthy();
  });

  it('el worker procesa el trabajo y lo cierra', async () => {
    seedPrep(db); seedGestion(db);
    instalarMl({});
    registrarWebhookMl(db, aviso(555, 1));
    await procesarTrabajosRecurso(db, CFG);
    expect(trabajo('555')?.estado).toBe('hecho');
  });
});
