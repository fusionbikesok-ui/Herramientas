// Etiquetas en Preparación: listas «Falta etiqueta» / «Falta seguimiento» / «No salieron con el lote», resoluciones con motivo, purga y salida de lote.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { preparacionRouter, crearPreparacion, purgarFotosBorradas } from '../routes/preparacion.js';
import { wooFetch } from '../routes/woo.js';
import { rutaAbsoluta } from '../utils/storage.js';

vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});

const TEST_DB = `./test/tmp-etiquetas-listas.${process.pid}.sqlite`;
const limpiar = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
const CFG = { woo: { url: 'https://x.test' }, ml: null, andreaniStatus: 'lpaandreani', enviadoAndreaniStatus: 'enviadoandreani', colaFotos: { disparoInmediato: false } };
let db; let app;
const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();

function appComo(usuario = 'operario') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0, permisos: [{ herramienta: 'preparacion', nivel: 'write' }] }; next(); });
  a.use('/api/preparacion', preparacionRouter(db, CFG));
  return a;
}
let n = 100;
function prep({ canal = 'web', estado = 'completada', completado = dias(1), tracking = null, pack = null, cargada = null, confirmado = null, pendiente = 0 } = {}) {
  n += 1;
  const id = canal === 'web'
    ? crearPreparacion(db, { canal, wcOrderId: n, numeroPedido: String(n), comprador: `C${n}`, items: [] })
    : crearPreparacion(db, { canal, mlOrderId: String(n), packId: pack, numeroPedido: String(n), comprador: `C${n}`, items: [] });
  db.prepare('UPDATE preparaciones SET estado=?, completado_en=?, tracking=?, etiqueta_cargada_en=?, envio_confirmado_en=?, woo_paso2_pendiente=? WHERE id=?')
    .run(estado, completado, tracking, cargada, confirmado, pendiente, id);
  return id;
}
const fila = (id) => db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
const evento = (id, tipo) => db.prepare('INSERT INTO preparacion_eventos (preparacion_id, tipo, detalle_json, creado_en) VALUES (?,?,?,?)').run(id, tipo, '{}', dias(2));

beforeEach(() => { limpiar(); db = openDb(TEST_DB); preparacionRouter(db, CFG); app = appComo(); wooFetch.mockReset(); n = 100; });
afterEach(() => { db.close(); limpiar(); });

describe('GET /falta-etiqueta', () => {
  it('lista completadas sin etiqueta (web y ML), más viejas primero, y excluye cargadas y descartadas', async () => {
    const vieja = prep({ completado: dias(9) });
    const nuevaMl = prep({ canal: 'ml', completado: dias(3) });
    prep({ cargada: dias(1) });                                     // resuelta
    const desc = prep({ completado: dias(5) }); db.prepare('UPDATE preparaciones SET envio_descartado_en=? WHERE id=?').run(dias(1), desc);
    prep({ estado: 'en_preparacion', completado: null });           // abierta: no cuenta
    const r = await request(app).get('/api/preparacion/falta-etiqueta');
    expect(r.body.items.map((x) => x.id)).toEqual([vieja, nuevaMl]);
    expect(r.body.total).toBe(2);
    expect(r.body.items[0].acciones).toContain('completar_envio');
    expect(r.body.items[1].acciones).toContain('subir_foto');
  });

  it('pagina por cursor sin saltear ni repetir y nunca oculta por antigüedad', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(prep({ completado: dias(200 - i) }));
    const p1 = (await request(app).get('/api/preparacion/falta-etiqueta?limit=2')).body;
    expect(p1.items).toHaveLength(2); expect(p1.total).toBe(5); expect(p1.next_cursor).toBeTruthy();
    const p2 = (await request(app).get(`/api/preparacion/falta-etiqueta?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`)).body;
    const p3 = (await request(app).get(`/api/preparacion/falta-etiqueta?limit=2&cursor=${encodeURIComponent(p2.next_cursor)}`)).body;
    expect([...p1.items, ...p2.items, ...p3.items].map((x) => x.id)).toEqual(ids);
    expect(p3.next_cursor).toBeNull();
  });

  it('un pedido anulado en Woo sin etiqueta se lista con única acción «descartar»; «Salió sin foto» solo si el envío ya está fechado', async () => {
    const anulada = prep({ estado: 'anulado_en_woo' });
    const salio = prep({ canal: 'ml', confirmado: dias(2) });
    const r = (await request(app).get('/api/preparacion/falta-etiqueta')).body.items;
    expect(r.find((x) => x.id === anulada).acciones).toEqual(['descartar']);
    expect(r.find((x) => x.id === salio).acciones).toContain('salio_sin_foto');
  });
});

describe('GET /falta-seguimiento', () => {
  it('deriva los estados y excluye ML, confirmadas y descartadas', async () => {
    const sin = prep();
    const asoc = prep({ tracking: 'AND1' });
    const inc = prep({ tracking: 'AND2', pendiente: 1 });
    const aband = prep({ tracking: 'AND3' }); evento(aband, 'tracking_abandonado');
    const anul = prep({ estado: 'anulado_en_woo', tracking: 'AND4', pendiente: 1 });
    prep({ tracking: 'AND5', confirmado: dias(1) });                // confirmada
    prep({ canal: 'ml' });                                          // ML nunca
    prep({ estado: 'anulado_en_woo' });                             // anulada sin envío pendiente: no entra
    const r = (await request(app).get('/api/preparacion/falta-seguimiento')).body;
    const porId = Object.fromEntries(r.items.map((x) => [x.id, x]));
    expect(Object.keys(porId).map(Number).sort((a, b) => a - b)).toEqual([sin, asoc, inc, aband, anul].sort((a, b) => a - b));
    expect(porId[sin].estado_envio).toBe('sin_seguimiento');
    expect(porId[asoc].estado_envio).toBe('asociado_sin_confirmar');
    expect(porId[asoc].acciones).toEqual(['confirmar_envio']);
    expect(porId[inc].estado_envio).toBe('envio_incierto');
    expect(porId[aband].estado_envio).toBe('abandonado');
    expect(porId[aband].acciones).toEqual(['reintentar', 'descartar']);
    expect(porId[anul].estado_envio).toBe('anulado_con_envio_pendiente');
    expect(porId[anul].acciones).toEqual(['descartar']);
  });
});

describe('POST /:id/descartar-envio', () => {
  it('exige motivo; escribe fecha, motivo, actor y limpia el paso 2 pendiente', async () => {
    const id = prep({ tracking: 'A', pendiente: 1 });
    expect((await request(app).post(`/api/preparacion/${id}/descartar-envio`).send({})).status).toBe(400);
    const r = await request(app).post(`/api/preparacion/${id}/descartar-envio`).send({ motivo: 'se entregó en mano' });
    expect(r.status).toBe(200);
    expect(fila(id)).toMatchObject({ envio_descartado_motivo: 'se entregó en mano', envio_descartado_por: 'operario', woo_paso2_pendiente: 0 });
    expect(fila(id).envio_descartado_en).toBeTruthy();
    expect(fila(id).envio_confirmado_en).toBeNull();               // no afirma confirmación
    expect((await request(app).get('/api/preparacion/falta-seguimiento')).body.total).toBe(0);
    expect((await request(app).get('/api/preparacion/falta-etiqueta')).body.total).toBe(0);   // un descarte resuelve ambas sublistas
  });

  it('es la única excepción a la guarda de anulado_en_woo: otra mutación sigue respondiendo 409', async () => {
    const id = prep({ estado: 'anulado_en_woo', tracking: 'A', pendiente: 1 });
    expect((await request(app).post(`/api/preparacion/${id}/salio-sin-foto`).send({ motivo: 'x' })).status).toBe(409);
    expect((await request(app).post(`/api/preparacion/${id}/descartar-envio`).send({ motivo: 'anulado' })).status).toBe(200);
    expect(fila(id).woo_paso2_pendiente).toBe(0);
    expect(fila(id).estado).toBe('anulado_en_woo');
  });

  it('atómico y fail-closed: si el evento falla, no hay cambio y responde 500', async () => {
    const id = prep({ tracking: 'A' });
    db.exec("CREATE TRIGGER falla_evento BEFORE INSERT ON preparacion_eventos WHEN NEW.tipo='envio_descartado' BEGIN SELECT RAISE(ABORT,'boom'); END;");
    const r = await request(app).post(`/api/preparacion/${id}/descartar-envio`).send({ motivo: 'x' });
    expect(r.status).toBe(500);
    expect(fila(id).envio_descartado_en).toBeNull();
  });

  it('descarta todo el grupo (pack) y deja constancia en el historial del lote', async () => {
    const a = prep({ canal: 'ml', pack: 'PKD' }); const b = prep({ canal: 'ml', pack: 'PKD' });
    const lote = db.prepare("INSERT INTO despacho_lotes (canal, fecha_jornada, estado, creado_en, creado_por, salida_confirmada_en) VALUES ('ml','2026-10-01','cerrado',?,?,?)").run(dias(3), 'u', dias(2)).lastInsertRowid;
    const c = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES ('PKD', 'pendiente', ?, ?)").run(dias(3), dias(3)).lastInsertRowid;
    db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'esperado',?)").run(lote, c, dias(3));
    const r = await request(app).post(`/api/preparacion/${a}/descartar-envio`).send({ motivo: 'no salió', lote_id: lote });
    expect(r.body.descartadas).toBe(2);
    expect(fila(b).envio_descartado_en).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM despacho_lote_eventos WHERE lote_id=? AND tipo='miembro_descartado'").get(lote)).toBeTruthy();
  });

  it('lote_id ajeno (no es miembro, ya confirmado o sin salida confirmada): 409 LOTE_AJENO y no escribe nada', async () => {
    const a = prep({ canal: 'ml' });
    const mk = (salida) => db.prepare("INSERT INTO despacho_lotes (canal, fecha_jornada, estado, creado_en, creado_por, salida_confirmada_en) VALUES ('ml','2026-10-01','cerrado',?,?,?)").run(dias(3), 'u', salida).lastInsertRowid;
    const ctl = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?)").run(fila(a).clave, dias(3), dias(3)).lastInsertRowid;
    const ajeno = mk(dias(2));                                     // sin ser miembro
    const sinSalida = mk(null); db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'esperado',?)").run(sinSalida, ctl, dias(3));
    const b = prep({ canal: 'ml' });
    const ctlB = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?)").run(fila(b).clave, dias(3), dias(3)).lastInsertRowid;
    const confirmado = mk(dias(2)); db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'confirmado',?)").run(confirmado, ctlB, dias(3));
    for (const [id, lote_id] of [[a, ajeno], [a, sinSalida], [a, 'abc'], [b, confirmado]]) {
      const r = await request(app).post(`/api/preparacion/${id}/descartar-envio`).send({ motivo: 'x', lote_id });
      expect(r.status).toBe(409); expect(r.body.code).toBe('LOTE_AJENO');
    }
    expect(fila(b).envio_descartado_en).toBeNull();
    expect(fila(a).envio_descartado_en).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM despacho_lote_eventos WHERE tipo='miembro_descartado'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM preparacion_eventos WHERE tipo='envio_descartado'").get().n).toBe(0);
  });

  it('sin lote_id en el cuerpo, el evento igual queda en el lote del que el grupo salió sin confirmar', async () => {
    const a = prep({ canal: 'ml' });
    const lote = db.prepare("INSERT INTO despacho_lotes (canal, fecha_jornada, estado, creado_en, creado_por, salida_confirmada_en) VALUES ('ml','2026-10-01','cerrado',?,?,?)").run(dias(3), 'u', dias(2)).lastInsertRowid;
    const c = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?)").run(fila(a).clave, dias(3), dias(3)).lastInsertRowid;
    db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'esperado',?)").run(lote, c, dias(3));
    const r = await request(app).post(`/api/preparacion/${a}/descartar-envio`).send({ motivo: 'no salió' });
    expect(r.status).toBe(200);
    expect(db.prepare("SELECT 1 FROM despacho_lote_eventos WHERE lote_id=? AND tipo='miembro_descartado'").get(lote)).toBeTruthy();
  });
});

describe('POST /:id/salio-sin-foto', () => {
  it('ML confirmado sin foto → resuelve con origen sin_foto y sale de la lista; sin envío confirmado no se puede', async () => {
    const sinFecha = prep({ canal: 'ml' });
    expect((await request(app).post(`/api/preparacion/${sinFecha}/salio-sin-foto`).send({ motivo: 'x' })).status).toBe(409);
    const id = prep({ canal: 'ml', confirmado: dias(2) });
    expect((await request(app).post(`/api/preparacion/${id}/salio-sin-foto`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/preparacion/${id}/salio-sin-foto`).send({ motivo: 'se retiró sin foto' })).status).toBe(200);
    expect(fila(id).etiqueta_origen).toBe('sin_foto');
    expect(fila(id).etiqueta_cargada_en).toBeTruthy();
    const ids = (await request(app).get('/api/preparacion/falta-etiqueta')).body.items.map((x) => x.id);
    expect(ids).not.toContain(id);
  });

  it('fail-closed: si el evento falla no queda resuelta', async () => {
    const id = prep({ canal: 'ml', confirmado: dias(2) });
    db.exec("CREATE TRIGGER falla_evento BEFORE INSERT ON preparacion_eventos WHEN NEW.tipo='etiqueta_sin_foto' BEGIN SELECT RAISE(ABORT,'boom'); END;");
    expect((await request(app).post(`/api/preparacion/${id}/salio-sin-foto`).send({ motivo: 'x' })).status).toBe(500);
    expect(fila(id).etiqueta_cargada_en).toBeNull();
  });
});

describe('salida de lote: no escribe en Woo, fecha solo ML y avisa', () => {
  function lote(canal, miembros) {
    const l = db.prepare("INSERT INTO despacho_lotes (canal, fecha_jornada, estado, creado_en, creado_por) VALUES (?, '2026-10-01', 'cerrado', ?, 'u')").run(canal, dias(1)).lastInsertRowid;
    for (const [grupo, estado] of miembros) {
      const c = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?)").run(grupo, dias(1), dias(1)).lastInsertRowid;
      db.prepare('INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,?,?)').run(l, c, estado, dias(1));
    }
    return l;
  }
  const salida = (l) => request(app).post(`/api/preparacion/despacho/lotes/${l}/salida`).set('Idempotency-Key', `k-${l}`);

  it('lote ML: fecha el grupo de los confirmados (pack completo), no a los no confirmados; devuelve advertencias de etiqueta; 0 jobs y 0 PUT', async () => {
    const a = prep({ canal: 'ml', pack: 'PKS' }); const b = prep({ canal: 'ml', pack: 'PKS' });
    const c = prep({ canal: 'ml' }); const d = prep({ canal: 'ml', cargada: dias(1) });
    const l = lote('ml', [['PKS', 'confirmado'], [fila(c).clave, 'esperado'], [fila(d).clave, 'confirmado']]);
    const r = await salida(l);
    expect(r.status).toBe(200);
    expect(fila(a).envio_confirmado_en).toBeTruthy(); expect(fila(b).envio_confirmado_en).toBeTruthy();
    expect(fila(c).envio_confirmado_en).toBeNull();
    expect(fila(d).envio_confirmado_en).toBeTruthy();
    expect(r.body.advertencias.map((x) => x.clave).sort()).toEqual([fila(a).clave, fila(b).clave].sort());
    expect(r.body.advertencias.every((x) => x.motivo === 'falta_etiqueta')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE job_type='dispatch.woo'").get().n).toBe(0);
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('la advertencia falta_etiqueta no incluye despachada_sin_verificar (la UI no lo puede resolver)', async () => {
    const a = prep({ canal: 'ml', estado: 'despachada_sin_verificar' });
    const l = lote('ml', [[fila(a).clave, 'confirmado']]);
    const r = await salida(l);
    expect(r.status).toBe(200);
    expect(r.body.advertencias).toEqual([]);
  });

  it('lote web: no fecha nada (la fecha web es el paso 2) y tampoco escribe en Woo', async () => {
    const a = prep({ canal: 'web', tracking: 'A' });
    const l = lote('web', [[fila(a).clave, 'confirmado']]);
    const r = await salida(l);
    expect(r.status).toBe(200);
    expect(fila(a).envio_confirmado_en).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE job_type='dispatch.woo'").get().n).toBe(0);
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('«No salieron con el lote»: miembro no confirmado de un lote con salida; se vacía al descartar o al despacharse por la vía individual', async () => {
    const a = prep({ canal: 'ml' }); const b = prep({ canal: 'ml' });
    const l = lote('ml', [[fila(a).clave, 'confirmado'], [fila(b).clave, 'esperado']]);
    await salida(l);
    let r = (await request(app).get('/api/preparacion/no-salieron')).body;
    expect(r.items.map((x) => x.grupo_clave)).toEqual([fila(b).clave]);
    // despacho individual posterior → el trigger fecha el grupo → sale de la lista
    db.prepare("UPDATE despacho_controles SET estado='confirmado', confirmado_en=? WHERE grupo_clave=?").run(new Date().toISOString(), fila(b).clave);
    r = (await request(app).get('/api/preparacion/no-salieron')).body;
    expect(r.total).toBe(0);
    // segundo camino: descartar
    const c = prep({ canal: 'ml' });
    const l2 = lote('ml', [[fila(a).clave + 'x', 'confirmado'], [fila(c).clave, 'esperado']]);
    await salida(l2);
    expect((await request(app).get('/api/preparacion/no-salieron')).body.total).toBe(1);
    await request(app).post(`/api/preparacion/${c}/descartar-envio`).send({ motivo: 'no salió', lote_id: l2 });
    expect((await request(app).get('/api/preparacion/no-salieron')).body.total).toBe(0);
  });
});

describe('purga de fotos (v5–v16)', () => {
  function conFoto(id, creado) {
    const url = `/uploads/preparacion/purga/${id}-${Math.random().toString(36).slice(2)}.jpg`;
    const abs = rutaAbsoluta(url);
    fs.mkdirSync(abs.replace(/[^/]+$/, ''), { recursive: true }); fs.writeFileSync(abs, 'x');
    db.prepare("INSERT INTO preparacion_fotos (preparacion_id, tipo, url, creado_en, estado_proceso) VALUES (?, 'paquete_abierto', ?, ?, 'listo')").run(id, url, creado);
    return abs;
  }
  afterEach(() => { try { fs.rmSync('./uploads/preparacion/purga', { recursive: true, force: true }); } catch { /* best effort */ } });
  const cuantas = (id) => db.prepare('SELECT COUNT(*) n FROM preparacion_fotos WHERE preparacion_id=?').get(id).n;

  it('cerrada hace 40 días sin tracking (pendiente de envío): no se purga; al confirmar el envío, recién 30 días después', () => {
    const id = prep({ completado: dias(40), cargada: dias(40) }); conFoto(id, dias(40));
    db.prepare('UPDATE preparaciones SET creado_en=? WHERE id=?').run(dias(41), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('UPDATE preparaciones SET envio_confirmado_en=? WHERE id=?').run(dias(5), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('UPDATE preparaciones SET envio_confirmado_en=? WHERE id=?').run(dias(31), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });

  it('ML confirmado hace 40 días pero en «Falta etiqueta»: no se purga; resuelta hoy sin foto → tampoco hasta 30 días después', () => {
    const id = prep({ canal: 'ml', completado: dias(41), confirmado: dias(40) }); conFoto(id, dias(41));
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare("UPDATE preparaciones SET etiqueta_cargada_en=?, etiqueta_origen='sin_foto' WHERE id=?").run(new Date().toISOString(), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('UPDATE preparaciones SET etiqueta_cargada_en=? WHERE id=?').run(dias(31), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });

  it('foto de etiqueta subida hoy en una preparación confirmada hace 40 días: vive 30 días desde su subida (la foto vieja no depende)', () => {
    const id = prep({ completado: dias(41), confirmado: dias(40), cargada: new Date().toISOString() });
    conFoto(id, new Date().toISOString());
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
  });

  it('descartado hace 31 días: se purga; antes de 30 no', () => {
    const id = prep({ completado: dias(60) }); conFoto(id, dias(60));
    db.prepare('UPDATE preparaciones SET envio_descartado_en=? WHERE id=?').run(dias(10), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('UPDATE preparaciones SET envio_descartado_en=? WHERE id=?').run(dias(31), id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });

  it('los holds siguen mandando aunque el envío esté confirmado hace 40 días; al cerrar el hold se purga', () => {
    const id = prep({ completado: dias(60), confirmado: dias(40), cargada: dias(40) }); conFoto(id, dias(60));
    db.prepare("INSERT INTO preparacion_fotos_holds (preparacion_id, motivo, creado_en) VALUES (?, 'reclamo', ?)").run(id, dias(1));
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('DELETE FROM preparacion_fotos_holds WHERE preparacion_id=?').run(id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });

  it('la rama de fotos ya borradas (soft-delete) también respeta los holds', () => {
    const id = prep({ completado: dias(60), confirmado: dias(40), cargada: dias(40) }); conFoto(id, dias(60));
    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE preparacion_id=?').run(dias(40), id);
    db.prepare("INSERT INTO preparacion_fotos_holds (preparacion_id, motivo, creado_en) VALUES (?, 'garantia', ?)").run(id, dias(1));
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(1);
    db.prepare('DELETE FROM preparacion_fotos_holds WHERE preparacion_id=?').run(id);
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });

  it('los estados que no son de cierre conservan la regla de siempre (30 días desde la creación de la preparación)', () => {
    const id = prep({ estado: 'despachada_sin_verificar', completado: dias(50) });
    db.prepare('UPDATE preparaciones SET creado_en=? WHERE id=?').run(dias(50), id); conFoto(id, dias(50));
    purgarFotosBorradas(db); expect(cuantas(id)).toBe(0);
  });
});
