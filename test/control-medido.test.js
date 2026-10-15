// Fase E-3: control medido. Tres métricas por separado: entregas fallidas (missed_feeds + monitor de webhooks Woo),
// trabajos no terminados y diferencias del barrido. ML y Woo simulados: nunca se toca la red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { encolarTrabajo, cerrarTrabajo, reclamarTrabajos } from '../lib/trabajosRecurso.js';
import { syncWcToMl, reconciliarStockMl } from '../routes/sync.js';
import { reinyectarMissedFeeds } from '../lib/missedFeedsMl.js';
import { evaluarWebhooksWoo, alertaMissedFeedsDiaria, vigilarTrabajosNoTerminados } from '../lib/controlMedido.js';
import { registrarCorrida, evaluarBarridosDiario, frecuenciaBarridoRevertida, resumenBarridos } from '../lib/barridoCorridas.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-control-medido.${process.pid}.sqlite`;
const ML = { clientId: '123456', clientSecret: 'cs', userId: '99999' };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
const haceMin = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
let db;
const fin0 = () => new Date().toISOString();

beforeEach(() => { limpiarDb(); db = openDb(TEST_DB); mlFetch.mockReset(); });
afterEach(() => { db.close(); limpiarDb(); });

const incidente = (tipo) => db.prepare("SELECT * FROM incidentes_operativos WHERE tipo_error = ? AND estado = 'activo'").get(tipo);
const aviso = (n, over = {}) => ({ _id: `n-${n}`, topic: 'orders_v2', resource: `/orders/${1000 + n}`, user_id: 99999, application_id: 1, attempts: 8, ...over });

describe('migración 131', () => {
  it('crea las tablas y la columna sin_cerrar_desde', () => {
    for (const t of ['missed_feeds_corridas', 'barrido_corridas', 'barrido_estado']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
    expect(db.prepare('PRAGMA table_info(trabajos_recurso)').all().map((c) => c.name)).toContain('sin_cerrar_desde');
  });

  it('sin_cerrar_desde se fija al encolar, se conserva al reencolar y se limpia al cerrar', () => {
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:A' });
    const a = db.prepare("SELECT sin_cerrar_desde FROM trabajos_recurso WHERE recurso='sku:A'").get().sin_cerrar_desde;
    expect(a).toBeTruthy();
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:A' });
    expect(db.prepare("SELECT sin_cerrar_desde FROM trabajos_recurso WHERE recurso='sku:A'").get().sin_cerrar_desde).toBe(a);
    const [t] = reclamarTrabajos(db, ['stock.bolsa'], { limit: 5 });
    cerrarTrabajo(db, t, 'hecho');
    const fila = db.prepare("SELECT estado, sin_cerrar_desde, dirty FROM trabajos_recurso WHERE recurso='sku:A'").get();
    if (fila.estado === 'hecho') expect(fila.sin_cerrar_desde).toBeNull();
  });
});

describe('missed_feeds de ML', () => {
  it('pide app_id y site_id (items) desde offset 0 y reinyecta como recibo durable', async () => {
    mlFetch.mockImplementation(async (_db, _cfg, _m, ruta) => {
      if (ruta.includes('topic=orders_v2')) return { status: 200, data: { messages: [aviso(1), aviso(2)], total: 2 } };
      if (ruta.includes('topic=items')) return { status: 200, data: { messages: [{ _id: 'i-1', topic: 'items', resource: '/items/MLA500', user_id: 99999 }], total: 1 } };
      return { status: 200, data: { messages: [], total: 0 } };
    });
    const r = await reinyectarMissedFeeds(db, ML);
    const rutas = mlFetch.mock.calls.map((c) => c[3]);
    expect(rutas.every((x) => x.includes('app_id=123456'))).toBe(true);
    expect(rutas.find((x) => x.includes('topic=items'))).toContain('site_id=MLA');
    expect(rutas.find((x) => x.includes('topic=orders_v2'))).toContain('offset=0');
    expect(r.topicos.find((t) => t.topic === 'orders_v2').nuevos).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo='order.ml'").get().n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo='item.project'").get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM missed_feeds_corridas').get().n).toBe(4);
  });

  it('es idempotente: repetir la ronda no duplica (el fingerprint incluye el _id)', async () => {
    mlFetch.mockImplementation(async (_d, _c, _m, ruta) => ({ status: 200, data: { messages: ruta.includes('topic=orders_v2') ? [aviso(1)] : [], total: ruta.includes('topic=orders_v2') ? 1 : 0 } }));
    await reinyectarMissedFeeds(db, ML, { topicos: ['orders_v2'] });
    const r2 = await reinyectarMissedFeeds(db, ML, { topicos: ['orders_v2'] });
    expect(r2.topicos[0]).toMatchObject({ nuevos: 0, duplicados: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo='order.ml'").get().n).toBe(1);
  });

  it('pagina desde 0 y deduplica por _id entre páginas', async () => {
    const paginas = [[aviso(1), aviso(2)], [aviso(2), aviso(3)], []];
    let i = 0;
    mlFetch.mockImplementation(async () => ({ status: 200, data: { messages: paginas[i++] || [], total: 99 } }));
    const r = await reinyectarMissedFeeds(db, ML, { topicos: ['orders_v2'] });
    expect(r.topicos[0].enumerados).toBe(3);
    expect(mlFetch.mock.calls[0][3]).toContain('offset=0');
    expect(mlFetch.mock.calls[1][3]).toContain('offset=2');
  });

  it('un 429 corta toda la ronda sin reintentar ni consultar más tópicos', async () => {
    mlFetch.mockResolvedValue({ status: 429, data: {} });
    const r = await reinyectarMissedFeeds(db, ML);
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(r.topicos[0].error).toBe('HTTP_429');
  });

  it('excluye avisos de otra cuenta, sin _id o con recurso ilegible', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: { messages: [aviso(1, { user_id: 5 }), aviso(2, { _id: '' }), aviso(3, { resource: '/x' }), aviso(4)], total: 4 } });
    const r = await reinyectarMissedFeeds(db, ML, { topicos: ['orders_v2'] });
    expect(r.topicos[0]).toMatchObject({ excluidos: 3, nuevos: 1 });
  });

  it('al llegar al tope de páginas abre un incidente de advertencia con el conteo (sin subir el tope)', async () => {
    let n = 0;
    mlFetch.mockImplementation(async () => ({ status: 200, data: { messages: [aviso(++n)], total: 99999 } }));
    const r = await reinyectarMissedFeeds(db, ML, { topicos: ['orders_v2'] });
    expect(mlFetch).toHaveBeenCalledTimes(20);
    expect(r.topicos[0].tope).toBe(true);
    const inc = incidente('ml_missed_feeds_tope_orders_v2');
    expect(inc.severidad).toBe('advertencia');
    expect(inc.mensaje_humano).toContain('20 enumerados');
  });

  it('sin credenciales de ML no llama a nadie', async () => {
    const r = await reinyectarMissedFeeds(db, { clientId: '', userId: '' });
    expect(r.omitido).toBe(true);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});

describe('alerta diaria de missed_feeds', () => {
  const ronda = (nuevos, fin = new Date().toISOString()) => db.prepare(`INSERT INTO missed_feeds_corridas (inicio, fin, topic, enumerados, nuevos) VALUES (?, ?, 'orders_v2', ?, ?)`).run(fin, fin, nuevos, nuevos);
  it('abre advertencia si hubo faltantes y se cierra cuando deja de haberlos', () => {
    ronda(3);
    alertaMissedFeedsDiaria(db);
    expect(incidente('ml_missed_feeds_diario')?.severidad).toBe('advertencia');
    alertaMissedFeedsDiaria(db, { ahoraMs: Date.now() + 25 * 3600 * 1000 });
    // sin rondas en 24 h también avisa (el cron horario no corre)
    expect(incidente('ml_missed_feeds_diario')).toBeTruthy();
    ronda(0, new Date(Date.now() + 25 * 3600 * 1000).toISOString());
    alertaMissedFeedsDiaria(db, { ahoraMs: Date.now() + 26 * 3600 * 1000 });
    expect(incidente('ml_missed_feeds_diario')).toBeFalsy();
  });
});

describe('alerta diaria con todas las consultas fallidas', () => {
  it('abre/mantiene la advertencia con el conteo y no cierra el incidente', () => {
    const fin = new Date().toISOString();
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO missed_feeds_corridas (inicio, fin, topic, error) VALUES (?, ?, 'orders_v2', 'HTTP_500')").run(fin, fin);
    alertaMissedFeedsDiaria(db);
    const inc = incidente('ml_missed_feeds_diario');
    expect(inc.severidad).toBe('advertencia');
    expect(inc.mensaje_humano).toContain('3 consultas');
    alertaMissedFeedsDiaria(db);
    expect(incidente('ml_missed_feeds_diario')).toBeTruthy();
    // con una consulta sana y sin faltantes, se cierra
    db.prepare("INSERT INTO missed_feeds_corridas (inicio, fin, topic) VALUES (?, ?, 'orders_v2')").run(fin, fin);
    alertaMissedFeedsDiaria(db);
    expect(incidente('ml_missed_feeds_diario')).toBeFalsy();
  });
});

describe('monitor de webhooks de Woo', () => {
  it('tienda sin webhooks (listado vacío válido): denuncia los 8 ausentes', () => {
    db.prepare("INSERT INTO woo_webhooks_estado (id, topic, status, delivery_url, propio, visto_en, status_desde) VALUES (1,'order.updated','active','https://herramientas.fusionbikes.com.ar/api/woo/webhook/order',1,?,?)").run(fin0(), fin0());
    db.prepare('DELETE FROM woo_webhooks_estado').run(); // lo que hace refrescarWebhooksWoo con 200 []
    expect(evaluarWebhooksWoo(db).ausentes).toHaveLength(8);
  });
  const HOST = 'https://herramientas.fusionbikes.com.ar/api/woo/webhook';
  const esperados = [['order.created', 'order'], ['order.updated', 'order'], ['order.deleted', 'order'], ['order.restored', 'order'],
    ['product.created', 'product'], ['product.updated', 'product'], ['product.deleted', 'product'], ['product.restored', 'product']];
  const sembrar = (cambios = {}) => {
    db.prepare('DELETE FROM woo_webhooks_estado').run();
    esperados.forEach(([topic, ruta], i) => {
      if (cambios[topic] === null) return;
      db.prepare('INSERT INTO woo_webhooks_estado (id, topic, status, delivery_url, propio, visto_en, status_desde) VALUES (?,?,?,?,1,?,?)')
        .run(i + 1, topic, cambios[topic] || 'active', `${HOST}/${ruta}`, new Date().toISOString(), new Date().toISOString());
    });
  };
  it('todos activos: sin incidente', () => { sembrar(); expect(evaluarWebhooksWoo(db).ok).toBe(true); expect(incidente('woo_webhooks_no_activos')).toBeFalsy(); });
  it('uno pausado o deshabilitado abre un incidente crítico y NO se reactiva', () => {
    sembrar({ 'order.updated': 'disabled', 'product.created': 'paused' });
    const r = evaluarWebhooksWoo(db);
    expect(r.caidos).toHaveLength(2);
    expect(incidente('woo_webhooks_no_activos').severidad).toBe('critico');
    expect(db.prepare("SELECT status FROM woo_webhooks_estado WHERE topic='order.updated'").get().status).toBe('disabled');
  });
  it('uno ausente abre incidente, y se cierra al aparecer activo', () => {
    sembrar({ 'product.restored': null });
    expect(evaluarWebhooksWoo(db).ausentes).toEqual([{ topic: 'product.restored', ruta: '/api/woo/webhook/product' }]);
    expect(incidente('woo_webhooks_no_activos')).toBeTruthy();
    sembrar();
    evaluarWebhooksWoo(db);
    expect(incidente('woo_webhooks_no_activos')).toBeFalsy();
  });
  it('un webhook activo contra otra ruta no cubre al esperado', () => {
    sembrar();
    db.prepare("UPDATE woo_webhooks_estado SET delivery_url = ? WHERE topic='order.deleted'").run(`${HOST}/otro`);
    expect(evaluarWebhooksWoo(db).ausentes.map((a) => a.topic)).toEqual(['order.deleted']);
  });
});

describe('trabajos no terminados', () => {
  it('una generación sin cerrar > 15 min abre un incidente agregado; una reciente no', () => {
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:NUEVO' });
    expect(vigilarTrabajosNoTerminados(db).total).toBe(0);
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:VIEJO' });
    db.prepare("UPDATE trabajos_recurso SET sin_cerrar_desde = ? WHERE recurso = 'sku:VIEJO'").run(haceMin(30));
    expect(vigilarTrabajosNoTerminados(db).total).toBe(1);
    expect(incidente('trabajos_sin_terminar').severidad).toBe('critico');
    db.prepare("UPDATE trabajos_recurso SET estado='hecho', sin_cerrar_desde=NULL WHERE recurso='sku:VIEJO'").run();
    vigilarTrabajosNoTerminados(db);
    expect(incidente('trabajos_sin_terminar')).toBeFalsy();
  });

  it('un reencolado no reinicia el reloj de la generación sin cerrar', () => {
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:R' });
    db.prepare("UPDATE trabajos_recurso SET sin_cerrar_desde = ? WHERE recurso = 'sku:R'").run(haceMin(40));
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:R' });
    expect(vigilarTrabajosNoTerminados(db).total).toBe(1);
  });

  it('no duplica lo que ya cubre trabajo_muerto / falla_persistente / diferido_largo', () => {
    for (const [prefijo, rec] of [['trabajo_muerto', 'sku:A'], ['trabajo_falla_persistente', 'sku:B'], ['trabajo_diferido_largo', 'sku:C']]) {
      encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: rec });
      db.prepare('UPDATE trabajos_recurso SET sin_cerrar_desde = ? WHERE recurso = ?').run(haceMin(60), rec);
      db.prepare(`INSERT INTO incidentes_operativos (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_humano, contador_repeticiones, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
        VALUES ('mercadolibre','trabajos_recurso',?,?, 'critico','activo','x',1,?,?,?,?)`).run(`${prefijo}_stock.bolsa_${rec}`, `k-${rec}`, haceMin(1), haceMin(1), haceMin(1), haceMin(1));
    }
    expect(vigilarTrabajosNoTerminados(db).total).toBe(0);
  });

  it('dead-letters: los anteriores a la marca de agua no cuentan; los posteriores cuentan SIN vencimiento', () => {
    const ev = (id) => db.prepare("INSERT INTO integration_events (event_id, event_type, channel, source, resource_id, status, received_at, correlation_id, dedupe_key) VALUES (?,'x','ml','webhook','/orders/1','dead_lettered',?, ?, ?)").run(id, haceMin(5), `c${id}`, `d${id}`);
    ev('hist'); ev('nuevo');
    db.prepare("INSERT INTO integration_jobs (event_id, job_type, available_at, status) VALUES ('hist','message.project',?, 'dead_lettered')").run(haceMin(60 * 24 * 40));
    expect(vigilarTrabajosNoTerminados(db).total).toBe(0); // primera corrida: fija la marca, el histórico no abre incidente
    expect(incidente('trabajos_sin_terminar')).toBeFalsy();
    const marca = db.prepare("SELECT valor FROM sync_estado WHERE clave='e3_dead_letter_marca'").get().valor;
    db.prepare("INSERT INTO integration_jobs (event_id, job_type, available_at, status) VALUES ('nuevo','order.sync',?, 'dead_lettered')").run(new Date(Date.parse(marca) + 1000).toISOString());
    // pasan 3 días y sigue sin resolverse: sigue contando
    expect(vigilarTrabajosNoTerminados(db, { ahoraMs: Date.now() + 3 * 24 * 3600 * 1000 }).total).toBe(1);
    expect(incidente('trabajos_sin_terminar').severidad).toBe('critico');
    db.prepare("UPDATE integration_jobs SET status='completed' WHERE event_id='nuevo'").run();
    vigilarTrabajosNoTerminados(db);
    expect(incidente('trabajos_sin_terminar')).toBeFalsy();
  });

});

describe('instrumentación de los barridos', () => {
  const CFG = { ml: ML, woo: { url: 'https://fusionbikes.com.ar', ck: 'a', cs: 'b' } };
  it('syncWcToMl y reconciliarStockMl dejan una fila en barrido_corridas', async () => {
    await syncWcToMl(db, CFG);
    await reconciliarStockMl(db, CFG);
    const procesos = db.prepare('SELECT proceso FROM barrido_corridas ORDER BY proceso').all().map((r) => r.proceso);
    expect(procesos).toEqual(['reconciliacion_stock_ml', 'wc_a_ml']);
  });
});

describe('diferencias del barrido', () => {
  it('cuenta "sin evento": la clave sin job cerrado en la ventana previa', () => {
    encolarTrabajo(db, { tipo: 'item.project', recurso: 'MLA1' });
    const r = registrarCorrida(db, { proceso: 'wc_a_ml', inicio: new Date().toISOString(), revisados: 100, claves: [{ clave: 'MLA1|', sku: 'S1' }, { clave: 'MLA2|', sku: 'S2' }] });
    expect(r).toEqual({ diferencias: 2, diferenciasSinEvento: 1 });
    const fila = db.prepare('SELECT * FROM barrido_corridas').get();
    expect(fila).toMatchObject({ proceso: 'wc_a_ml', revisados: 100, diferencias: 2, diferencias_sin_evento: 1 });
  });

  it('un stock.bolsa por SKU o un order.woo que incluye el SKU también cubren', () => {
    encolarTrabajo(db, { tipo: 'stock.bolsa', recurso: 'sku:S2' });
    db.prepare("INSERT INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES ('77', ?, ?)").run(JSON.stringify(['S3']), new Date().toISOString());
    encolarTrabajo(db, { tipo: 'order.woo', recurso: '77' });
    const r = registrarCorrida(db, { proceso: 'reconciliacion_stock_ml', inicio: new Date().toISOString(), claves: [{ clave: 'A|', sku: 'S2' }, { clave: 'B|', sku: 'S3' }, { clave: 'C|', sku: 'S4' }] });
    expect(r.diferenciasSinEvento).toBe(1);
  });

  it('no lanza si la medición falla (no puede tumbar el barrido)', () => {
    const roto = { prepare() { throw new Error('boom'); } };
    expect(registrarCorrida(roto, { proceso: 'wc_a_ml', inicio: new Date().toISOString() })).toBeNull();
  });

  it('alerta diaria + regla: supera el umbral 2 días seguidos => revertir=1 (solo registrado)', () => {
    const dia = 24 * 3600 * 1000;
    const base = Date.UTC(2026, 9, 15, 10);
    const sembrar = (ms, sinEvento) => db.prepare(`INSERT INTO barrido_corridas (proceso, inicio, fin, revisados, diferencias, diferencias_sin_evento) VALUES ('wc_a_ml', ?, ?, 100, ?, ?)`)
      .run(new Date(ms).toISOString(), new Date(ms).toISOString(), sinEvento, sinEvento);
    sembrar(base - 1000, 9);
    evaluarBarridosDiario(db, { ahoraMs: base, umbral: 5 });
    expect(frecuenciaBarridoRevertida(db, 'wc_a_ml')).toBe(false);
    expect(incidente('barrido_diario')?.severidad).toBe('advertencia');
    evaluarBarridosDiario(db, { ahoraMs: base + 3600 * 1000, umbral: 5 }); // mismo día: no suma otro día
    expect(frecuenciaBarridoRevertida(db, 'wc_a_ml')).toBe(false);
    sembrar(base + dia - 1000, 9);
    const r = evaluarBarridosDiario(db, { ahoraMs: base + dia, umbral: 5 });
    expect(frecuenciaBarridoRevertida(db, 'wc_a_ml')).toBe(true);
    expect(r.revertir).toEqual(['wc_a_ml']);
    // un día bajo el umbral corta la racha
    evaluarBarridosDiario(db, { ahoraMs: base + 3 * dia, umbral: 5 });
    expect(db.prepare("SELECT dias_sobre_umbral FROM barrido_estado WHERE proceso='wc_a_ml'").get().dias_sobre_umbral).toBe(0);
    expect(resumenBarridos(db, { ahoraMs: base }).length).toBe(1);
  });
});
