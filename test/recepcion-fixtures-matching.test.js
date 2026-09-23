import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { resolverLoteRecepcion } from '../lib/recepcionMatching.js';
import { confirmarAlias } from '../lib/recepcionAliases.js';

// Los 13 fixtures de test/fixtures/recepcion/ documentan casos reales que el matcher de
// recepción tiene que resolver (P1.3). No traen catálogo propio: cada fixture solo tiene
// las líneas del documento del proveedor. Este catálogo sintético fue construido para
// reproducir cada escenario (SKU único, duplicado, familia con hermanos, alias, etc.) y
// las aserciones abajo son el resultado REAL observado al correr resolverLoteRecepcion
// contra él, no un resultado supuesto de antemano.
const FIXTURES_DIR = path.join(process.cwd(), 'test/fixtures/recepcion');
const PROVEEDOR = 'Proveedor Prueba';

function cargarFixture(nombre) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, nombre), 'utf8'));
}

function construirCatalogo(db) {
  db.exec(`CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, nombre TEXT, sku TEXT, tipo TEXT, id_padre INTEGER, stock INTEGER, marca TEXT, atributos_json TEXT, gtin TEXT, actualizado_en TEXT)`);
  db.exec(`CREATE TABLE recepcion_aliases_proveedor (id INTEGER PRIMARY KEY AUTOINCREMENT, proveedor_norm TEXT, codigo_norm TEXT, descripcion_norm TEXT, variacion_norm TEXT, id_woo INTEGER, sku TEXT, recepcion_item_id INTEGER, creado_por TEXT, vigente_desde TEXT, vigente_hasta TEXT, motivo_cierre TEXT)`);

  const ins = db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,marca,atributos_json,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  // 01: SKU único
  ins.run(1, 'Casco Alpha', 'CASCO-ALPHA-001', 'simple', null, 4, 'Marca A', null, now);
  // 02: SKU duplicado (dos filas con el mismo sku)
  ins.run(10, 'Zapatilla Trail', 'ZAPA-001', 'simple', null, 5, 'Marca B', null, now);
  ins.run(11, 'Zapatilla Trail', 'ZAPA-001', 'simple', null, 3, 'Marca B', null, now);
  // 03/04/05/09: familia "Zapatilla Base" con hermanos que permiten ambigüedad y contradicción
  ins.run(20, 'Zapatilla Base', 'ZAPA-BASE-41-NEGRO', 'variation', null, 6, 'Marca B', JSON.stringify({ talle: '41', color: 'Negro' }), now);
  ins.run(21, 'Zapatilla Base', 'ZAPA-BASE-42-AZUL', 'variation', null, 7, 'Marca B', JSON.stringify({ talle: '42', color: 'Azul' }), now);
  ins.run(22, 'Zapatilla Base', 'ZAPA-BASE-43-NEGRO', 'variation', null, 8, 'Marca B', JSON.stringify({ talle: '43', color: 'Negro' }), now);
  // 10/11: alias válido y alias huérfano (ver confirmarAlias abajo)
  ins.run(5, 'Guante de Ciclismo', 'GUANTE-001', 'simple', null, 20, 'Marca A', null, now);

  confirmarAlias(db, { proveedor: PROVEEDOR, nombre_doc: 'Guante', codigo_proveedor: 'ALIAS-GUANTE-001', id_woo: 5, sku: 'GUANTE-001', recepcion_item_id: null, actor: 'test' });
  confirmarAlias(db, { proveedor: PROVEEDOR, nombre_doc: 'Producto Eliminado', codigo_proveedor: 'ALIAS-BORRADO-001', id_woo: 9999, sku: 'X', recepcion_item_id: null, actor: 'test' });
}

describe('resolverLoteRecepcion contra los 13 fixtures de recepción', () => {
  let db;
  beforeAll(() => {
    db = new Database(':memory:');
    construirCatalogo(db);
  });

  function resolverFixture(nombreArchivo) {
    const fx = cargarFixture(nombreArchivo);
    return { fx, resultados: resolverLoteRecepcion(db, PROVEEDOR, fx.items) };
  }

  it('01-sku-unico: SKU único matchea automáticamente al único producto con ese SKU', () => {
    const { resultados } = resolverFixture('01-sku-unico.json');
    expect(resultados[0].estado).toBe('resuelto');
    expect(resultados[0].auto_aplicable).toBe(true);
    expect(resultados[0].origen).toBe('sku_exacto');
    expect(resultados[0].candidato.id_woo).toBe(1);
  });

  it('02-sku-duplicado: el mismo SKU en dos productos exige revisión manual, no auto-aplica', () => {
    const { resultados } = resolverFixture('02-sku-duplicado.json');
    expect(resultados[0].estado).toBe('sku_duplicado');
    expect(resultados[0].auto_aplicable).toBe(false);
    expect(resultados[0].ambiguo).toBe(true);
    expect(resultados[0].candidatos).toHaveLength(2);
  });

  it('03-ambiguedad-hermanos: sin talle/color que desambigüe entre hermanos, requiere revisión', () => {
    const { resultados } = resolverFixture('03-ambiguedad-hermanos.json');
    expect(resultados[0].estado).toBe('revisar');
    expect(resultados[0].auto_aplicable).toBe(false);
    expect(resultados[0].ambiguo).toBe(true);
  });

  it('04-contradiccion-talle: el talle del documento no coincide con el del mejor candidato, requiere revisión', () => {
    const { resultados } = resolverFixture('04-contradiccion-talle.json');
    expect(resultados[0].estado).toBe('revisar');
    expect(resultados[0].auto_aplicable).toBe(false);
  });

  it('05-contradiccion-color: el color del documento no coincide con el del mejor candidato, requiere revisión', () => {
    const { resultados } = resolverFixture('05-contradiccion-color.json');
    expect(resultados[0].estado).toBe('revisar');
    expect(resultados[0].auto_aplicable).toBe(false);
  });

  it('06-producto-inexistente: ningún candidato en catálogo, sin match', () => {
    const { resultados } = resolverFixture('06-producto-inexistente.json');
    expect(resultados[0].estado).toBe('sin_match');
    expect(resultados[0].sin_candidato).toBe(true);
    expect(resultados[0].candidatos).toHaveLength(0);
  });

  it('07-producto-simple-nuevo: sin equivalente en catálogo, sin match (candidato a alta de borrador simple)', () => {
    const { resultados } = resolverFixture('07-producto-simple-nuevo.json');
    expect(resultados[0].estado).toBe('sin_match');
    expect(resultados[0].sin_candidato).toBe(true);
  });

  it('08-familia-variable-nueva: familia nueva sin equivalente exacto, requiere revisión (no auto-aplica una familia inexistente)', () => {
    const { resultados } = resolverFixture('08-familia-variable-nueva.json');
    expect(resultados).toHaveLength(2);
    for (const r of resultados) {
      expect(r.estado).toBe('revisar');
      expect(r.auto_aplicable).toBe(false);
    }
  });

  it('09-variacion-familia-existente: combinación talle/color nueva dentro de una familia existente, ambigua entre hermanos, requiere revisión', () => {
    const { resultados } = resolverFixture('09-variacion-familia-existente.json');
    expect(resultados[0].estado).toBe('revisar');
    expect(resultados[0].auto_aplicable).toBe(false);
    expect(resultados[0].ambiguo).toBe(true);
  });

  it('10-alias-valido: código de proveedor con alias vigente resuelve automático por el alias', () => {
    const { resultados } = resolverFixture('10-alias-valido.json');
    expect(resultados[0].estado).toBe('resuelto');
    expect(resultados[0].auto_aplicable).toBe(true);
    expect(resultados[0].origen).toBe('alias_proveedor');
    expect(resultados[0].candidato.id_woo).toBe(5);
  });

  it('11-alias-huerfano: el alias existe pero su id_woo ya no está en catálogo, sin match', () => {
    const { resultados } = resolverFixture('11-alias-huerfano.json');
    expect(resultados[0].estado).toBe('sin_match');
    expect(resultados[0].sin_candidato).toBe(true);
  });

  // 12 y 13 documentan escenarios de timeout/idempotencia del PATCH a Woo durante el E2E
  // (ver npm run e2e:recepcion-urgente), no de matching: sus códigos de proveedor no están
  // en ningún catálogo real porque lo que prueban es qué pasa cuando Woo no responde a
  // tiempo, no si el matcher encuentra un candidato. resolverLineaRecepcion, sin ese
  // contexto de red, correctamente no encuentra nada que matchear.
  it('12-timeout-antes-patch: fuera del alcance del matcher (escenario de timeout de red), sin match', () => {
    const { resultados } = resolverFixture('12-timeout-antes-patch.json');
    expect(resultados[0].estado).toBe('sin_match');
  });

  it('13-timeout-despues-patch: fuera del alcance del matcher (escenario de timeout de red), sin match', () => {
    const { resultados } = resolverFixture('13-timeout-despues-patch.json');
    expect(resultados[0].estado).toBe('sin_match');
  });
});
