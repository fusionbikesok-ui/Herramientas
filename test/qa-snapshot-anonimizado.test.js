import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { verifyPassword } from '../lib/auth.js';
import {
  anonimizarBase, generarSnapshot, verificarListaCerrada, tomarMuestra, buscarDatosReales, limpiarJson,
} from '../scripts/qa/snapshot-anonimizado.mjs';

const ORIGEN = './test/tmp-qa-origen.sqlite';
const DESTINO = './test/tmp-qa-destino.sqlite';
const CLAVE = 'clave-qa-de-prueba-123';
const EMAIL = 'maria.gonzalez.real@gmail.com';
const NICK = 'MARIAGONZALEZ77';

function limpiar() {
  for (const base of [ORIGEN, DESTINO]) {
    for (const f of [base, `${base}-wal`, `${base}-shm`, `${base}-journal`]) fs.rmSync(f, { force: true });
  }
}

function sembrar() {
  const db = openDb(ORIGEN);
  const ahora = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en, email)
              VALUES ('joaco', 'scrypt$aa$bb', 0, 1, ?, ?, 'joaco.real@fusionbikes.com.ar')`).run(ahora, ahora);
  db.prepare(`INSERT INTO gestion_pedido_clientes (nombre, email, telefono, documento, creado_en, actualizado_en)
              VALUES ('María González Real', ?, '1155667788', '30111222', ?, ?)`).run(EMAIL, ahora, ahora);
  db.prepare(`INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
              VALUES ('2000000001', 10, ?, ?)`).run(JSON.stringify({ id: 99, nickname: NICK, first_name: 'María', phone: { area_code: '11', number: '55667788' } }), ahora);
  db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
              VALUES (1, 'APP_USR-secreto', 'TG-secreto', 0, ?)`).run(ahora);
  db.close();
}

describe('scripts/qa/snapshot-anonimizado', () => {
  afterEach(limpiar);

  it('limpiarJson borra datos de personas y conserva datos de producto', () => {
    const r = limpiarJson({
      buyer: { id: 5, nickname: NICK, email: EMAIL },
      comment: 'dejar en portería',
      order_items: [{ item: { title: 'Cubierta Continental', variation_attributes: [{ name: 'Rodado', value_name: '29' }] } }],
      shipping: { receiver_address: { street_name: 'Av. Real 123' } },
    });
    expect(r.buyer).toEqual({ id: 5, nickname: '[anonimizado]' });
    expect(r.comment).toBe('[anonimizado]');
    expect(r.order_items[0].item.title).toBe('Cubierta Continental');
    expect(r.order_items[0].item.variation_attributes[0]).toEqual({ name: 'Rodado', value_name: '29' });
    expect(r.shipping.receiver_address).toBeNull();
  });

  it('el esquema real completo está clasificado en la lista cerrada', () => {
    const db = openDb(ORIGEN);
    try { expect(() => verificarListaCerrada(db)).not.toThrow(); } finally { db.close(); }
  });

  it('falla ante una columna JSON nueva sin clasificar', () => {
    const db = openDb(ORIGEN);
    try {
      db.exec('ALTER TABLE users ADD COLUMN preferencias_json TEXT');
      expect(() => anonimizarBase(db, { claveQa: CLAVE })).toThrow(/users\.preferencias_json/);
    } finally { db.close(); }
  });

  it('anonimiza clientes, compradores, secretos y usuarios internos', () => {
    sembrar();
    const db = openDb(ORIGEN);
    try {
      anonimizarBase(db, { claveQa: CLAVE });
      const cliente = db.prepare('SELECT * FROM gestion_pedido_clientes').get();
      expect(cliente).toMatchObject({ nombre: `Cliente ${cliente.id}`, email: `cliente${cliente.id}@qa.invalid`, telefono: `QA-TEL-${cliente.id}`, documento: `QA-DOC-${cliente.id}` });
      const comprador = JSON.parse(db.prepare('SELECT comprador_json FROM ordenes_ml_wc_pedidos').get().comprador_json);
      expect(comprador).toEqual({ id: 99, nickname: '[anonimizado]', first_name: '[anonimizado]', phone: null });
      expect(db.prepare('SELECT COUNT(*) n FROM ml_oauth_token').get().n).toBe(0);
      const user = db.prepare("SELECT * FROM users WHERE username = 'joaco'").get();
      expect(user.email).toBe(`usuario${user.id}@qa.invalid`);
      expect(verifyPassword(CLAVE, user.pass_hash)).toBe(true);
    } finally { db.close(); }
  });

  it('exige una clave de QA de al menos 12 caracteres', () => {
    const db = openDb(ORIGEN);
    try { expect(() => anonimizarBase(db, { claveQa: 'corta' })).toThrow(/clave/i); } finally { db.close(); }
  });

  it('la verificación detecta un dato real que sobrevivió en una columna no anonimizada', () => {
    sembrar();
    const db = openDb(ORIGEN);
    try {
      const muestra = tomarMuestra(db);
      expect(muestra).toEqual(expect.arrayContaining([EMAIL, NICK]));
      anonimizarBase(db, { claveQa: CLAVE });
      expect(buscarDatosReales(db, muestra)).toBeNull();
      db.prepare(`INSERT INTO etiquetas_cola (sku, cantidad, origen, nota, estado, creado_en) VALUES ('X', 1, 'manual', ?, 'pendiente', ?)`)
        .run(`reclamo de ${EMAIL}`, new Date().toISOString());
      expect(buscarDatosReales(db, muestra)).toMatchObject({ tabla: 'etiquetas_cola', columna: 'nota', valor: EMAIL });
    } finally { db.close(); }
  });

  it('un teléfono real dentro de un número más largo no es hallazgo, pero sí lo es como número completo', () => {
    const db = openDb(ORIGEN);
    try {
      const ahora = new Date().toISOString();
      const insertar = db.prepare(`INSERT INTO etiquetas_cola (sku, cantidad, origen, nota, estado, creado_en) VALUES ('X', 1, 'manual', ?, 'pendiente', ?)`);
      insertar.run('espesor 91155667788001 mm', ahora);
      expect(buscarDatosReales(db, ['1155667788'])).toBeNull();
      insertar.run('llamar al 1155667788 a la tarde', ahora);
      expect(buscarDatosReales(db, ['1155667788'])).toMatchObject({ tabla: 'etiquetas_cola', valor: '1155667788' });
    } finally { db.close(); }
  });

  it('generarSnapshot deja un archivo sin rastros del dato real en sus bytes y no toca el origen', async () => {
    sembrar();
    const r = await generarSnapshot(ORIGEN, DESTINO, { claveQa: CLAVE });
    expect(r.muestra).toBeGreaterThan(0);
    const bytes = fs.readFileSync(DESTINO);
    expect(bytes.includes(Buffer.from(EMAIL))).toBe(false);
    expect(bytes.includes(Buffer.from('TG-secreto'))).toBe(false);
    const origen = openDb(ORIGEN);
    try { expect(origen.prepare('SELECT email FROM gestion_pedido_clientes').get().email).toBe(EMAIL); } finally { origen.close(); }
  });

  it('generarSnapshot no pisa un destino existente', async () => {
    sembrar();
    fs.writeFileSync(DESTINO, 'no tocar');
    await expect(generarSnapshot(ORIGEN, DESTINO, { claveQa: CLAVE })).rejects.toThrow(/ya existe/);
    expect(fs.readFileSync(DESTINO, 'utf8')).toBe('no tocar');
  });
});
