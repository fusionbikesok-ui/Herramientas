import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPhone, createCommerce } from '../lib/mensajeriaCommerce.js';

const NOW = Date.parse('2026-10-07T15:00:00Z');
const PHONE = '5493515214819';
const date = delta => new Date(NOW - delta).toISOString();
const rawOrder = (id, phone = PHONE, patch = {}) => ({ id, number: String(id), billing: { phone, first_name: 'Cliente', last_name: 'Prueba', email: 'privado@example.invalid', address_1: 'Dirección privada' }, status: 'completed', total: '12500.50', currency: 'ARS', created_at: date(id * 1000), items: [{ name: 'Bicicleta', quantity: 1 }], ...patch });

describe('Mensajería: productos locales y vínculo exacto de pedidos', () => {
  let db, folder, path, commerce, clock;
  function publish(orders, state = {}) {
    const next = join(folder, 'next.sqlite');
    const source = new Database(next);
    source.exec('CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE orders(id INTEGER PRIMARY KEY,data TEXT);');
    for (const [key, value] of Object.entries({ orders_at: date(0), completed_at: date(0), orders_complete: true, ...state }))
      source.prepare('INSERT INTO state VALUES(?,?)').run(key, JSON.stringify(value));
    for (const order of orders) source.prepare('INSERT INTO orders VALUES(?,?)').run(order.id, JSON.stringify(order));
    source.close(); renameSync(next, path);
  }
  const addProduct = (id, patch = {}) => db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en,img,precio,atributos_json,marca,gtin,regular_price)
    VALUES(@id_woo,@nombre,@sku,@tipo,@id_padre,@stock,@actualizado_en,@img,@precio,@atributos_json,@marca,@gtin,@regular_price)`).run({
      id_woo: id, nombre: 'Bicicleta Rúta Trek', sku: 'FB-' + id, tipo: 'simple', id_padre: null, stock: 3, actualizado_en: date(0),
      img: '', precio: 90000, atributos_json: '[]', marca: 'Trek', gtin: '', regular_price: 150000, ...patch,
    });
  beforeEach(() => {
    clock = NOW; folder = mkdtempSync(join(tmpdir(), 'mensajeria-commerce-')); path = join(folder, 'directory.sqlite');
    db = new Database(':memory:'); db.exec(`CREATE TABLE catalogo_cache(id_woo INTEGER PRIMARY KEY,nombre TEXT,sku TEXT,tipo TEXT,id_padre INTEGER,stock REAL,actualizado_en TEXT,img TEXT,precio REAL,atributos_json TEXT,marca TEXT,gtin TEXT,regular_price REAL);
      CREATE TABLE preparaciones(id INTEGER PRIMARY KEY,canal TEXT,wc_order_id INTEGER,ml_order_id TEXT,tracking TEXT,woo_paso1_incierto INTEGER,woo_paso2_pendiente INTEGER);`);
    commerce = createCommerce(db, { directoryPath: path, now: () => clock });
    publish([rawOrder(101), rawOrder(102, '5493518752035')]);
  });
  afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

  it.each(['+54 9 351 521-4819','5493515214819','543515214819','+54 (351) 521.4819','005493515214819','03515214819','3515214819'])('normaliza el teléfono AR completo %s', value => {
    expect(canonicalPhone(value)).toBe('543515214819');
  });
  it.each(['5214819','15 5214819','351 15 5214819','+54 351 15 5214819','no 3515214819','+54+3515214819','+0543515214819','001','1543215678','+54 351521481','+54 35152148199'])('no adivina una identidad a partir de %s', value => {
    expect(canonicalPhone(value)).toBe('');
  });
  it('sólo acepta otro país con prefijo internacional explícito', () => {
    expect(canonicalPhone('+1 202 555 0199')).toBe('12025550199');
    expect(canonicalPhone('0012025550199')).toBe('12025550199');
    expect(canonicalPhone('12025550199')).toBe('');
  });
  it('busca tokens y tildes con prioridad de SKU/GTIN exacto; usa precio vigente de la web', () => {
    addProduct(10, { nombre: 'Accesorio FB-20', gtin: '7790012345678' });
    addProduct(20, { nombre: 'Bicicleta Rúta Trek', precio: 90000, regular_price: 300000 });
    expect(commerce.products('ruta trek').products[0]).toMatchObject({ id: 20, price: 60000, stock: 3 });
    expect(commerce.products('FB-20').products.map(p => p.id)).toEqual([20, 10]);
    expect(commerce.products('7790012345678').products[0].id).toBe(10);
    expect(commerce.products('x').products).toEqual([]);
    expect(() => commerce.products('x'.repeat(101))).toThrow();
    expect(() => commerce.products('hola\n')).toThrow();
  });
  it('muestra variantes con miniatura del padre y vínculo público al producto', () => {
    addProduct(40, { tipo: 'variable', img: 'https://fusionbikes.com.ar/wp-content/uploads/2026/10/bici.webp', sku: 'PADRE' });
    addProduct(41, { tipo: 'variation', id_padre: 40, atributos_json: JSON.stringify([{ name: 'Color', option: 'Negro' }, { name: 'Talle', option: 'S' }]) });
    const found = commerce.products('PADRE');
    expect(found.products).toHaveLength(1);
    expect(found.products[0]).toMatchObject({ id: 41, image: 'https://fusionbikes.com.ar/wp-content/uploads/2026/10/bici.webp', variation: 'Color: Negro · Talle: S', url: 'https://fusionbikes.com.ar/?p=40' });
    expect(commerce.product(41)).toEqual(found.products[0]);
    expect(() => commerce.product(40)).toThrow();
  });
  it('no carga imágenes ajenas y conserva desconocidos de precio/stock', () => {
    addProduct(10, { img: 'https://otro.invalid/imagen.jpg', precio: null, stock: null });
    expect(commerce.product(10)).toMatchObject({ image: '', price: null, stock: null });
  });
  it('conserva miniaturas AVIF del catálogo y sigue rechazando dominios ajenos y SVG', () => {
    const image = 'https://fusionbikes.com.ar/wp-content/uploads/2026/09/DomaneSL5.avif';
    addProduct(11, { img: image });
    addProduct(12, { img: 'https://otro.invalid/imagen.avif' });
    addProduct(13, { img: image.replace('.avif', '.svg') });
    expect(commerce.product(11).image).toBe(image);
    expect(commerce.product(12).image).toBe('');
    expect(commerce.product(13).image).toBe('');
  });
  it('filtra stock antes del límite y no trata el desconocido como disponible', () => {
    for (let id=1;id<=35;id++) addProduct(id,{stock:0});
    addProduct(90,{stock:2});addProduct(91,{stock:null});
    expect(commerce.products('bici','instock').products.map(x=>x.id)).toEqual([90]);
    expect(commerce.products('bici','outofstock').products).toHaveLength(30);
    expect(commerce.products('FB-91','instock').products).toEqual([]);
    expect(commerce.products('FB-91','all').products[0].stock).toBeNull();
    expect(()=>commerce.products('bici','anything')).toThrow();
  });
  it('limita resultados y avisa que hay más y si la copia es vieja', () => {
    for (let i = 1; i <= 35; i++) addProduct(i, { actualizado_en: date(2 * 3600000) });
    expect(commerce.products('bici')).toMatchObject({ more: true, stale: true });
    expect(commerce.products('bici').products).toHaveLength(30);
  });
  it('no usa coincidencias parciales de teléfono ni nombre; no expone dirección o email', () => {
    expect(commerce.orders('+54 351 5214819').orders.map(o => o.id)).toEqual([101]);
    expect(commerce.orders('5493518752035').orders.map(o => o.id)).toEqual([102]);
    expect(commerce.orders('3511111111').orders).toEqual([]);
    expect(() => commerce.orders('5214819')).toThrow();
    const item = commerce.orderForPhone(PHONE, 101);
    expect(item).toMatchObject({ phone: '543515214819', invoice_available: null, tracking: [] });
    expect(JSON.stringify(item)).not.toContain('privado');
    expect(() => commerce.orderForPhone(PHONE, 102)).toThrow('No hay un pedido');
  });
  it('rechaza copia incompleta o con más de 24 h para compartir un pedido', () => {
    publish([rawOrder(101)], { orders_complete: false });
    expect(commerce.orders(PHONE).complete).toBe(false);
    expect(() => commerce.orderForPhone(PHONE, 101)).toThrow('sincronización completa');
    publish([rawOrder(101)], { orders_at: date(25 * 3600000) });
    expect(commerce.orders(PHONE).stale).toBe(true);
    expect(() => commerce.orderForPhone(PHONE, 101)).toThrow('sincronización completa');
  });
  it('detecta la publicación atómica incluso dentro del TTL sin retener el inode anterior', () => {
    expect(commerce.orders(PHONE).orders.map(o => o.id)).toEqual([101]);
    publish([rawOrder(201)]);
    expect(commerce.orders(PHONE).orders.map(o => o.id)).toEqual([201]);
    expect(() => commerce.orderForPhone(PHONE, 101)).toThrow();
  });
  it('no usa el índice anterior si la copia desaparece o está dañada', () => {
    commerce.orders(PHONE); rmSync(path);
    expect(() => commerce.orderForPhone(PHONE, 101)).toThrow('copia de pedidos');
    const broken = new Database(path); broken.exec('CREATE TABLE unrelated(id INTEGER)'); broken.close();
    expect(() => commerce.orders(PHONE)).toThrow('copia de pedidos');
  });
  it('devuelve hasta 50 pedidos ordenados y mantiene selección exacta fuera del recorte', () => {
    publish(Array.from({ length: 51 }, (_, i) => rawOrder(i + 1)));
    const result = commerce.orders(PHONE);
    expect(result).toMatchObject({ total: 51, more: true });
    expect(result.orders).toHaveLength(50); expect(result.orders[0].id).toBe(1);
    expect(commerce.orderForPhone(PHONE, 51).id).toBe(51);
  });
  it('sólo usa seguimiento Andreani local confirmado para ese pedido Woo, no ML ni exports', () => {
    const insert = db.prepare('INSERT INTO preparaciones VALUES(?,?,?,?,?,?,?)');
    insert.run(1, 'web', 101, null, '360000123456', 0, 0);
    insert.run(2, 'web', 102, null, '360000987654', 0, 0);
    insert.run(3, 'ml', 101, 'other', 'ML1234567', 0, 0);
    insert.run(4, 'web', 101, null, 'INCIERTO12', 1, 0);
    insert.run(5, 'web', 101, null, 'PENDIENTE12', 0, 1);
    insert.run(6, 'web', 101, null, 'https://malicioso.invalid', 0, 0);
    expect(commerce.orderForPhone(PHONE, 101).tracking).toEqual([{ carrier: 'Andreani', number: '360000123456', url: 'https://www.andreani.com/envio/360000123456' }]);
    publish([rawOrder(103, PHONE, { andreani: { exported_at: date(0), export_batch: 'export123456' } })]);
    expect(commerce.orderForPhone(PHONE, 103).tracking).toEqual([]);
  });
  it('falta de tabla de preparación no inventa seguimiento ni rompe pedidos', () => {
    db.exec('DROP TABLE preparaciones');
    expect(commerce.orderForPhone(PHONE, 101).tracking).toEqual([]);
  });
});
