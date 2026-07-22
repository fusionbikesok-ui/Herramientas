import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { openDb } from '../db/index.js';
import {
  splitDireccion, splitTelefonoAr, normalizarEnvio,
  resolverPerfil, requisitosFoto, fotosFaltantes, esEnvioLocal,
} from '../lib/preparacion.js';
import { preparacionRouter, crearPreparacion } from '../routes/preparacion.js';

const TEST_DB = './test/tmp-preparacion.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  // simular usuario autenticado (el server real lo inyecta requireAuth)
  app.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani' }));
  return app;
}

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

  it('GET /:id devuelve detalle con items, fotos y requisitos', async () => {
    const id = nuevaPrep();
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.items).toHaveLength(3);
    expect(r.body.data.items.find(i => i.sku === 'BICI-1').requisitos_foto.length).toBeGreaterThan(0);
  });
});
