import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { crearBorradorWoo, validarFichaAlta } from '../lib/nuevosProductosWoo.js';
const ficha={modo:'simple',titulo:'Casco Nuevo',marca:'Marca',categoria_id:17,categoria_nombre:'CASCOS',precio:'120000',descripcion:'',parent_id:null,atributos:[{nombre:'Color',valor:'Negro'}]};
function db(){
  const d=new Database(':memory:');
  d.exec('CREATE TABLE recepcion_altas_woo (operation_id TEXT PRIMARY KEY,request_hash TEXT,estado TEXT,modo TEXT,id_woo INTEGER,id_padre INTEGER,sku TEXT,respuesta_json TEXT,error TEXT,creado_por TEXT,creado_en TEXT,actualizado_en TEXT)');
  d.exec('CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, nombre TEXT, sku TEXT, tipo TEXT, id_padre INTEGER, stock INTEGER, no_contable INTEGER, regular_price TEXT, actualizado_en TEXT)');
  return d;
}
// Mock stateful: el SKU solo aparece en las respuestas DESPUÉS del PATCH que lo asigna — como en Woo real.
// P0.2 exige que la verificación final sea un GET, no la respuesta del PATCH: si el mock siempre
// devolviera el SKU (incluso antes del PATCH) no distinguiría "confía en el PATCH" de "verifica con GET".
function fetchWooDraft(calls) {
  let skuAsignado = null;
  return async (_c, path, method = 'get', body) => {
    calls.push({ path, method, body });
    if (method === 'post') return { data: { id: 44, status: 'draft', stock_quantity: 0 } };
    if (method === 'patch') { skuAsignado = body.sku; return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: skuAsignado } }; }
    return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: skuAsignado } };
  };
}
describe('validarFichaAlta — Task 5 Step 1: rechaza atributos repetidos', () => {
  it('rechaza dos atributos con el mismo nombre (case-insensitive)', () => {
    expect(() => validarFichaAlta({ ...ficha, atributos: [{ nombre: 'Color', valor: 'Negro' }, { nombre: 'color', valor: 'Azul' }] }))
      .toThrow(/atributos/);
  });
});

describe('crearBorradorWoo — Task 5 Step 1: padre inexistente/no variable', () => {
  it('rechaza variacion_existente cuyo parent_id no está en catalogo_cache', async () => {
    const x=db();
    const f={...ficha,modo:'variacion_existente',parent_id:9};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440010',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])}))
      .rejects.toThrow(/padre/i);
  });

  it('rechaza variacion_existente cuyo parent_id existe pero no es tipo "variable"', async () => {
    const x=db();
    x.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (9,?,?,?,?,?,?)')
      .run('Casco simple', 'FB-9', 'simple', null, 1, 'x');
    const f={...ficha,modo:'variacion_existente',parent_id:9};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440011',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])}))
      .rejects.toThrow(/padre/i);
  });

  it('no llama a Woo cuando el padre es inválido (falla antes de la red)', async () => {
    const x=db();
    const calls=[];
    const f={...ficha,modo:'variacion_existente',parent_id:9};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440012',ficha:f,actor:'j',fetchWoo:fetchWooDraft(calls)}))
      .rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('alta Woo fail-closed',()=>{
  it('crea draft con stock cero y no repite replay',async()=>{
    const calls=[];
    const fetchWoo=fetchWooDraft(calls);
    const x=db();
    const a=await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440000',ficha,actor:'j',fetchWoo});
    expect(a.sku).toBe('FB-44');
    expect(calls.some(c=>c.body?.status==='publish')).toBe(false);
    expect(calls.some(c=>c.body?.stock_quantity>0)).toBe(false);
    // P0.2: la verificación final es un GET después del PATCH del SKU, no la respuesta del PATCH.
    const getsFinales = calls.filter(c => c.method === 'get');
    expect(getsFinales.length).toBeGreaterThanOrEqual(2); // draft/stock-cero pre-PATCH + verificación post-PATCH
    const n=calls.length;
    expect(await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440000',ficha,actor:'j',fetchWoo})).toEqual(a);
    expect(calls.length).toBe(n);
  });

  it('P0.2: hace upsert atómico en catalogo_cache para que la recepción confirme sin esperar el sync', async () => {
    const calls=[];
    const fetchWoo=fetchWooDraft(calls);
    const x=db();
    const a=await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440001',ficha,actor:'j',fetchWoo});
    const row = x.prepare('SELECT * FROM catalogo_cache WHERE id_woo=?').get(a.id_woo);
    expect(row).toBeTruthy();
    expect(row.tipo).toBe('simple');
    expect(row.sku).toBe('FB-44');
    expect(row.stock).toBe(0);
    expect(row.id_padre).toBeNull();
  });

  it('P0.2: si catalogo_cache ya tenía esa fila (del sync real), el upsert NO la pisa', async () => {
    const calls=[];
    const fetchWoo=fetchWooDraft(calls);
    const x=db();
    // Fila "real", ya sincronizada, con datos que un borrador recién creado no tiene.
    x.prepare(
      'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,no_contable,regular_price,actualizado_en) VALUES (44,?,?,?,?,?,?,?,?)'
    ).run('Casco Real', 'FB-44-REAL', 'simple', null, 1, 1, '150000', 'x');
    await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440003',ficha,actor:'j',fetchWoo});
    const row = x.prepare('SELECT * FROM catalogo_cache WHERE id_woo=44').get();
    // Intacta: el alta no debe degradar una fila que ya viene del sync real.
    expect(row.nombre).toBe('Casco Real');
    expect(row.sku).toBe('FB-44-REAL');
    expect(row.stock).toBe(1);
    expect(row.no_contable).toBe(1);
    expect(row.regular_price).toBe('150000');
  });

  it('P0.2: rechaza el alta si el GET posterior al PATCH no confirma el SKU asignado', async () => {
    const calls=[];
    // Mock "hostil": el PATCH responde ok pero el GET posterior nunca ve el SKU (nunca llegó a Woo de verdad).
    const fetchWoo = async (_c, path, method='get', body) => {
      calls.push({ path, method, body });
      if (method === 'post') return { data: { id: 44, status: 'draft', stock_quantity: 0 } };
      if (method === 'patch') return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: body.sku } };
      return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: null } }; // el GET nunca confirma
    };
    const x=db();
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440002',ficha,actor:'j',fetchWoo}))
      .rejects.toThrow(/SKU/);
    // No debe haber quedado nada en catalogo_cache para un alta no confirmada.
    expect(x.prepare('SELECT * FROM catalogo_cache').all()).toHaveLength(0);
  });
});
