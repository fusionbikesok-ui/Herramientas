import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { openDb } from '../db/index.js';
import {
  splitDireccion, splitTelefonoAr, normalizarEnvio,
  resolverPerfil, requisitosFoto, fotosFaltantes, esEnvioLocal,
} from '../lib/preparacion.js';
import { preparacionRouter, crearPreparacion, registrarEvento, purgarFotosBorradas } from '../routes/preparacion.js';
import { rutaAbsoluta } from '../utils/storage.js';
import heicConvert from 'heic-convert';

vi.mock('heic-convert', () => ({ default: vi.fn() }));
vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

const TEST_DB = './test/tmp-preparacion.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  // simular usuario autenticado (el server real lo inyecta requireAuth)
  app.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani' }));
  return app;
}

function buildTestAppComo(db, usuario) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani' }));
  return app;
}

describe('POST /:id/heartbeat', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('registra la presencia y no devuelve a nadie si sos el único viendo la preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Juan', items: [] });

    const res = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.otros).toEqual([]);
  });

  it('devuelve a otro usuario que mandó heartbeat en los últimos 30s, sin incluirse a sí mismo', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 901, numeroPedido: '901', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toHaveLength(1);
    expect(res.body.otros[0].usuario).toBe('juan');
  });

  it('no devuelve un heartbeat viejo (más de 30s)', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 902, numeroPedido: '902', comprador: 'Ana', items: [] });
    const viejo = new Date(Date.now() - 60000).toISOString(); // hace 60s
    db.prepare('INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)').run(prepId, 'juan', viejo);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('actualiza (no duplica) el heartbeat del mismo usuario en la misma preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 903, numeroPedido: '903', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const filas = db.prepare('SELECT * FROM preparacion_vistas WHERE preparacion_id=?').all(prepId);

    expect(filas).toHaveLength(1);
  });

  it('no mezcla presencia entre preparaciones distintas', async () => {
    const prepA = crearPreparacion(db, { canal: 'web', wcOrderId: 904, numeroPedido: '904', comprador: 'X', items: [] });
    const prepB = crearPreparacion(db, { canal: 'web', wcOrderId: 905, numeroPedido: '905', comprador: 'Y', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepA}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepB}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('404 si la preparación no existe', async () => {
    const res = await request(buildTestAppComo(db, 'juan')).post('/api/preparacion/999999/heartbeat');
    expect(res.status).toBe(404);
  });

  it('un mismo usuario puede tener presencia simultánea en dos preparaciones distintas sin pisarse (PK compuesta por preparacion_id+usuario)', async () => {
    const prepA = crearPreparacion(db, { canal: 'web', wcOrderId: 906, numeroPedido: '906', comprador: 'X', items: [] });
    const prepB = crearPreparacion(db, { canal: 'web', wcOrderId: 907, numeroPedido: '907', comprador: 'Y', items: [] });

    // juan está viendo A y B al mismo tiempo (dos pestañas, por ejemplo).
    const resA = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepA}/heartbeat`);
    const resB = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepB}/heartbeat`);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // ana entra a A: debe ver a juan en A...
    const desdeA = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepA}/heartbeat`);
    expect(desdeA.body.otros.map(o => o.usuario)).toEqual(['juan']);

    // ...y pedro entra a B: debe ver a juan en B, no contaminado por lo de A.
    const desdeB = await request(buildTestAppComo(db, 'pedro')).post(`/api/preparacion/${prepB}/heartbeat`);
    expect(desdeB.body.otros.map(o => o.usuario)).toEqual(['juan']);

    // hay dos filas distintas para juan (una por cada preparación), no una sola pisada.
    const filasJuan = db.prepare('SELECT * FROM preparacion_vistas WHERE usuario=?').all('juan');
    expect(filasJuan).toHaveLength(2);
  });
});

describe('registrarEvento', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } });

  it('inserta un evento con detalle_json serializado', () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Ana', items: [] });
    registrarEvento(db, { preparacionId: id, itemId: null, tipo: 'completado', usuario: 'juan', detalle: { foo: 'bar' } });
    const ev = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=?').get(id);
    expect(ev.tipo).toBe('completado');
    expect(ev.usuario).toBe('juan');
    expect(JSON.parse(ev.detalle_json)).toEqual({ foo: 'bar' });
    expect(ev.creado_en).toBeTruthy();
  });

  it('no lanza si el insert falla (fail-open) — se traga el error', () => {
    // aseguramos que las tablas existan antes de tirar abajo la que nos interesa probar
    crearPreparacion(db, { canal: 'web', wcOrderId: 902, numeroPedido: '902', comprador: 'Ana', items: [] });
    db.prepare('DROP TABLE preparacion_eventos').run();
    expect(() => registrarEvento(db, { preparacionId: 1, tipo: 'completado', usuario: 'juan', detalle: {} })).not.toThrow();
  });
});

// ─── lógica pura: splits de dirección y teléfono ──────────────────────────────

describe('splitDireccion', () => {
  it('separa calle y numeración cuando el número va al final', () => {
    expect(splitDireccion('Av. Siempreviva 742')).toEqual({ calle: 'Av. Siempreviva', numeracion: '742' });
  });

  it('tolera dirección sin número', () => {
    expect(splitDireccion('Camino de los Remeros s/n')).toEqual({ calle: 'Camino de los Remeros s/n', numeracion: '' });
  });

  it('no confunde calles numeradas: el último número es la numeración', () => {
    expect(splitDireccion('Calle 50 1234')).toEqual({ calle: 'Calle 50', numeracion: '1234' });
  });

  it('tolera vacío/null', () => {
    expect(splitDireccion('')).toEqual({ calle: '', numeracion: '' });
    expect(splitDireccion(null)).toEqual({ calle: '', numeracion: '' });
  });
});

describe('splitTelefonoAr', () => {
  it('usa el primer grupo como característica cuando hay separadores', () => {
    expect(splitTelefonoAr('0351 4567890')).toEqual({ caracteristica: '351', numero: '4567890' });
  });

  it('quita prefijos +54 / 9 / 0 y 15', () => {
    expect(splitTelefonoAr('+54 9 351 555 1234')).toEqual({ caracteristica: '351', numero: '5551234' });
  });

  it('separa CABA (11) sin separadores', () => {
    expect(splitTelefonoAr('1145678901')).toEqual({ caracteristica: '11', numero: '45678901' });
  });

  it('sin separadores y sin 11: asume característica de 3 dígitos', () => {
    expect(splitTelefonoAr('3515551234')).toEqual({ caracteristica: '351', numero: '5551234' });
  });

  it('tolera vacío', () => {
    expect(splitTelefonoAr('')).toEqual({ caracteristica: '', numero: '' });
    expect(splitTelefonoAr(null)).toEqual({ caracteristica: '', numero: '' });
  });
});

describe('normalizarEnvio', () => {
  const base = {
    id: 77, number: '77',
    shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', address_2: '2B', city: 'Córdoba', state: 'Córdoba', postcode: '5000', phone: '0351 4567890' },
    billing: { first_name: 'Fac', last_name: 'Turador', address_1: 'Otra 999', address_2: '', city: 'CABA', state: 'CABA', postcode: '1000', email: 'ana@mail.com', phone: '011 5555-6666' },
    customer_note: 'tocar timbre',
    meta_data: [{ key: '_billing_dni', value: '30123456' }],
  };

  it('usa la dirección de envío cuando existe', () => {
    const e = normalizarEnvio(base);
    expect(e.nombre).toBe('Ana');
    expect(e.apellido).toBe('Gomez');
    expect(e.calle).toBe('Belgrano');
    expect(e.numeracion).toBe('123');
    expect(e.piso_depto).toBe('2B');
    expect(e.localidad).toBe('Córdoba');
    expect(e.cp).toBe('5000');
    expect(e.caracteristica).toBe('351');
    expect(e.telefono).toBe('4567890');
    expect(e.email).toBe('ana@mail.com');
    expect(e.dni_cuit).toBe('30123456');
    expect(e.notas).toBe('tocar timbre');
  });

  it('cae a facturación si el envío está vacío', () => {
    const sinShipping = { ...base, shipping: { first_name: '', last_name: '', address_1: '', city: '', state: '', postcode: '' } };
    const e = normalizarEnvio(sinShipping);
    expect(e.nombre).toBe('Fac');
    expect(e.calle).toBe('Otra');
    expect(e.numeracion).toBe('999');
    expect(e.localidad).toBe('CABA');
    expect(e.caracteristica).toBe('11');
    expect(e.telefono).toBe('55556666');
  });
});

// ─── perfiles y requisitos de foto ────────────────────────────────────────────

describe('resolverPerfil', () => {
  it('detecta bici por categoría BICICLETAS', () => {
    expect(resolverPerfil({ categorias: ['BICICLETAS POR MARCA', 'BICICLETAS TREK'], nombre: 'Bicicleta Trek Marlin 7' })).toBe('bici');
  });

  it('detecta kit de transmisión por categoría TRANSMISIONES', () => {
    expect(resolverPerfil({ categorias: ['TRANSMISIONES'], nombre: 'Grupo Shimano Deore 12v' })).toBe('kit_transmision');
  });

  it('detecta kit por nombre GRUPO/KIT + transmisión aunque la categoría no ayude', () => {
    expect(resolverPerfil({ categorias: [], nombre: 'Kit transmisión SRAM GX' })).toBe('kit_transmision');
    expect(resolverPerfil({ categorias: [], nombre: 'Grupo Transmision Shimano Deore 12v' })).toBe('kit_transmision');
  });

  it('un "kit" que no es de transmisión NO es kit_transmision (caso real: kit purgado)', () => {
    expect(resolverPerfil({ categorias: ['HERRAMIENTAS'], nombre: 'Kit Purgado Ezmtb Basico (1019) Shimano' })).toBe('sellado');
    expect(resolverPerfil({ categorias: ['ACCESORIOS TUBELESS'], nombre: 'Kit Tubeless Valvulas' })).toBe('sellado');
  });

  it('el resto es sellado', () => {
    expect(resolverPerfil({ categorias: ['CUBIERTAS'], nombre: 'Cubierta Maxxis Ikon' })).toBe('sellado');
  });
});

describe('requisitosFoto', () => {
  it('bici re_embalada exige lado_a + lado_b + caja_accesorios', () => {
    const slots = requisitosFoto('bici', 're_embalada');
    const tipos = slots.map(s => s.tipos.join('|'));
    expect(tipos).toContain('lado_a');
    expect(tipos).toContain('lado_b');
    expect(tipos).toContain('caja_accesorios');
  });

  it('bici sellada pide una sola foto (articulo o etiqueta)', () => {
    const slots = requisitosFoto('bici', 'sellada');
    expect(slots).toHaveLength(1);
    expect(slots[0].tipos).toEqual(expect.arrayContaining(['articulo', 'etiqueta']));
  });

  it('kit_transmision pide foto de piezas', () => {
    const slots = requisitosFoto('kit_transmision', null);
    expect(slots).toHaveLength(1);
    expect(slots[0].tipos).toContain('piezas');
  });

  it('sellado pide una foto de articulo/etiqueta', () => {
    const slots = requisitosFoto('sellado', null);
    expect(slots).toHaveLength(1);
  });
});

describe('fotosFaltantes', () => {
  it('reporta los slots sin foto', () => {
    const req = requisitosFoto('bici', 're_embalada');
    const faltan = fotosFaltantes(req, [{ tipo: 'lado_a' }]);
    expect(faltan.map(s => s.tipos.join('|'))).toEqual(['lado_b', 'caja_accesorios']);
  });

  it('vacío cuando está todo', () => {
    const req = requisitosFoto('sellado', null);
    expect(fotosFaltantes(req, [{ tipo: 'etiqueta' }])).toEqual([]);
  });
});

describe('esEnvioLocal', () => {
  it('acepta flex y colecta, rechaza full', () => {
    expect(esEnvioLocal('self_service')).toBe(true);
    expect(esEnvioLocal('cross_docking')).toBe(true);
    expect(esEnvioLocal('drop_off')).toBe(true);
    expect(esEnvioLocal('xd_drop_off')).toBe(true);
    expect(esEnvioLocal('fulfillment')).toBe(false);
  });
});

// ─── flujo del router sobre la DB ─────────────────────────────────────────────

describe('preparacion flujo', () => {
  let db, app;

  const ITEMS = [
    { line_item_id: 1, product_id: 10, sku: 'BICI-1', nombre: 'Bicicleta Trek Marlin 7', categoria: 'BICICLETAS TREK', cantidad: 1 },
    { line_item_id: 2, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 2 },
    { line_item_id: 3, product_id: 30, sku: '', nombre: 'Producto sin código', categoria: 'ACCESORIOS', cantidad: 1 },
  ];

  beforeEach(() => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    db = openDb(TEST_DB);
    app = buildTestApp(db);
  });

  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  });

  function nuevaPrep() {
    return crearPreparacion(db, {
      canal: 'web', wcOrderId: 500, numeroPedido: '500', comprador: 'Ana Gomez', items: ITEMS,
    });
  }

  it('crearPreparacion es idempotente por clave', () => {
    const id1 = nuevaPrep();
    const id2 = nuevaPrep();
    expect(id2).toBe(id1);
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id1);
    expect(items).toHaveLength(3);
    expect(items.find(i => i.sku === 'BICI-1').perfil).toBe('bici');
    expect(items.find(i => i.sku === 'CUB-1').perfil).toBe('sellado');
  });

  it('escanear: match sube cantidad y verifica al completar', async () => {
    const id = nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    expect(r.body.resultado).toBe('match');
    expect(r.body.item.cantidad_escaneada).toBe(1);
    expect(r.body.item.estado_item).toBe('pendiente');

    r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    expect(r.body.resultado).toBe('match');
    expect(r.body.item.estado_item).toBe('verificado');
  });

  it('escanear: código ajeno → no_coincide; de más → sobrante', async () => {
    const id = nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'NO-EXISTE' });
    expect(r.body.resultado).toBe('no_coincide');

    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    expect(r.body.resultado).toBe('sobrante');
  });

  it('confirmar-manual verifica ítems sin código', async () => {
    const id = nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
    expect(r.body.ok).toBe(true);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('verificado');
    expect(row.confirmado_manual).toBe(1);
  });

  it('completar exige ítems verificados y fotos según perfil', async () => {
    const id = nuevaPrep();
    // nada verificado → 400 con detalle
    let r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(r.body.faltantes.length).toBeGreaterThan(0);

    // verificar todo
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({});

    // bici re_embalada: faltan fotos → 400
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 're_embalada' });
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.faltantes)).toContain('lado_a');

    // insertar fotos requeridas de todos los ítems y completar
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id);
    for (const it of items) {
      if (it.sku === 'BICI-1') {
        for (const t of ['lado_a', 'lado_b', 'caja_accesorios']) insFoto.run(id, it.id, t, '/uploads/x.jpg', now);
      } else {
        insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
      }
    }
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('completada');
    expect(prep.preparado_por).toBe('tester');
    expect(prep.completado_en).toBeTruthy();
  });

  it('despacho deposito_relajado exime escaneo y fotos', async () => {
    const id = nuevaPrep();
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    const r = await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`)
      .send({ modo: 'deposito_relajado', motivo: 'caja en depósito' });
    expect(r.body.ok).toBe(true);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(bici.id);
    expect(row.estado_item).toBe('exento');
    expect(row.despacho).toBe('deposito_relajado');

    // verificar el resto con fotos y completar sin tocar la bici
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({});
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND estado_item='verificado'").all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }
    const fin = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(fin.status).toBe(200);
    expect(fin.body.estado).toBe('completada');
  });

  it('despacho deposito_delegado deja la orden pendiente_deposito y luego se completa', async () => {
    const id = nuevaPrep();
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`).send({ modo: 'deposito_delegado' });

    // resto verificado + fotos
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({});
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND estado_item='verificado'").all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }

    // completar → queda pendiente_deposito (la bici la termina el depósito)
    let r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('pendiente_deposito');

    // el depósito escanea la bici y sube su foto → completar de nuevo
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    insFoto.run(id, bici.id, 'articulo', '/uploads/x.jpg', now); // sellada por defecto: 1 foto
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
  });

  it('embalaje y despacho registran valor_anterior -> valor_nuevo en preparacion_eventos', async () => {
    const id = nuevaPrep();
    const bici = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');

    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 'abierta' });
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 're_embalada' });

    const evsEmb = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='embalaje' ORDER BY id").all(id);
    expect(evsEmb).toHaveLength(2);
    expect(JSON.parse(evsEmb[0].detalle_json)).toMatchObject({ valor_anterior: null, valor_nuevo: 'abierta' });
    expect(JSON.parse(evsEmb[1].detalle_json)).toMatchObject({ valor_anterior: 'abierta', valor_nuevo: 're_embalada' });

    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`).send({ modo: 'deposito_relajado' });
    const evDesp = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='despacho'").get(id);
    expect(JSON.parse(evDesp.detalle_json)).toMatchObject({ valor_anterior: 'local', valor_nuevo: 'deposito_relajado' });
  });

  it('completar registra un evento tipo completado', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({});
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }
    const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='completado'").get(id);
    expect(ev).toBeTruthy();
    expect(ev.usuario).toBe('tester');
  });

  it('etiqueta_lista se marca aun sin preparación previa', async () => {
    const r = await request(app).post('/api/preparacion/etiquetas/900/lista').send({ lista: true, numero_pedido: '900', comprador: 'X' });
    expect(r.body.ok).toBe(true);
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:900'").get();
    expect(prep.etiqueta_lista).toBe(1);
  });

  it('POST /:id/foto convierte a JPEG una imagen real subida', async () => {
    const id = nuevaPrep();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', png, { filename: 'foto.png', contentType: 'image/png' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.foto.url).toMatch(/\.jpg$/);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].url).toMatch(/\.jpg$/);
  });

  it('POST /:id/foto rechaza un buffer que no es una imagen real (mimetype falseado)', async () => {
    const id = nuevaPrep();
    const buffer = Buffer.from('esto no es una imagen');

    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', buffer, { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'no se pudo procesar la imagen' });

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(0);
  });

  it('POST /:id/foto decodifica un HEIC de iPhone (fallback heic-convert) y lo guarda como JPEG', async () => {
    const id = nuevaPrep();
    // sharp/libvips de este VPS no decodifica HEIC real: simulamos que heic-convert
    // hace su trabajo devolviendo un JPEG válido, que luego sharp rota y re-encodea.
    const jpegReal = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 255 } } })
      .jpeg()
      .toBuffer();
    heicConvert.mockResolvedValueOnce(jpegReal);

    // buffer HEIC "falso": si no se enrutara por heic-convert, sharp lo rechazaría.
    const heicBuffer = Buffer.from('ftypheic no es una imagen que sharp entienda');
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', heicBuffer, { filename: 'IMG_1234.heic', contentType: 'image/heic' });

    expect(heicConvert).toHaveBeenCalledTimes(1);
    expect(heicConvert.mock.calls[0][0]).toMatchObject({ format: 'JPEG' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.foto.url).toMatch(/\.jpg$/);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(1);
  });

  it('POST /:id/foto responde 400 (no 500) si heic-convert falla con un HEIC corrupto', async () => {
    const id = nuevaPrep();
    heicConvert.mockRejectedValueOnce(new Error('HEIC corrupto'));

    const heicBuffer = Buffer.from('archivo heic corrupto');
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', heicBuffer, { filename: 'rota.heic', contentType: 'image/heic' });

    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'no se pudo procesar la imagen' });

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(0);
  });

  it('POST /:id/foto procesa un .heic aunque el mimetype llegue vacío/octet-stream (iPhone al compartir)', async () => {
    const id = nuevaPrep();
    const jpegReal = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toBuffer();
    heicConvert.mockResolvedValueOnce(jpegReal);

    // iPhone al compartir manda el .heic con application/octet-stream (no arranca con image/):
    // el guard temprano NO debe cortarlo, la detección por extensión lo enruta a heic-convert.
    const heicBuffer = Buffer.from('ftypheic compartido desde iPhone');
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', heicBuffer, { filename: 'IMG_9999.heic', contentType: 'application/octet-stream' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(heicConvert).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'JPEG', buffer: heicBuffer }));
    expect(r.body.foto.url).toMatch(/\.jpg$/);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(1);
  });

  it('POST /:id/foto responde 400 JSON (no 500 HTML) cuando la foto supera el límite de multer', async () => {
    const id = nuevaPrep();
    // Buffer de 16MB: supera el límite de 15MB de multer (fotos de cámara nativa
    // de iPhones modernos). Antes esto propagaba un MulterError sin error-handler
    // y el frontend recibía HTML → flash genérico. Ahora es 400 con JSON claro.
    const gordo = Buffer.alloc(16 * 1024 * 1024, 0);
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', gordo, { filename: 'IMG_1234.jpg', contentType: 'image/jpeg' });

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toMatch(/pesada/i);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(0);
  });

  it('POST /seguimientos/:wcOrderId valida wcOrderId y tracking', async () => {
    let r = await request(app).post('/api/preparacion/seguimientos/abc').send({ tracking: '123' });
    expect(r.status).toBe(400);
    r = await request(app).post('/api/preparacion/seguimientos/900').send({});
    expect(r.status).toBe(400);
  });

  it('GET /tracking-actual: corregible=true si el pedido está completed/enviadoandreani con tracking', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const r = await request(app).get('/api/preparacion/seguimientos/900/tracking-actual');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'enviadoandreani', tracking_actual: 'AND111', corregible: true });
  });

  it('GET /tracking-actual: corregible=false si el pedido sigue en lpaandreani (todavía no se cargó tracking)', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).get('/api/preparacion/seguimientos/901/tracking-actual');
    expect(r.body).toMatchObject({ ok: true, corregible: false });
  });

  it('POST /corregir-tracking: 409 si el pedido no está completed/enviadoandreani', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/902/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: 409 si no hay tracking previo cargado', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'completed', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/903/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: mismo valor es no-op, no llama PUT', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const llamadasAntes = wooFetch.mock.calls.length;
    const r = await request(app).post('/api/preparacion/seguimientos/904/corregir-tracking').send({ tracking: 'AND111' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND111' });
    expect(wooFetch.mock.calls.length - llamadasAntes).toBe(1); // solo el GET, ningún PUT
  });

  it('POST /corregir-tracking: valor distinto hace UN PUT con solo meta_data (sin status) y registra evento', async () => {
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, completado_en)
      VALUES ('web','web:905',905,1,'completada',?,?)`).run(new Date().toISOString(), new Date().toISOString());

    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'enviadoandreani',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });

    const llamadasAntes = wooFetch.mock.calls.length;
    const r = await request(app).post('/api/preparacion/seguimientos/905/corregir-tracking').send({ tracking: 'AND999' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
    expect(wooFetch.mock.calls.length - llamadasAntes).toBe(2);
    const putCall = wooFetch.mock.calls[wooFetch.mock.calls.length - 1];
    expect(putCall[2]).toBe('put');
    expect(putCall[3]).toEqual({ meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND999' }] });
    expect(putCall[3].status).toBeUndefined();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_corregido'").get();
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.detalle_json)).toEqual({ tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
  });

  it('POST /corregir-tracking: si no existe fila en preparaciones, igual corrige el tracking (evento se saltea fail-open)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'completed',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });
    const r = await request(app).post('/api/preparacion/seguimientos/906/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('GET /:id devuelve detalle con items, fotos y requisitos', async () => {
    const id = nuevaPrep();
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.items).toHaveLength(3);
    expect(r.body.data.items.find(i => i.sku === 'BICI-1').requisitos_foto.length).toBeGreaterThan(0);
  });

  it('GET /:id incluye eventos (más reciente primero)', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.body.data.eventos.length).toBe(2);
    expect(r.body.data.eventos[0].id).toBeGreaterThan(r.body.data.eventos[1].id);
  });

  it('GET /:id/eventos devuelve solo los eventos, sin items ni fotos', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const r = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(r.body.ok).toBe(true);
    expect(r.body.eventos).toHaveLength(1);
    expect(r.body.items).toBeUndefined();
  });

  it('heartbeat informa el id del último evento', async () => {
    const id = nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
    expect(r.body.ultimo_evento_id).toBe(0);
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
    expect(r.body.ultimo_evento_id).toBeGreaterThan(0);
  });

  it('escanear con match registra un evento tipo escaneo; no_coincide y sobrante no registran nada', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1', origen: 'camara' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'NOEXISTE' }); // no_coincide
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // match, sin origen -> default lector_teclado
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // sobrante (ya está 2/2)

    const eventos = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo' ORDER BY id").all(id);
    expect(eventos).toHaveLength(2);
    const d0 = JSON.parse(eventos[0].detalle_json);
    expect(d0).toMatchObject({ sku: 'CUB-1', cantidad_nueva: 1, cantidad_esperada: 2, origen: 'camara' });
    const d1 = JSON.parse(eventos[1].detalle_json);
    expect(d1.origen).toBe('lector_teclado');
    expect(eventos[0].usuario).toBe('tester');
  });

  it('escanear con origen fuera de la whitelist cae al default lector_teclado (no se puede simplificar a ||)', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1', origen: 'inyectado' });

    const evento = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
    expect(JSON.parse(evento.detalle_json).origen).toBe('lector_teclado');
  });

  it('confirmar-manual registra un evento tipo escaneo con origen manual', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);
    await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({
      sku: '', origen: 'manual', cantidad_nueva: item.cantidad_esperada, cantidad_esperada: item.cantidad_esperada,
    });
  });

  it('confirmar-manual dos veces seguidas sobre el mismo ítem no duplica el evento (re-confirmación es no-op)', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);

    await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
    const r2 = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
    expect(r2.body.ok).toBe(true);

    const eventos = db.prepare(
      "SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND item_id=? AND tipo='escaneo'"
    ).all(id, item.id);
    expect(eventos).toHaveLength(1);
  });

  it('subir foto registra un evento foto_subida', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const r = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_subida'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', tipo_foto: 'articulo', foto_id: r.body.foto.id });
  });

  it('purgarFotosBorradas borra archivo y fila si borrado_en tiene más de 60 días; conserva las más recientes', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();

    const vieja = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'vieja.jpg');
    const reciente = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'reciente.jpg');

    const hace70dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(hace70dias, vieja.body.foto.id);
    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(new Date().toISOString(), reciente.body.foto.id);

    const rutaVieja = rutaAbsoluta(vieja.body.foto.url);
    expect(fs.existsSync(rutaVieja)).toBe(true);

    const purgadas = purgarFotosBorradas(db);

    expect(purgadas).toBe(1);
    expect(fs.existsSync(rutaVieja)).toBe(false);
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(vieja.body.foto.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(reciente.body.foto.id)).toBeTruthy();
  });

  it('borrar foto NO borra la fila (soft-delete), registra evento foto_borrada, y deja de contar para /completar', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);

    const fila = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(fila).toBeTruthy(); // NO se borró la fila
    expect(fila.borrado_en).toBeTruthy();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', foto_id: fotoId, subida_por: 'tester' });

    const detalle = await request(app).get(`/api/preparacion/${id}`);
    const itemDetalle = detalle.body.data.items.find(i => i.id === item.id);
    expect(itemDetalle.fotos).toHaveLength(0); // la foto borrada no cuenta como presente
  });

  it('borrar la misma foto dos veces seguidas: la segunda es no-op y no duplica el evento foto_borrada', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    const r1 = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r1.body).toMatchObject({ ok: true, borradas: 1 });

    const r2 = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r2.body).toMatchObject({ ok: true, borradas: 0 });

    const eventos = db.prepare(
      "SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'"
    ).all(id);
    expect(eventos).toHaveLength(1);
  });

  it('borrar una foto sin evento foto_subida previo (foto preexistente) responde ok y subida_por queda null', async () => {
    const id = nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    // Simulamos una foto preexistente al ciclo de instrumentación: borramos su evento
    // foto_subida para que la búsqueda de subida_por no encuentre nada.
    db.prepare("DELETE FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_subida' AND json_extract(detalle_json,'$.foto_id')=?").run(id, fotoId);

    const r = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r.body).toMatchObject({ ok: true, borradas: 1 });

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ foto_id: fotoId, subida_por: null });
  });
});

import { wooFetch } from '../routes/woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { syncPedidosCache } from '../routes/preparacion.js';

describe('syncPedidosCache', () => {
  let db;
  const CFG = {
    woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
    ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
    andreaniStatus: 'lpaandreani',
    enviadoAndreaniStatus: 'enviadoandreani',
  };

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('guarda en pedidos_cache un pedido web pendiente (lpaandreani) con estado_envio=pendiente', async () => {
    const orderPend = {
      id: 900, number: '900', status: 'lpaandreani', date_created: '2026-07-01T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [],
      line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: 'BIKE-1', name: 'Bici', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [orderPend] })  // status=lpaandreani
      .mockResolvedValueOnce({ data: [] })            // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // pendientesMl (paid)

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:900');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
    expect(row.canal).toBe('web');
    expect(row.numero_pedido).toBe('900');
    expect(JSON.parse(row.items_json)).toHaveLength(1);
  });

  it('guarda en pedidos_cache un pedido web ya enviado (completed) con estado_envio=enviado', async () => {
    const orderEnv = {
      id: 950, number: '950', status: 'completed', date_created: '2026-07-05T00:00:00Z',
      billing: { first_name: 'Ana', last_name: 'Gomez' }, meta_data: [],
      line_items: [{ id: 2, product_id: 502, variation_id: 0, sku: 'CASCO-1', name: 'Casco', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [] })            // status=lpaandreani
      .mockResolvedValueOnce({ data: [orderEnv] })    // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:950');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('enviado');
  });

  it('no duplica candado: si ya hay una corrida en curso, la segunda llamada no hace fetch', async () => {
    let resolveWoo;
    wooFetch.mockImplementationOnce(() => new Promise(r => { resolveWoo = r; }));
    wooFetch.mockResolvedValue({ data: [] }); // llamadas siguientes (wcCompleted, wcEnviado), ya destrabado
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });
    const p1 = syncPedidosCache(db, CFG);
    await syncPedidosCache(db, CFG); // debe retornar de inmediato sin llamar wooFetch de nuevo
    expect(wooFetch).toHaveBeenCalledTimes(1);
    resolveWoo({ data: [] });
    await p1;
  });

  it('registra el resultado en sync_log con direccion=pedidos_cache', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log).toBeTruthy();
    expect(log.estado).toBe('ok');
  });

  it('si wooFetch falla, registra error en sync_log y no revienta el proceso', async () => {
    wooFetch.mockRejectedValueOnce(new Error('WC caído'));

    await expect(syncPedidosCache(db, CFG)).rejects.toThrow('WC caído');

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log.estado).toBe('error');
    expect(log.error).toContain('WC caído');
  });

  it('acota las consultas de pedidos enviados (completed/enviadoandreani) a los últimos 60 días con after=, y no acota los pendientes', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const [urlPend, urlCompleted, urlEnviado] = wooFetch.mock.calls.map(c => c[1]);
    expect(urlPend).not.toContain('after=');
    expect(urlCompleted).toMatch(/status=completed&after=/);
    expect(urlEnviado).toMatch(/status=enviadoandreani&after=/);
  });

  it('borra de pedidos_cache las filas enviado que quedaron fuera de la ventana de 60 días', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    const fechaVieja = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:100','web',100,NULL,'100','Viejo Cliente',?,'enviado','completed',0,NULL,NULL,'[]',?)
    `).run(fechaVieja, fechaVieja);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:100'").get();
    expect(row).toBeUndefined();
  });
});
