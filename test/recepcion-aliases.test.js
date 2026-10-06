import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { confirmarAlias, buscarAliasVigente, revocarAlias, normalizarProveedor } from '../lib/recepcionAliases.js';

function db() { const d=new Database(':memory:'); d.exec("CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, sku TEXT, nombre TEXT, tipo TEXT); CREATE TABLE recepcion_aliases_proveedor (id INTEGER PRIMARY KEY AUTOINCREMENT, proveedor_norm TEXT NOT NULL,codigo_norm TEXT NOT NULL DEFAULT '',descripcion_norm TEXT NOT NULL,variacion_norm TEXT NOT NULL DEFAULT '',id_woo INTEGER NOT NULL,sku TEXT,recepcion_item_id INTEGER,creado_por TEXT NOT NULL,vigente_desde TEXT NOT NULL,vigente_hasta TEXT,motivo_cierre TEXT); CREATE UNIQUE INDEX a ON recepcion_aliases_proveedor(proveedor_norm,codigo_norm) WHERE vigente_hasta IS NULL AND codigo_norm<>'';"); d.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?)').run(10,'FB-10','Casco','simple'); return d; }
describe('aliases de recepción', () => {
  let d; beforeEach(()=>{d=db();});
  it('normaliza y aísla proveedor',()=>{expect(normalizarProveedor('  Bike Group ')).toBe('bike group'); confirmarAlias(d,{proveedor:'Bike Group',codigo_proveedor:'BX-1',nombre_doc:'Casco',id_woo:10,actor:'jose'}); expect(buscarAliasVigente(d,{proveedor:'Otro',codigo_proveedor:'BX-1',nombre_doc:'Casco'})).toBeNull(); expect(buscarAliasVigente(d,{proveedor:'bike group',codigo_proveedor:'BX-1'}).id_woo).toBe(10);});
  it('reasignar al mismo id_woo no exige motivo (no hay nada que reemplazar de verdad)',()=>{confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:10,actor:'j'}); expect(()=>confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:10,actor:'j'})).not.toThrow();});
  it('reasignar la MISMA clave a OTRO id_woo exige motivo, y versiona (cierra la vieja, crea una nueva) cuando lo trae',()=>{
    d.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?)').run(11,'FB-11','Casco B','simple');
    const a = confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:10,actor:'j'});
    expect(()=>confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:11,actor:'j'})).toThrow(/motivo/);
    // Sin motivo, no se tocó nada: el alias original sigue vigente.
    expect(buscarAliasVigente(d,{proveedor:'p',codigo_proveedor:'x'}).id_woo).toBe(10);
    const b = confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:11,actor:'j',motivo:'producto discontinuado'});
    expect(b.id_woo).toBe(11);
    expect(db_alias_cerrado(d,a.id)).toBe(true);
    function db_alias_cerrado(db,id){ const r=db.prepare('SELECT vigente_hasta FROM recepcion_aliases_proveedor WHERE id=?').get(id); return r.vigente_hasta!=null; }
  });
  it('revoca solo la versión vigente',()=>{const a=confirmarAlias(d,{proveedor:'p',codigo_proveedor:'x',nombre_doc:'a',id_woo:10,actor:'j'}); expect(revocarAlias(d,a.id,{actor:'j',motivo:'corrección'})).toBe(true); expect(revocarAlias(d,a.id,{actor:'j',motivo:'otra'})).toBe(false);});
  it('un alias huérfano (id_woo ya no existe en catalogo_cache) se reemplaza sin SQLITE_CONSTRAINT_UNIQUE', () => {
    confirmarAlias(d, { proveedor: 'p', codigo_proveedor: 'x', nombre_doc: 'a', id_woo: 10, actor: 'j' });
    // El producto original del alias deja de existir en el catálogo (baja, error de sync, etc.):
    // buscarAliasVigente ahora lo trata como huérfano y devuelve null para esta clave.
    d.prepare('DELETE FROM catalogo_cache WHERE id_woo=10').run();
    expect(buscarAliasVigente(d, { proveedor: 'p', codigo_proveedor: 'x' })).toBeNull();
    d.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?)').run(11, 'FB-11', 'Casco nuevo', 'simple');
    // Reasignar a un id_woo válido no debe reventar contra el índice único de la fila huérfana,
    // y no debería exigir motivo: no hay ningún alias vigente y válido que se esté pisando.
    expect(() => confirmarAlias(d, { proveedor: 'p', codigo_proveedor: 'x', nombre_doc: 'a', id_woo: 11, actor: 'j' })).not.toThrow();
    expect(buscarAliasVigente(d, { proveedor: 'p', codigo_proveedor: 'x' }).id_woo).toBe(11);
  });
  it('punto 10: buscarAliasVigente rechaza alias vigente cuyo id_woo apunta a tipo=variable (padre no vendible)', () => {
    // Insertar un producto padre (no vendible)
    d.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?)').run(20, 'FB-20', 'Familia de cascos', 'variable');
    // Confirmar un alias apuntando a un producto vendible
    const alias = confirmarAlias(d, { proveedor: 'p1', codigo_proveedor: 'code1', nombre_doc: 'a', id_woo: 10, actor: 'j' });
    expect(alias.id_woo).toBe(10);
    expect(buscarAliasVigente(d, { proveedor: 'p1', codigo_proveedor: 'code1' }).id_woo).toBe(10);
    // Ahora cambiar el alias para que apunte a un producto padre (variable) — directamente en la BD para simular
    // un caso donde el sync cambió el tipo del producto después de crear el alias
    d.prepare('UPDATE recepcion_aliases_proveedor SET id_woo=? WHERE id=?').run(20, alias.id);
    // buscarAliasVigente debe devolver null porque ahora el id_woo apunta a tipo=variable
    expect(buscarAliasVigente(d, { proveedor: 'p1', codigo_proveedor: 'code1' })).toBeNull();
  });
  it('punto 11: confirmarAlias rechaza id_woo que apunta a tipo=variable o no existe en catalogo_cache', () => {
    // Caso 1: id_woo apunta a un tipo=variable
    d.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?)').run(30, 'FB-30', 'Familia de ruedas', 'variable');
    expect(() => confirmarAlias(d, { proveedor: 'p2', codigo_proveedor: 'code2', nombre_doc: 'b', id_woo: 30, actor: 'j' })).toThrow(/no corresponde a un producto vendible/);
    // Verificar que NO se insertó nada en recepcion_aliases_proveedor
    const count1 = d.prepare('SELECT COUNT(*) as c FROM recepcion_aliases_proveedor WHERE proveedor_norm=?').get('p2').c;
    expect(count1).toBe(0);

    // Caso 2: id_woo no existe en catalogo_cache
    expect(() => confirmarAlias(d, { proveedor: 'p3', codigo_proveedor: 'code3', nombre_doc: 'c', id_woo: 999, actor: 'j' })).toThrow(/no corresponde a un producto vendible/);
    const count2 = d.prepare('SELECT COUNT(*) as c FROM recepcion_aliases_proveedor WHERE proveedor_norm=?').get('p3').c;
    expect(count2).toBe(0);

    // Caso 3: id_woo válido (tipo=simple) debe funcionar normalmente
    const alias = confirmarAlias(d, { proveedor: 'p4', codigo_proveedor: 'code4', nombre_doc: 'd', id_woo: 10, actor: 'j' });
    expect(alias.id_woo).toBe(10);
    const count3 = d.prepare('SELECT COUNT(*) as c FROM recepcion_aliases_proveedor WHERE proveedor_norm=?').get('p4').c;
    expect(count3).toBe(1);
  });
});
