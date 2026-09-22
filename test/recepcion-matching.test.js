import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolverLoteRecepcion } from '../lib/recepcionMatching.js';
import { confirmarAlias } from '../lib/recepcionAliases.js';

function d() {
  const x = new Database(':memory:');
  x.exec(`
    CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY,id_padre INTEGER,sku TEXT,nombre TEXT,tipo TEXT,stock INTEGER,atributos_json TEXT,marca TEXT);
    CREATE TABLE recepcion_aliases_proveedor (id INTEGER PRIMARY KEY AUTOINCREMENT, proveedor_norm TEXT NOT NULL,codigo_norm TEXT NOT NULL DEFAULT '',descripcion_norm TEXT NOT NULL,variacion_norm TEXT NOT NULL DEFAULT '',id_woo INTEGER NOT NULL,sku TEXT,recepcion_item_id INTEGER,creado_por TEXT NOT NULL,vigente_desde TEXT NOT NULL,vigente_hasta TEXT,motivo_cierre TEXT);
    CREATE UNIQUE INDEX recepcion_alias_codigo_vigente ON recepcion_aliases_proveedor(proveedor_norm,codigo_norm) WHERE vigente_hasta IS NULL AND codigo_norm <> '';
    CREATE UNIQUE INDEX recepcion_alias_descripcion_vigente ON recepcion_aliases_proveedor(proveedor_norm,descripcion_norm,variacion_norm) WHERE vigente_hasta IS NULL AND codigo_norm = '';
    INSERT INTO catalogo_cache VALUES (1,NULL,'SKU-1','Casco Alpha Gris 42','simple',4,NULL,'Marca');
    INSERT INTO catalogo_cache VALUES (2,9,'SKU-2','Zapatilla Base Negro 41','variation',2,'[{"name":"Talle","option":"41"},{"name":"Color","option":"Negro"}]','Marca');
    INSERT INTO catalogo_cache VALUES (3,9,'SKU-3','Zapatilla Base Negro 43','variation',3,'[{"name":"Talle","option":"43"},{"name":"Color","option":"Negro"}]','Marca');
    INSERT INTO catalogo_cache VALUES (9,NULL,NULL,'Zapatilla Base','variable',NULL,NULL,'Marca');
    INSERT INTO catalogo_cache VALUES (5,NULL,NULL,'Guante Trail Rojo','simple',6,NULL,'Marca');
  `);
  return x;
}

describe('matching backend de recepción — lib/recepcionMatching.js', () => {
  it('resuelve SKU único y no duplica SKU', () => {
    const x = d();
    let r = resolverLoteRecepcion(x, 'P', [{ linea_id: '1', nombre_doc: 'x', codigo_proveedor: 'SKU-1' }])[0];
    expect(r.auto_aplicable).toBe(true);
    x.prepare("INSERT INTO catalogo_cache VALUES (4,NULL,'SKU-1','Otro','simple',1,NULL,'M')").run();
    r = resolverLoteRecepcion(x, 'P', [{ linea_id: '2', nombre_doc: 'x', codigo_proveedor: 'SKU-1' }])[0];
    expect(r.auto_aplicable).toBe(false);
    expect(r.estado).toBe('sku_duplicado');
  });

  it('no autoasigna hermanos sin atributo declarado en el documento (ambiguo)', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '3', nombre_doc: 'Zapatilla Base Negro' }])[0];
    expect(r.auto_aplicable).toBe(false);
    expect(r.ambiguo).toBe(true);
  });

  it('sin ningún candidato usable, estado es "sin_match" (no "revisar")', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '4', nombre_doc: 'Producto que no existe en ningún lado xyz123' }])[0];
    expect(r.estado).toBe('sin_match');
    expect(r.auto_aplicable).toBe(false);
    expect(r.sin_candidato).toBe(true);
  });

  it('contradicción de talle: nunca auto_aplicable, y el estado es "contradiccion" (no "resuelto")', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '5', nombre_doc: 'Zapatilla Base Negro', talle: '45' }])[0];
    expect(r.auto_aplicable).toBe(false);
    expect(r.estado).toBe('contradiccion');
  });

  it('contradicción de color: nunca auto_aplicable', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '6', nombre_doc: 'Zapatilla Base Negro', talle: '41', color: 'Azul' }])[0];
    expect(r.auto_aplicable).toBe(false);
    expect(r.estado).toBe('contradiccion');
  });

  it('talle correcto (sin contradicción) sí autoaplica al hermano correspondiente', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '7', nombre_doc: 'Zapatilla Base Negro', talle: '41' }])[0];
    expect(r.auto_aplicable).toBe(true);
    expect(r.candidato.id_woo).toBe(2);
  });

  it('las razones son objetos estructurados {tipo, resultado}, no strings sueltos', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '8', nombre_doc: 'Zapatilla Base Negro', talle: '45' }])[0];
    const razonTalle = r.candidato.razones.find(x => x.tipo === 'talle');
    expect(razonTalle).toBeTruthy();
    expect(razonTalle.resultado).toBe('contradice');
    expect(razonTalle.documento).toBe('45');
    r.candidatos.forEach(c => c.razones.forEach(rz => {
      expect(typeof rz).toBe('object');
      expect(rz.tipo).toBeTruthy();
      expect(rz.resultado).toBeTruthy();
    }));
  });

  it('un padre variable (tipo "variable") nunca es candidato: no es vendible', () => {
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '9', nombre_doc: 'Zapatilla Base' }])[0];
    expect(r.candidatos.every(c => c.id_woo !== 9)).toBe(true);
    // Y tampoco por código: el padre no tiene SKU propio, pero si lo tuviera no debería colarse.
  });

  it('un alias huérfano (su id_woo ya no está en catalogo_cache) cae al matcher en vez de romper', () => {
    const x = d();
    confirmarAlias(x, { proveedor: 'P', codigo_proveedor: 'AL-1', nombre_doc: 'Guante', id_woo: 5, actor: 'j' });
    x.prepare('DELETE FROM catalogo_cache WHERE id_woo=5').run();
    const r = resolverLoteRecepcion(x, 'P', [{ linea_id: '10', nombre_doc: 'Guante Trail Rojo', codigo_proveedor: 'AL-1' }])[0];
    expect(r.origen).not.toBe('alias_proveedor');
    expect(r.estado).toBe('sin_match'); // el producto del alias ya no existe, y no matchea ningún otro
  });

  it('resolverLoteRecepcion excluye productos sin SKU del universo de matching (por diseño, ver query)', () => {
    // Guante Trail Rojo (id_woo 5) no tiene SKU: aunque el texto coincida exacto, no debe aparecer.
    const r = resolverLoteRecepcion(d(), 'P', [{ linea_id: '11', nombre_doc: 'Guante Trail Rojo' }])[0];
    expect(r.candidatos.every(c => c.id_woo !== 5)).toBe(true);
  });
});
