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

  it('GET /:id y GET /:id/eventos no rompen si un evento tiene detalle_json inválido', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    db.prepare("UPDATE preparacion_eventos SET detalle_json='{rota' WHERE preparacion_id=?").run(id);

    const rDetalle = await request(app).get(`/api/preparacion/${id}`);
    expect(rDetalle.status).toBe(200);
    expect(rDetalle.body.data.eventos[0].detalle).toEqual({});

    const rEventos = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(rEventos.status).toBe(200);
    expect(rEventos.body.eventos[0].detalle).toEqual({});
  });

  it('GET /:id y GET /:id/eventos devuelven detalle:{} si detalle_json es el string literal "null"', async () => {
    // JSON.parse('null') no lanza excepción, devuelve `null` (no un objeto): caso aparte
    // del JSON inválido de arriba, que sí dispara el catch.
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    db.prepare("UPDATE preparacion_eventos SET detalle_json='null' WHERE preparacion_id=?").run(id);

    const rDetalle = await request(app).get(`/api/preparacion/${id}`);
    expect(rDetalle.status).toBe(200);
    expect(rDetalle.body.data.eventos[0].detalle).toEqual({});

    const rEventos = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(rEventos.status).toBe(200);
    expect(rEventos.body.eventos[0].detalle).toEqual({});
  });

  it('GET /:id/eventos?desde=N devuelve solo eventos con id>N', async () => {
    const id = nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const primeros = db.prepare("SELECT id FROM preparacion_eventos WHERE preparacion_id=?").all(id);
    const ultimoId = Math.max(...primeros.map(e => e.id));
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });

    const r = await request(app).get(`/api/preparacion/${id}/eventos?desde=${ultimoId}`);
    expect(r.body.ok).toBe(true);
    expect(r.body.eventos.every(e => e.id > ultimoId)).toBe(true);
    expect(r.body.eventos.length).toBe(2);
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

  it('purgarFotosBorradas NO borra archivo ni fila si la url resuelta cae fuera de uploads/ (defensa en profundidad)', async () => {
    const id = nuevaPrep();
    const hace70dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    // Fila insertada directamente en la tabla (sin pasar por guardarArchivo/sanitize),
    // simulando el caso hipotético de una url maliciosa que llegara por otra vía.
    const ins = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en, borrado_en) VALUES (?,?,?,?,?,?)')
      .run(id, null, 'articulo', '/uploads/../../../etc/passwd', new Date().toISOString(), hace70dias);
    const fotoId = ins.lastInsertRowid;

    const purgadas = purgarFotosBorradas(db);

    expect(purgadas).toBe(0);
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId)).toBeTruthy();
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

  // -- Override de perfil por SKU exacto (prioridad sobre la regla de categoria) --
  describe('override de perfil por SKU', () => {
    it('un SKU con regla propia tiene prioridad sobre la regla de categoria', () => {
      // La categoria diria 'sellado'...
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // ...pero este SKU puntual es en realidad un kit de transmision.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 950, numeroPedido: '950', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Producto generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('kit_transmision');
    });

    it('sin regla de SKU, sigue aplicando la regla de categoria como hasta ahora', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 951, numeroPedido: '951', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'CUALQUIERA', nombre: 'Otro producto', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('sellado');
    });

    it('item con sku vacio o null no rompe y cae a la regla de categoria (no matchea la fila "" si existiera)', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // Regla "vacia" maliciosa/accidental: no deberia poder matchear items sin sku.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 957, numeroPedido: '957', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: null, nombre: 'Sin sku', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: '', nombre: 'Sku vacio', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 3, product_id: 3, sku: '   ', nombre: 'Sku solo espacios', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['sellado', 'sellado', 'sellado']);
    });

    it('dos reglas de SKU distintas no se pisan entre si', () => {
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-A','kit_transmision',?)").run(new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-B','bici',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 958, numeroPedido: '958', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: 'KIT-A', nombre: 'A', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: 'KIT-B', nombre: 'B', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT sku, perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['kit_transmision', 'bici']);
    });

    it('GET /perfiles-sku devuelve las reglas guardadas', async () => {
      const r0 = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r0.body.data).toEqual([]);
      await request(app).put('/api/preparacion/perfiles-sku/ABC-1').send({ perfil: 'kit_transmision' });
      const r1 = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r1.body.data).toHaveLength(1);
      expect(r1.body.data[0]).toMatchObject({ sku: 'ABC-1', perfil: 'kit_transmision' });
    });

    it('PUT /perfiles-sku/:sku normaliza a mayusculas y hace upsert (no duplica)', async () => {
      await request(app).put('/api/preparacion/perfiles-sku/xyz-9').send({ perfil: 'bici' });
      await request(app).put('/api/preparacion/perfiles-sku/XYZ-9').send({ perfil: 'kit_transmision' });
      const r = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0].perfil).toBe('kit_transmision');
    });

    it('PUT /perfiles-sku/:sku con perfil invalido -> 400', async () => {
      const r = await request(app).put('/api/preparacion/perfiles-sku/ABC-2').send({ perfil: 'invalido' });
      expect(r.status).toBe(400);
    });

    it('DELETE /perfiles-sku/:sku borra la regla', async () => {
      await request(app).put('/api/preparacion/perfiles-sku/DEL-1').send({ perfil: 'bici' });
      await request(app).delete('/api/preparacion/perfiles-sku/DEL-1');
      const r = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r.body.data).toHaveLength(0);
    });

    it('el match de SKU es exacto, no substring', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 952, numeroPedido: '952', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: 'KIT-7777', nombre: 'Mas largo', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: 'KIT-77', nombre: 'Mas corto', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 3, product_id: 3, sku: 'KIT-777', nombre: 'Exacto', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT sku, perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['sellado', 'sellado', 'kit_transmision']);
    });

    it('el trim() aplica en ambas puntas: al guardar la regla y al resolver el item', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // Regla guardada con espacios alrededor -> se normaliza sin espacios.
      await request(app).put(`/api/preparacion/perfiles-sku/${encodeURIComponent('  KIT-888  ')}`).send({ perfil: 'kit_transmision' });
      const reglas = db.prepare('SELECT sku FROM preparacion_perfiles_sku').all();
      expect(reglas.map(r => r.sku)).toEqual(['KIT-888']);

      // Item con SKU con espacios alrededor -> igual matchea la regla.
      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 953, numeroPedido: '953', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: '  KIT-888  ', nombre: 'Con espacios', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('kit_transmision');
    });

    // -- requisitos_foto: la regla de SKU cortocircuita la de categoria --
    const requisitosDelPrimerItem = async (id) => {
      const r = await request(app).get(`/api/preparacion/${id}`);
      return r.body.data.items[0].requisitos_foto;
    };

    it('requisitos_json de la regla de SKU gana sobre el de la categoria', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en) VALUES ('KIT-777','kit_transmision',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['piezas'], min: 2, etiqueta: 'DE SKU' }] }), new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 954, numeroPedido: '954', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual([{ tipos: ['piezas'], min: 2, etiqueta: 'DE SKU' }]);
    });

    it('requisitos_json invalido en la regla de SKU cae a la heuristica base sin lanzar', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en) VALUES ('KIT-777','kit_transmision','{no-es-json',?)")
        .run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 955, numeroPedido: '955', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual(requisitosFoto('kit_transmision', null));
    });

    it('override de perfil por SKU sin requisitos_json propio usa la heuristica del perfil nuevo, no la de la categoria', async () => {
      // La categoria tiene requisitos_json propios (perfil 'sellado')...
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      // ...pero el SKU fuerza el perfil kit_transmision sin requisitos propios.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 956, numeroPedido: '956', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual(requisitosFoto('kit_transmision', null));
    });
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
    // Fecha relativa, adentro de la ventana móvil de 60 días para 'enviado' (routes/preparacion.js
    // línea ~1296): si se hardcodea una fecha absoluta, el test se pudre solo cuando pasan
    // 60 días y la fila queda podada antes de que la aserción la vea.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const orderEnv = {
      id: 950, number: '950', status: 'completed', date_created: haceCincoDias,
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
    expect(urlCompleted).toMatch(/status=completed&dates_are_gmt=true&after=/);
    expect(urlEnviado).toMatch(/status=enviadoandreani&dates_are_gmt=true&after=/);
  });

  // `dates_are_gmt=true` es obligatorio junto con `after` (incidente 2026-07-29): sin él,
  // Woo interpreta `after` en hora local del sitio (UTC-3) en vez de UTC, y el rango pedido
  // queda corrido, produciendo falsos negativos. Se verifica explícito en ambas consultas
  // acotadas por fecha (completed y enviadoandreani), no solo que "contengan after=".
  it('las dos consultas acotadas por fecha (completed, enviadoandreani) incluyen dates_are_gmt=true', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const [, urlCompleted, urlEnviado] = wooFetch.mock.calls.map(c => c[1]);
    expect(urlCompleted).toContain('dates_are_gmt=true');
    expect(urlEnviado).toContain('dates_are_gmt=true');
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

  it('poda de pedidos_cache las filas ML pendientes que ya no están ready_to_ship (pedido despachado)', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    // Fecha relativa, adentro de la ventana móvil de 30 días que usa la poda ML (routes/preparacion.js
    // línea ~1308): con fecha absoluta el test se pudre solo cuando pasan 30 días.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 2222, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'compradorNuevo' }, shipping: { id: 555 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } }); // shipments/555

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
    const filaNueva = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:2222'").get();
    expect(filaNueva).toBeTruthy();
    expect(filaNueva.estado_envio).toBe('pendiente');
  });

  it('guard fail-closed: si pendientesMl devuelve vacío pero confiable (sin truncar, sin fallos), SÍ poda (nada quedó pendiente de verdad)', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario en el test anterior).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // orders/search: sin resultados, listado confiable

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
  });

  it('la poda NO borra filas web ni filas ML ya enviado, solo pendientes ML ausentes del listado vigente', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES
        ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?),
        ('web:200','web',200,NULL,'200','Cliente Web',?,'pendiente','lpaandreani',0,NULL,NULL,'[]',?),
        ('ml:3333','ml',NULL,'3333','3333','Cliente Enviado ML',?,'enviado',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // sin pendientes vigentes, listado confiable

    await syncPedidosCache(db, CFG);

    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:200'").get()).toBeTruthy();
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:3333'").get()).toBeTruthy();
  });

  it('si falla un GET /shipments/:id, la poda se omite esa corrida (listado no confiable)', async () => {
    buildTestApp(db);
    // Fecha relativa por consistencia (no participa de la comparación de ventana acá, porque
    // mlConfiable queda en false y la poda se omite entera, pero evita confusión a futuro).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 2222, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'compradorNuevo' }, shipping: { id: 555 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 500, data: {} }); // shipments/555 falla

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeTruthy();
    expect(filaVieja.estado_envio).toBe('pendiente');
  });

  it('con más de 50 órdenes paid, pagina /orders/search hasta agotar el resultado (no se queda con la primera página) y sí poda si queda confiable', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    // Sin shipping.id para no tener que mockear /shipments por cada una: lo que importa acá
    // es que la paginación agote las 2 páginas, no el filtrado de shipments.
    const pagina1 = Array.from({ length: 50 }, (_, i) => ({
      id: 9000 + i, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: null, order_items: [],
    }));
    const pagina2 = [
      { id: 9100, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'y' }, shipping: null, order_items: [] },
      { id: 9101, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'z' }, shipping: null, order_items: [] },
    ];

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: pagina1 } }) // orders/search offset=0
      .mockResolvedValueOnce({ status: 200, data: { results: pagina2 } }); // orders/search offset=50

    await syncPedidosCache(db, CFG);

    const urlsOrdersSearch = mlFetch.mock.calls.filter(c => c[3]?.includes('/orders/search')).map(c => c[3]);
    expect(urlsOrdersSearch).toHaveLength(2);
    expect(urlsOrdersSearch[0]).toContain('offset=0');
    expect(urlsOrdersSearch[1]).toContain('offset=50');

    // Ninguna orden tiene shipping.id, así que pendientesMl no encuentra pendientes vigentes,
    // pero pudo confirmarlo (paginación agotada, sin fallos) -> poda de la fila vieja.
    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
  });

  it('fila ml:vieja con fecha anterior a la ventana de 30 días NO se poda aunque no aparezca en el listado vigente', async () => {
    buildTestApp(db);
    const fechaFueraDeVentana = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:vieja','ml',NULL,'vieja','vieja','Cliente Fuera De Ventana',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(fechaFueraDeVentana, fechaFueraDeVentana);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // listado confiable, sin pendientes vigentes

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:vieja'").get();
    expect(fila).toBeTruthy();
  });

  it('fila ml:vieja con fecha en offset de zona horaria distinto a UTC se poda según su tiempo real (comparación normalizada, no texto plano)', async () => {
    buildTestApp(db);
    // '-04:00' es lexicográficamente MENOR que 'Z' -- con comparación de texto plano
    // ("...-04:00" >= "...Z" como strings) esta fecha se leería como más vieja de lo que es
    // en tiempo real y podría quedar mal clasificada según el corte de 30 días.
    // Instante real: 20 días atrás (bien adentro de la ventana de 30 días), pero escrito
    // con offset -04:00 en vez de 'Z' -- mismo instante, distinta representación de texto.
    const veinteDiasAtrasUtc = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    const mismoInstanteOffset4 = new Date(veinteDiasAtrasUtc.getTime() + 4 * 3600 * 1000)
      .toISOString().replace('Z', '-04:00');
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:vieja','ml',NULL,'vieja','vieja','Cliente Offset TZ',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(mismoInstanteOffset4, mismoInstanteOffset4);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // listado confiable, sin pendientes vigentes

    await syncPedidosCache(db, CFG);

    // El instante real está dentro de la ventana de 30 días -> debe podarse porque no
    // aparece en el listado vigente ML. Con comparación de texto plano ignorando el offset,
    // este caso podía quedar mal clasificado según el corte.
    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:vieja'").get();
    expect(fila).toBeUndefined();
  });

  it('una fila con preparación completada no se poda aunque no aparezca en el listado de pendientesMl', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba). Esta
    // fila igual queda a salvo por el filtro de estado_prep='completada' de la poda, pero se
    // mantiene dentro de la ventana para que el test siga probando ese camino y no el otro
    // (fuera de ventana), que ya se cubre en un test aparte.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Completado',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:1111', 'completada', 0, ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // no vuelve a aparecer: pendientesMl no la refetchea

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(fila).toBeTruthy();
  });

  it('borra de pedidos_cache una fila ml pendiente cuya preparación se completó hace más de 60 días (limpieza por antigüedad)', async () => {
    buildTestApp(db);
    const hace70Dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:2222','ml',NULL,'2222','2222','Cliente Viejo','2026-01-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en)
      VALUES ('ml', 'ml:2222', 'completada', 1, '2026-01-01T00:00:00Z', ?)
    `).run(hace70Dias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:2222'").get();
    expect(fila).toBeUndefined();
  });

  it('NO borra una fila ml pendiente cuya preparación se completó hace 10 días (sigue en la tabla, aunque no aparezca en /pendientes)', async () => {
    buildTestApp(db);
    const hace10Dias = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:3333','ml',NULL,'3333','3333','Cliente Reciente','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en)
      VALUES ('ml', 'ml:3333', 'completada', 1, '2026-07-01T00:00:00Z', ?)
    `).run(hace10Dias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:3333'").get();
    expect(fila).toBeTruthy();
  });

  it('GET /pendientes no muestra una fila cuya preparación local ya está completada (bug real: pedido ya entregado seguía en la cola)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:2000017571249972','ml',NULL,'2000017571249972','2000017571249972','Cliente Ya Entregado','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en, preparado_por)
      VALUES ('ml', 'ml:2000017571249972', 'completada', 1, '2026-07-24T00:00:00Z', '2026-07-24T01:00:00Z', 'Joaco')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.find(p => p.ml_order_id === '2000017571249972')).toBeUndefined();
  });

  it('GET /pendientes no muestra una fila con preparación en pendiente_deposito (tiene pantalla propia en Historial)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:3333','ml',NULL,'3333','3333','Cliente Deposito','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:3333', 'pendiente_deposito', 0, '2026-07-24T00:00:00Z')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.body.data.find(p => p.ml_order_id === '3333')).toBeUndefined();
  });

  it('GET /pendientes SÍ muestra filas sin preparación todavía o en_preparacion (no rompe el flujo normal)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:4444','ml',NULL,'4444','4444','Cliente Sin Preparar','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:5555','ml',NULL,'5555','5555','Cliente En Preparacion','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:5555', 'en_preparacion', 0, '2026-07-24T00:00:00Z')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.body.data.find(p => p.ml_order_id === '4444')).toBeTruthy();
    expect(r.body.data.find(p => p.ml_order_id === '5555')).toBeTruthy();
  });
});
