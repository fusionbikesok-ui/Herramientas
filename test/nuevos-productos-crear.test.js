import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { crearBorradorWoo, validarFichaAlta, hashFichaCanonica, conciliarAltaIncierta } from '../lib/nuevosProductosWoo.js';

const ficha={modo:'simple',titulo:'Casco Nuevo',marca:'Marca',categoria_id:17,categoria_nombre:'CASCOS',precio:'120000',descripcion:'',parent_id:null,atributos:[{nombre:'Color',valor:'Negro'}]};

function db(){
  const d=new Database(':memory:');
  d.exec('CREATE TABLE recepcion_altas_woo (operation_id TEXT PRIMARY KEY,request_hash TEXT,estado TEXT,modo TEXT,id_woo INTEGER,id_padre INTEGER,sku TEXT,respuesta_json TEXT,error TEXT,creado_por TEXT,creado_en TEXT,actualizado_en TEXT)');
  d.exec('CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, nombre TEXT, sku TEXT, tipo TEXT, id_padre INTEGER, stock INTEGER, no_contable INTEGER, regular_price TEXT, actualizado_en TEXT)');
  return d;
}

const CATS = [{ id: 17, name: 'CASCOS', parent: 0 }, { id: 1, name: 'C', parent: 0 }];

// Mock stateful: el SKU solo aparece en las respuestas DESPUÉS del PATCH que lo asigna — como en Woo real.
// P0.2 exige que la verificación final sea un GET, no la respuesta del PATCH: si el mock siempre
// devolviera el SKU (incluso antes del PATCH) no distinguiría "confía en el PATCH" de "verifica con GET".
// Responde también /products/categories (validación de categoría) y /variations (combinación ya
// usada), para que crearBorradorWoo pueda llegar hasta el intento de creación real.
function fetchWooDraft(calls, { id = 44, variaciones = [] } = {}) {
  let skuAsignado = null;
  return async (_c, path, method = 'get', body) => {
    calls.push({ path, method, body });
    if (path.includes('/categories')) return { data: CATS };
    if (/\/variations(\?|$)/.test(path) && method === 'get') return { data: variaciones };
    if (method === 'post') return { data: { id, status: 'draft', stock_quantity: 0 } };
    if (method === 'patch') { skuAsignado = body.sku; return { data: { id, status: 'draft', stock_quantity: 0, sku: skuAsignado } }; }
    return { data: { id, status: 'draft', stock_quantity: 0, sku: skuAsignado } };
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

describe('crearBorradorWoo — P1.6: validaciones contra el estado real de Woo', () => {
  it('rechaza una categoría cuyo id no existe en Woo', async () => {
    const x=db();
    const f={...ficha,categoria_id:999};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440020',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])}))
      .rejects.toThrow(/categoría/i);
  });

  it('rechaza cuando el id de categoría existe pero el nombre no coincide (id y nombre desincronizados)', async () => {
    const x=db();
    const f={...ficha,categoria_id:17,categoria_nombre:'OTRA COSA'};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440021',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])}))
      .rejects.toThrow(/categoría/i);
  });

  it('no inserta fila "procesando" cuando la categoría no valida (nada que reconciliar)', async () => {
    const x=db();
    const f={...ficha,categoria_id:999};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440022',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])})).rejects.toThrow();
    expect(x.prepare('SELECT * FROM recepcion_altas_woo').all()).toHaveLength(0);
  });

  it('rechaza una combinación de atributos que ya existe en una variación del padre', async () => {
    const x=db();
    x.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (9,?,?,?,?,?,?)')
      .run('Familia', null, 'variable', null, null, 'x');
    const variaciones = [{ attributes: [{ name: 'Color', option: 'Negro' }] }];
    const f={...ficha,modo:'variacion_existente',parent_id:9,atributos:[{nombre:'color',valor:'negro'}]}; // mismo valor, otro casing
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440023',ficha:f,actor:'j',fetchWoo:fetchWooDraft([],{variaciones})}))
      .rejects.toThrow(/combinación/i);
  });

  it('permite una combinación de atributos distinta a las existentes del padre', async () => {
    const x=db();
    x.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (9,?,?,?,?,?,?)')
      .run('Familia', null, 'variable', null, null, 'x');
    const variaciones = [{ attributes: [{ name: 'Color', option: 'Negro' }] }];
    const f={...ficha,modo:'variacion_existente',parent_id:9,atributos:[{nombre:'Color',valor:'Azul'}]};
    const a = await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440024',ficha:f,actor:'j',fetchWoo:fetchWooDraft([],{variaciones})});
    expect(a.sku).toBe('FB-44');
  });
});

describe('crearBorradorWoo — P1.6: familia_variable y variacion_existente', () => {
  it('familia_variable crea el padre variable y una única variación, ambos draft/stock-cero verificados por GET', async () => {
    const calls=[];
    const x=db();
    const f={...ficha,modo:'familia_variable'};
    const a = await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440030',ficha:f,actor:'j',fetchWoo:fetchWooDraft(calls)});
    expect(a.id_padre).toBe(44); // mismo mock id para ambos POST; alcanza para probar que hay 2 POST distintos
    const posts = calls.filter(c => c.method === 'post');
    expect(posts).toHaveLength(2); // 1: padre variable. 2: variación.
    expect(posts[0].path).toBe('/products');
    expect(posts[1].path).toBe(`/products/${a.id_padre}/variations`);
  });

  it('variacion_existente NO crea un padre nuevo: un solo POST, directo a /variations del padre dado', async () => {
    const calls=[];
    const x=db();
    x.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (9,?,?,?,?,?,?)')
      .run('Familia', null, 'variable', null, null, 'x');
    const f={...ficha,modo:'variacion_existente',parent_id:9};
    await crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440031',ficha:f,actor:'j',fetchWoo:fetchWooDraft(calls)});
    const posts = calls.filter(c => c.method === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/products/9/variations');
  });
});

describe('hashFichaCanonica — P1.7: hash canónico, independiente de orden/casing', () => {
  it('el mismo contenido con las claves del objeto en otro orden da el mismo hash', () => {
    const a = { modo:'simple',titulo:'X',marca:'M',categoria_id:1,categoria_nombre:'C',precio:'100',descripcion:'',parent_id:null,atributos:[{nombre:'Color',valor:'Negro'}] };
    const b = { atributos:[{nombre:'Color',valor:'Negro'}], descripcion:'', parent_id:null, precio:'100', categoria_nombre:'C', categoria_id:1, marca:'M', titulo:'X', modo:'simple' };
    expect(hashFichaCanonica(a)).toBe(hashFichaCanonica(b));
  });

  it('atributos en otro orden dan el mismo hash', () => {
    const a = { ...ficha, atributos: [{nombre:'Color',valor:'Negro'},{nombre:'Talle',valor:'42'}] };
    const b = { ...ficha, atributos: [{nombre:'Talle',valor:'42'},{nombre:'Color',valor:'Negro'}] };
    expect(hashFichaCanonica(a)).toBe(hashFichaCanonica(b));
  });

  it('distinto casing en textos da el mismo hash', () => {
    const a = { ...ficha, titulo: 'Casco Nuevo', atributos: [{ nombre: 'Color', valor: 'Negro' }] };
    const b = { ...ficha, titulo: 'CASCO NUEVO', atributos: [{ nombre: 'color', valor: 'negro' }] };
    expect(hashFichaCanonica(a)).toBe(hashFichaCanonica(b));
  });

  it('una ficha realmente distinta da un hash distinto', () => {
    expect(hashFichaCanonica(ficha)).not.toBe(hashFichaCanonica({ ...ficha, precio: '999' }));
  });

  it('replay con las claves reordenadas y otro casing no dispara llamadas nuevas a Woo', async () => {
    const calls=[];
    const x=db();
    const fetchWoo=fetchWooDraft(calls);
    const opId='550e8400-e29b-41d4-a716-446655440040';
    const a=await crearBorradorWoo({db:x,cfg:{},operationId:opId,ficha,actor:'j',fetchWoo});
    const n=calls.length;
    const fichaReordenada = { atributos:[{nombre:'color',valor:'negro'}], descripcion:'', parent_id:null, precio:'120000', categoria_nombre:'cascos', categoria_id:17, marca:'Marca', titulo:'Casco Nuevo', modo:'simple' };
    const b=await crearBorradorWoo({db:x,cfg:{},operationId:opId,ficha:fichaReordenada,actor:'j',fetchWoo});
    expect(b).toEqual(a);
    expect(calls.length).toBe(n);
  });
});

describe('crearBorradorWoo — P1.6: clasificación fallido vs incierto', () => {
  it('un error de validación (antes de cualquier llamada remota) es "fallido"', async () => {
    const x=db();
    const f={...ficha,precio:'0'};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440050',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])}))
      .rejects.toThrow();
    // No llegó a insertar fila (falla en validarFichaAlta, antes de todo) — nada que reconciliar.
    expect(x.prepare('SELECT * FROM recepcion_altas_woo').all()).toHaveLength(0);
  });

  it('modo simple: un timeout en el POST de creación (primera llamada remota) es "incierto", no "fallido"', async () => {
    const x=db();
    const fetchWoo = async (_c, path) => {
      if (path.includes('/categories')) return { data: CATS };
      const e = new Error('timeout de red');
      e.code = 'ETIMEDOUT';
      throw e;
    };
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440051',ficha,actor:'j',fetchWoo})).rejects.toThrow();
    const row = x.prepare('SELECT estado FROM recepcion_altas_woo WHERE operation_id=?').get('550e8400-e29b-41d4-a716-446655440051');
    expect(row.estado).toBe('incierto');
  });

  it('un PATCH de SKU que falla (después del POST exitoso) es "incierto"', async () => {
    const x=db();
    const fetchWoo = async (_c, path, method='get') => {
      if (path.includes('/categories')) return { data: CATS };
      if (method === 'post') return { data: { id: 44, status: 'draft', stock_quantity: 0 } };
      if (method === 'get') return { data: { id: 44, status: 'draft', stock_quantity: 0 } };
      throw new Error('Woo caído: 503');
    };
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440052',ficha,actor:'j',fetchWoo})).rejects.toThrow();
    const row = x.prepare('SELECT estado,id_woo FROM recepcion_altas_woo WHERE operation_id=?').get('550e8400-e29b-41d4-a716-446655440052');
    expect(row.estado).toBe('incierto');
    expect(row.id_woo).toBe(44); // el id se persiste apenas se conoce, para poder reconciliar después
  });

  it('un padre inválido (chequeo local, sin red) sigue sin dejar fila que reconciliar', async () => {
    const x=db();
    const f={...ficha,modo:'variacion_existente',parent_id:9};
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440053',ficha:f,actor:'j',fetchWoo:fetchWooDraft([])})).rejects.toThrow();
    expect(x.prepare('SELECT * FROM recepcion_altas_woo').all()).toHaveLength(0);
  });
});

describe('conciliarAltaIncierta — P1.6: recuperación de una alta incierta', () => {
  it('si Woo confirma sku+draft, pasa a "creado" y hace el upsert en catalogo_cache', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-1','h','incierto','simple',44,null,'j',now,now);
    const fetchWoo = async () => ({ data: { id: 44, status: 'draft', sku: 'FB-44', name: 'Casco' } });
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-1', fetchWoo });
    expect(r.estado).toBe('creado');
    expect(x.prepare('SELECT estado FROM recepcion_altas_woo WHERE operation_id=?').get('op-1').estado).toBe('creado');
    expect(x.prepare('SELECT * FROM catalogo_cache WHERE id_woo=44').get()).toBeTruthy();
  });

  it('si Woo confirma que el producto no existe (404), pasa a "fallido" (libera reintento)', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-2','h','incierto','simple',44,null,'j',now,now);
    const fetchWoo = async () => { const e = new Error('not found'); e.status = 404; throw e; };
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-2', fetchWoo });
    expect(r.estado).toBe('fallido');
  });

  it('sin id_woo conocido, se deja "incierto" explícito (fail-closed: no asume que no se creó)', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-3','h','incierto','simple',null,null,'j',now,now);
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-3', fetchWoo: async () => { throw new Error('no debería llamarse'); } });
    expect(r.estado).toBe('incierto');
  });

  it('una operación que no está en "incierto" se devuelve tal cual, sin tocar Woo', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,sku,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run('op-4','h','creado','simple',44,null,'FB-44','j',now,now);
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-4', fetchWoo: async () => { throw new Error('no debería llamarse'); } });
    expect(r.estado).toBe('creado');
  });
});

describe('conciliarAltaIncierta — (a) sin id_woo, se encuentra por marca buscable (sku provisional/meta_data)', () => {
  it('modo simple: el POST original mandó sku provisional + meta_data; conciliar lo encuentra por sku y completa el SKU final', async () => {
    const x=db();
    // Simula un timeout en el POST: crearBorradorWoo nunca llegó a leer el id, así que la fila
    // quedó 'incierto' sin id_woo. Lo único que Woo SÍ recibió es el POST con el sku provisional.
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-marca-1','h','incierto','simple',null,null,'j',now,now);
    const skuProv = 'FB-PEND-op-marca-1';
    let skuActual = skuProv;
    const calls=[];
    const fetchWoo = async (_c, path, method='get', body) => {
      calls.push({ path, method, body });
      if (method==='get' && path===`/products?sku=${encodeURIComponent(skuProv)}`) return { data: [{ id: 77, status:'draft', sku: skuActual, name:'Casco' }] };
      if (method==='patch') { skuActual = body.sku; return { data: { id:77, status:'draft', sku: skuActual } }; }
      return { data: { id: 77, status: 'draft', sku: skuActual, name: 'Casco' } };
    };
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-marca-1', fetchWoo });
    expect(r.estado).toBe('creado');
    expect(r.id_woo).toBe(77);
    expect(r.sku).toBe('FB-77');
    expect(x.prepare('SELECT id_woo,sku FROM recepcion_altas_woo WHERE operation_id=?').get('op-marca-1')).toEqual({ id_woo: 77, sku: 'FB-77' });
    expect(x.prepare('SELECT * FROM catalogo_cache WHERE id_woo=77').get()).toBeTruthy();
    // Confirma que sí se usó la búsqueda por marca (no un id que ya estuviera guardado).
    expect(calls.some(c => c.path.includes('sku=FB-PEND-op-marca-1'))).toBe(true);
  });

  it('variacion_existente: busca por sku provisional entre las variaciones del padre (ya conocido desde la ficha)', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-marca-2','h','incierto','variacion_existente',null,9,'j',now,now);
    const skuProv = 'FB-PEND-op-marca-2';
    const fetchWoo = async (_c, path, method='get', body) => {
      if (method==='get' && path===`/products/9/variations?sku=${encodeURIComponent(skuProv)}`) return { data: [{ id: 88, status:'draft', sku: skuProv }] };
      if (method==='patch') return { data: { id:88, status:'draft', sku: body.sku } };
      return { data: { id: 88, status: 'draft', sku: 'FB-88' } };
    };
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-marca-2', fetchWoo });
    expect(r.estado).toBe('creado');
    expect(r.id_woo).toBe(88);
    expect(r.id_padre).toBe(9);
  });

  it('sin padre conocido tampoco (timeout en el POST del padre de familia_variable), no hay nada bajo qué buscar: sigue "incierto"', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-marca-3','h','incierto','familia_variable',null,null,'j',now,now);
    const r = await conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-marca-3', fetchWoo: async () => ({ data: [] }) });
    expect(r.estado).toBe('incierto');
  });
});

describe('conciliarAltaIncierta — (b) resolución humana explícita, como último recurso', () => {
  it('exige actor y motivo', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-h1','h','incierto','simple',null,null,'j',now,now);
    await expect(conciliarAltaIncierta({ db: x, cfg: {}, operationId: 'op-h1', fetchWoo: async () => ({ data: {} }), resolucionManual: { decision: 'no_se_creo' } }))
      .rejects.toThrow(/actor y motivo/);
  });

  it('"no_se_creo": pasa a fallido con el motivo auditado, sin tocar Woo', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-h2','h','incierto','simple',null,null,'j',now,now);
    const r = await conciliarAltaIncierta({
      db: x, cfg: {}, operationId: 'op-h2', fetchWoo: async () => { throw new Error('no debería tocar Woo'); },
      resolucionManual: { decision: 'no_se_creo', actor: 'joser', motivo: 'revisé Woo a mano, no existe nada con ese título' },
    });
    expect(r.estado).toBe('fallido');
    const row = x.prepare('SELECT estado,error FROM recepcion_altas_woo WHERE operation_id=?').get('op-h2');
    expect(row.estado).toBe('fallido');
    expect(row.error).toContain('joser');
    expect(row.error).toContain('revisé Woo a mano');
  });

  it('"es_este_id": verifica el id_woo dado contra Woo (no confía ciegamente) y completa el alta si es un draft válido', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-h3','h','incierto','simple',null,null,'j',now,now);
    const fetchWoo = async (_c, path, method='get', body) => {
      if (method==='patch') return { data: { id:55, status:'draft', sku: body.sku } };
      return { data: { id: 55, status: 'draft', sku: 'FB-PEND-otro' } };
    };
    const r = await conciliarAltaIncierta({
      db: x, cfg: {}, operationId: 'op-h3', fetchWoo,
      resolucionManual: { decision: 'es_este_id', id_woo: 55, actor: 'joser', motivo: 'lo encontré por título en Woo' },
    });
    expect(r.estado).toBe('creado');
    expect(r.sku).toBe('FB-55');
    expect(x.prepare('SELECT * FROM catalogo_cache WHERE id_woo=55').get()).toBeTruthy();
  });

  it('"es_este_id": si Woo NO confirma un draft en ese id, rechaza sin dar el alta por buena', async () => {
    const x=db();
    const now=new Date().toISOString();
    x.prepare("INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,id_padre,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('op-h4','h','incierto','simple',null,null,'j',now,now);
    const fetchWoo = async () => ({ data: { id: 55, status: 'publish', sku: 'FB-55' } }); // ya publicado: no es el borrador esperado
    await expect(conciliarAltaIncierta({
      db: x, cfg: {}, operationId: 'op-h4', fetchWoo,
      resolucionManual: { decision: 'es_este_id', id_woo: 55, actor: 'joser', motivo: 'x' },
    })).rejects.toThrow(/draft/);
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
      if (path.includes('/categories')) return { data: CATS };
      if (method === 'post') return { data: { id: 44, status: 'draft', stock_quantity: 0 } };
      if (method === 'patch') return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: body.sku } };
      return { data: { id: 44, status: 'draft', stock_quantity: 0, sku: null } }; // el GET nunca confirma
    };
    const x=db();
    await expect(crearBorradorWoo({db:x,cfg:{},operationId:'550e8400-e29b-41d4-a716-446655440002',ficha,actor:'j',fetchWoo}))
      .rejects.toThrow(/SKU/);
    // No debe haber quedado nada en catalogo_cache para un alta no confirmada.
    expect(x.prepare('SELECT * FROM catalogo_cache').all()).toHaveLength(0);
    // Sí quedó la fila de la operación, en 'incierto' (el POST/GET/PATCH ya se dispararon), lista
    // para conciliarAltaIncierta — no se pierde evidencia del intento.
    const row = x.prepare('SELECT estado FROM recepcion_altas_woo WHERE operation_id=?').get('550e8400-e29b-41d4-a716-446655440002');
    expect(row.estado).toBe('incierto');
  });
});
