/*
 * test/catalogo/taxonomia.test.ts — E2 T3 tareas 2, 5 y 6: marcas canónicas, colecciones con vigencia, el
 * árbol propio versionado y la clasificación de un modelo. Con base real y con el rol de la app (sin DELETE),
 * porque la mitad de las garantías de este tramo son restricciones de la base y no código.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agregarAColeccion, asegurarColeccion, asegurarMarca, asignarMarca, clasificarModelo, crearVersion,
  desclasificarModelo, escribirArbol, leerArbol, mapearCategoria, modelosDeColeccion, normalizarMarca,
  ErrorMarca, modelosSinPrimaria, publicarVersion, quitarDeColeccion, resolverMarca,
} from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.model_categories, catalog.taxonomy_channel_map, catalog.taxonomy_node_versions,
    catalog.taxonomy_nodes, catalog.taxonomy_versions, catalog.collection_members, catalog.collections,
    catalog.brand_aliases, catalog.pack_components, catalog.packs, catalog.external_representations,
    catalog.sellable_variants, catalog.product_models, catalog.brands CASCADE`);
  empresa = (await admin.query<{ id: string }>('INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id', [`E ${randomUUID()}`])).rows[0]!.id;
  woo = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
});

const conTx = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => enTransaccion(app, fn);

/** Un modelo mínimo, que es todo lo que hace falta para clasificarlo. */
async function modelo(clave: string): Promise<string> {
  return (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresa, woo, clave])).rows[0]!.id;
}

describe('E2-TAX-01 marcas canónicas', () => {
  it('la clave colapsa acentos, mayúsculas y puntuación pero no inventa sinónimos', () => {
    expect(normalizarMarca('MAFIA-BIKES')).toBe(normalizarMarca('Mafia  Bikes.'));
    expect(normalizarMarca('Shimano')).toBe('shimano');
    // Conservadora a propósito: 'shimano' y 'shimano tiagra' NO son la misma marca. Unificarlas pide un
    // diccionario, que es decisión de negocio y no de este tramo.
    expect(normalizarMarca('Shimano Tiagra')).not.toBe('shimano');
    expect(normalizarMarca('   ')).toBe('');
  });

  it('un nombre nuevo crea la marca y las escrituras alternativas caen en la misma', async () => {
    const id = await conTx((tx) => asegurarMarca(tx, empresa, 'FANTTIK', { origen: 'categoria_canal', alias: ['Fanttik Inc.'] }));
    expect(id).not.toBeNull();
    // El caso que motiva los alias: FANTTIK llega como CATEGORÍA de Woo y como atributo BRAND de ML.
    expect(await conTx((tx) => resolverMarca(tx, empresa, 'fanttik'))).toBe(id);
    expect(await conTx((tx) => resolverMarca(tx, empresa, 'Fanttik Inc'))).toBe(id);
    expect(await conTx((tx) => asegurarMarca(tx, empresa, 'Fanttik', { origen: 'ml_atributo' }))).toBe(id);
    expect((await admin.query('SELECT 1 FROM catalog.brands')).rowCount).toBe(1);
  });

  it('un nombre vacío no crea una marca fantasma', async () => {
    expect(await conTx((tx) => asegurarMarca(tx, empresa, '  ', { origen: 'legado' }))).toBeNull();
    expect((await admin.query('SELECT 1 FROM catalog.brands')).rowCount).toBe(0);
  });

  it('un modelo tiene a lo sumo una marca y la asignada no se pisa sola', async () => {
    const m = await modelo('1');
    const a = (await conTx((tx) => asegurarMarca(tx, empresa, 'Maxxis', { origen: 'legado' })))!;
    const b = (await conTx((tx) => asegurarMarca(tx, empresa, 'Continental', { origen: 'legado' })))!;
    expect(await conTx((tx) => asignarMarca(tx, m, a))).toBe(true);
    // Cambiar una marca ya puesta es una corrección de identidad: se hace a mano, no en una importación.
    expect(await conTx((tx) => asignarMarca(tx, m, b))).toBe(false);
    expect((await admin.query<{ brand_id: string }>('SELECT brand_id FROM catalog.product_models WHERE id = $1', [m])).rows[0]!.brand_id).toBe(a);
  });

  it('un alias ya tomado FALLA en vez de seguir en silencio', async () => {
    await conTx((tx) => asegurarMarca(tx, empresa, 'Zion', { origen: 'legado', alias: ['ZN'] }));
    // Antes esto era un `ON CONFLICT DO NOTHING`: la segunda marca se creaba, el alias se quedaba con la
    // primera y nadie se enteraba. La ambigüedad que el esquema dice prohibir pasaba en silencio.
    await expect(conTx((tx) => asegurarMarca(tx, empresa, 'Zenith', { origen: 'legado', alias: ['ZN'] })))
      .rejects.toBeInstanceOf(ErrorMarca);
    const r = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM catalog.brand_aliases WHERE alias_normalizado = 'zn'`);
    expect(r.rows[0]!.n).toBe('1');
  });

  it('una marca archivada no se devuelve como si estuviera viva', async () => {
    const id = (await conTx((tx) => asegurarMarca(tx, empresa, 'Venzo', { origen: 'legado' })))!;
    await admin.query(
      `UPDATE catalog.brands SET archivado_en = now(), motivo_archivo = 'dejamos de venderla' WHERE id = $1`, [id]);
    // `resolverMarca` filtra archivadas, así que el camino del INSERT devolvía la fila ARCHIVADA por
    // ON CONFLICT y se le colgaban modelos y alias a una marca dada de baja.
    await expect(conTx((tx) => asegurarMarca(tx, empresa, 'Venzo', { origen: 'ml_atributo' })))
      .rejects.toThrow(/archivada/);
  });

  it('un nombre que es marca propia y alias de otra resuelve siempre a la misma', async () => {
    // Se arma a mano el estado ambiguo que en producción puede llegar por una carga vieja: 'Otra' tiene 'zion'
    // como alias y, además, existe una marca que se llama 'Zion'. `asegurarMarca` ya no lo deja crear, así
    // que la única forma de tenerlo es la que lo tuvo antes: escrito directo.
    await conTx((tx) => asegurarMarca(tx, empresa, 'Otra', { origen: 'legado', alias: ['ZION'] }));
    const zion = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.brands (company_id, nombre, nombre_normalizado) VALUES ($1, 'Zion', 'zion') RETURNING id`,
      [empresa])).rows[0]!.id;
    // El UNION ALL sin ORDER BY devolvía una de las dos al azar. Gana el nombre propio sobre el alias ajeno.
    for (let i = 0; i < 5; i++) expect(await conTx((tx) => resolverMarca(tx, empresa, 'Zion'))).toBe(zion);
  });
});

describe('E2-TAX-02 colecciones con vigencia', () => {
  it('Hotsale lista sus modelos y una colección vencida deja de listar sin perder la historia', async () => {
    const m1 = await modelo('1'); const m2 = await modelo('2');
    const c = await conTx((tx) => asegurarColeccion(tx, empresa, {
      clave: 'hotsale', nombre: 'Hotsale',
      vigenteDesde: new Date('2026-05-01T00:00:00Z'), vigenteHasta: new Date('2026-05-10T00:00:00Z'),
    }));
    await conTx(async (tx) => {
      await agregarAColeccion(tx, c, m1, 'categoria_canal');
      await agregarAColeccion(tx, c, m2, 'categoria_canal');
    });
    expect(await conTx((tx) => modelosDeColeccion(tx, c, new Date('2026-05-05T00:00:00Z')))).toEqual([m1, m2]);
    // Vencida no lista nada…
    expect(await conTx((tx) => modelosDeColeccion(tx, c, new Date('2026-06-01T00:00:00Z')))).toEqual([]);
    // …pero la membresía sigue ahí: «la promo terminó» no es «la promo se borró».
    expect((await admin.query('SELECT 1 FROM catalog.collection_members WHERE quitado_en IS NULL')).rowCount).toBe(2);
  });

  it('agregar es idempotente y quitar no borra que estuvo', async () => {
    const m = await modelo('1');
    const c = await conTx((tx) => asegurarColeccion(tx, empresa, { clave: 'hotsale', nombre: 'Hotsale' }));
    expect(await conTx((tx) => agregarAColeccion(tx, c, m, 'persona'))).toBe(true);
    expect(await conTx((tx) => agregarAColeccion(tx, c, m, 'persona'))).toBe(false);
    expect(await conTx((tx) => quitarDeColeccion(tx, c, m, 'terminó la promo'))).toBe(true);
    expect(await conTx((tx) => modelosDeColeccion(tx, c))).toEqual([]);
    expect((await admin.query('SELECT 1 FROM catalog.collection_members')).rowCount).toBe(1);
    // Y puede volver a entrar: el índice único es parcial sobre lo vigente.
    expect(await conTx((tx) => agregarAColeccion(tx, c, m, 'persona'))).toBe(true);
  });

  it('una vigencia invertida la rechaza la base', async () => {
    await expect(conTx((tx) => asegurarColeccion(tx, empresa, {
      clave: 'mal', nombre: 'Mal', vigenteDesde: new Date('2026-05-10T00:00:00Z'), vigenteHasta: new Date('2026-05-01T00:00:00Z'),
    }))).rejects.toThrow(/collections_vigencia_check/);
  });
});

/** El árbol de la decisión D4: bicicletas por TIPO, con la marca como eje aparte, y servicios como rubro. */
const ARBOL = [
  { clave: 'componentes', nombre: 'Componentes y repuestos' },
  { clave: 'cubiertas-y-camaras', nombre: 'Cubiertas y cámaras', padre: 'componentes' },
  { clave: 'cubiertas', nombre: 'Cubiertas', padre: 'cubiertas-y-camaras' },
  { clave: 'camaras', nombre: 'Cámaras', padre: 'cubiertas-y-camaras' },
  { clave: 'bicicletas', nombre: 'Bicicletas' },
  { clave: 'mtb', nombre: 'MTB', padre: 'bicicletas' },
  { clave: 'servicios', nombre: 'Servicios', rubro: 'servicio' as const },
];

describe('E2-TAX-03 el árbol propio, versionado', () => {
  it('se escribe con los hijos antes que los padres y se reconstruye entero', async () => {
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa, 'primera'));
    // A propósito en orden invertido: una persona no escribe el árbol de arriba hacia abajo.
    await conTx((tx) => escribirArbol(tx, empresa, v, [...ARBOL].reverse()));
    const filas = await conTx((tx) => leerArbol(tx, v));
    expect(filas.length).toBe(ARBOL.length);
    const camino = (c: string) => filas.find((f) => f.clave === c)!.camino.join('/');
    expect(camino('cubiertas')).toBe('componentes/cubiertas-y-camaras/cubiertas');
    expect(camino('mtb')).toBe('bicicletas/mtb');
    expect(filas.find((f) => f.clave === 'servicios')!.rubro).toBe('servicio');
  });

  it('renombrar un nodo no cambia su identidad ni rompe el mapeo con el canal', async () => {
    const { id: v1 } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v1, ARBOL));
    const nodo = claves.get('cubiertas')!;
    // El mapeo es por ID REMOTO: el 119 es `CUBIERTAS` en el Woo real.
    await conTx((tx) => mapearCategoria(tx, empresa, nodo, woo, 'woocommerce', '119', 'jose'));

    const { id: v2 } = await conTx((tx) => crearVersion(tx, empresa));
    const claves2 = await conTx((tx) => escribirArbol(tx, empresa, v2,
      ARBOL.map((n) => (n.clave === 'cubiertas' ? { ...n, nombre: 'Neumáticos' } : n))));
    expect(claves2.get('cubiertas')).toBe(nodo);
    const mapa = await admin.query<{ id_externo: string }>(
      'SELECT id_externo FROM catalog.taxonomy_channel_map WHERE node_id = $1 AND vigente_hasta IS NULL', [nodo]);
    expect(mapa.rows.map((r) => r.id_externo)).toEqual(['119']);
    // Y la versión vieja sigue reconstruible con el nombre viejo.
    expect((await conTx((tx) => leerArbol(tx, v1))).find((f) => f.clave === 'cubiertas')!.nombre).toBe('Cubiertas');
  });

  it('un ciclo en el árbol pedido se rechaza con su nodo nombrado', async () => {
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    await expect(conTx((tx) => escribirArbol(tx, empresa, v, [
      { clave: 'a', nombre: 'A', padre: 'b' },
      { clave: 'b', nombre: 'B', padre: 'a' },
    ]))).rejects.toThrow(/ciclo/);
  });

  it('reorganizar no es un ciclo: se puede invertir la relación padre-hijo', async () => {
    // Este caso ANTES fallaba, y el test viejo lo daba por «ciclo». No lo es: el estado final es un árbol
    // válido. Fallaba porque se escribía de una sola pasada y pasaba por un estado intermedio inválido.
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx((tx) => escribirArbol(tx, empresa, v, [
      { clave: 'cubiertas', nombre: 'Cubiertas' },
      { clave: 'componentes', nombre: 'Componentes y repuestos', padre: 'cubiertas' },
    ]));
    const filas = await conTx((tx) => leerArbol(tx, v));
    expect(filas.find((f) => f.clave === 'componentes')!.camino.join('/')).toBe('cubiertas/componentes');
  });

  it('el ciclo lo rechaza igual la BASE, aunque se escriba por fuera del código', async () => {
    // La garantía tiene que vivir en la base: una segunda vía de escritura (una corrección a mano, otro
    // servicio) no puede saltearla. Se escribe con SQL directo, sin pasar por `escribirArbol`.
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    const componentes = claves.get('componentes')!; const cubiertas = claves.get('cubiertas')!;
    await expect(app.query(
      'UPDATE catalog.taxonomy_node_versions SET parent_id = $3 WHERE version_id = $1 AND node_id = $2',
      [v, componentes, cubiertas])).rejects.toThrow(/ciclo/);
  });

  it('un padre sin fila en esta versión se rechaza en vez de desaparecer del árbol', async () => {
    // Antes se aceptaba: el nodo quedaba con un padre «colgando» y `leerArbol`, que baja desde las raíces,
    // lo omitía junto con todo lo que colgara de él. Un árbol al que le faltan nodos sin un solo error.
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    const huerfano = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.taxonomy_nodes (company_id, clave) VALUES ($1, 'fuera-del-arbol') RETURNING id`, [empresa])).rows[0]!.id;
    await expect(app.query(
      `INSERT INTO catalog.taxonomy_node_versions (version_id, node_id, parent_id, nombre) VALUES ($1, $2, $3, 'X')`,
      [v, claves.get('mtb')!, huerfano])).rejects.toThrow(/no existe en la versión/);
  });

  it('una versión ya publicada no se puede reescribir', async () => {
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx((tx) => publicarVersion(tx, empresa, v));
    // Si se pudiera, «E13 publica exactamente lo que E12 propuso» no tendría respaldo.
    await expect(conTx((tx) => escribirArbol(tx, empresa, v, ARBOL))).rejects.toThrow(/vigente/);
  });

  it('el rubro de un nodo no se pisa con el default al reescribirlo sin rubro', async () => {
    // `rubro` vive en la identidad y no está versionado: un `SET rubro = EXCLUDED.rubro` con el default
    // 'producto' convertía SERVICES/Taller en nodos de producto en TODAS las versiones, incluida la vigente.
    const { id: v1 } = await conTx((tx) => crearVersion(tx, empresa));
    await conTx((tx) => escribirArbol(tx, empresa, v1, ARBOL));
    const { id: v2 } = await conTx((tx) => crearVersion(tx, empresa));
    await conTx((tx) => escribirArbol(tx, empresa, v2, [{ clave: 'servicios', nombre: 'Servicios' }]));
    expect((await conTx((tx) => leerArbol(tx, v2))).find((f) => f.clave === 'servicios')!.rubro).toBe('servicio');
    expect((await conTx((tx) => leerArbol(tx, v1))).find((f) => f.clave === 'servicios')!.rubro).toBe('servicio');
  });

  it('una versión de otra empresa no se puede escribir', async () => {
    const otra = (await admin.query<{ id: string }>('INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id', [`O ${randomUUID()}`])).rows[0]!.id;
    const { id: v } = await conTx((tx) => crearVersion(tx, otra));
    await expect(conTx((tx) => escribirArbol(tx, empresa, v, ARBOL))).rejects.toThrow(/no existe en esta empresa/);
  });

  it('una sola versión vigente por empresa', async () => {
    const { id: v1 } = await conTx((tx) => crearVersion(tx, empresa));
    const { id: v2 } = await conTx((tx) => crearVersion(tx, empresa));
    await conTx((tx) => publicarVersion(tx, empresa, v1));
    await conTx((tx) => publicarVersion(tx, empresa, v2));
    const r = await admin.query<{ id: string }>(`SELECT id FROM catalog.taxonomy_versions WHERE estado = 'vigente'`);
    expect(r.rows.map((x) => x.id)).toEqual([v2]);
    // Publicar dos veces la misma no se permite: ya no está en borrador.
    await expect(conTx((tx) => publicarVersion(tx, empresa, v2))).rejects.toThrow(/borrador/);
  });

  it('dos nodos propios no pueden reclamar la misma categoría del canal', async () => {
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx((tx) => mapearCategoria(tx, empresa, claves.get('cubiertas')!, woo, 'woocommerce', '119', 'jose'));
    await expect(conTx((tx) => mapearCategoria(tx, empresa, claves.get('camaras')!, woo, 'woocommerce', '119', 'jose')))
      .rejects.toThrow(/taxonomy_channel_map_un_externo/);
  });

  it('«sin equivalencia» es una decisión tomada, no una fila que falta', async () => {
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx((tx) => mapearCategoria(tx, empresa, claves.get('mtb')!, woo, 'woocommerce', null, 'jose'));
    const r = await admin.query<{ sin_equivalencia: boolean }>(
      'SELECT sin_equivalencia FROM catalog.taxonomy_channel_map WHERE node_id = $1', [claves.get('mtb')!]);
    expect(r.rows).toEqual([{ sin_equivalencia: true }]);
  });
});

describe('E2-TAX-04 el modelo en el árbol', () => {
  it('un modelo tiene exactamente una primaria y las secundarias que haga falta', async () => {
    const m = await modelo('1');
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx(async (tx) => {
      await clasificarModelo(tx, empresa, m, claves.get('cubiertas')!, { primaria: true, origen: 'mapeo_canal' });
      await clasificarModelo(tx, empresa, m, claves.get('mtb')!);
    });
    // Reclasificar cierra la primaria anterior en vez de fallar: es una operación legítima.
    await conTx((tx) => clasificarModelo(tx, empresa, m, claves.get('camaras')!, { primaria: true }));
    const r = await admin.query<{ clave: string; primaria: boolean }>(
      `SELECT n.clave, c.primaria FROM catalog.model_categories c
         JOIN catalog.taxonomy_nodes n ON n.id = c.node_id
        WHERE c.model_id = $1 AND c.quitado_en IS NULL ORDER BY n.clave`, [m]);
    expect(r.rows).toEqual([
      { clave: 'camaras', primaria: true }, { clave: 'cubiertas', primaria: false }, { clave: 'mtb', primaria: false },
    ]);
  });

  it('desclasificar no borra que estuvo y permite volver a clasificar', async () => {
    const m = await modelo('1');
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    const nodo = claves.get('cubiertas')!;
    await conTx((tx) => clasificarModelo(tx, empresa, m, nodo, { primaria: true }));
    expect(await conTx((tx) => desclasificarModelo(tx, m, nodo, 'mal clasificado'))).toBe(true);
    expect(await conTx((tx) => desclasificarModelo(tx, m, nodo, 'otra vez'))).toBe(false);
    await conTx((tx) => clasificarModelo(tx, empresa, m, nodo, { primaria: true }));
    expect((await admin.query('SELECT 1 FROM catalog.model_categories WHERE model_id = $1', [m])).rowCount).toBe(2);
  });

  it('un mapeo automático no degrada la primaria que puso una persona', async () => {
    const m = await modelo('1');
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx((tx) => clasificarModelo(tx, empresa, m, claves.get('cubiertas')!, { primaria: true, origen: 'persona' }));
    // Si la importación pudiera degradarla, la próxima corrida desharía en silencio una decisión humana.
    await expect(conTx((tx) => clasificarModelo(tx, empresa, m, claves.get('camaras')!, { primaria: true, origen: 'mapeo_canal' })))
      .rejects.toThrow(/puesta por una persona/);
    // Una persona sí puede cambiarla.
    await conTx((tx) => clasificarModelo(tx, empresa, m, claves.get('camaras')!, { primaria: true, origen: 'persona' }));
    const r = await admin.query<{ clave: string }>(
      `SELECT n.clave FROM catalog.model_categories c JOIN catalog.taxonomy_nodes n ON n.id = c.node_id
        WHERE c.model_id = $1 AND c.quitado_en IS NULL AND c.primaria`, [m]);
    expect(r.rows.map((x) => x.clave)).toEqual(['camaras']);
  });

  it('los modelos clasificados sin primaria son consultables', async () => {
    // El esquema garantiza «a lo sumo una» primaria; «exactamente una» no lo puede garantizar una restricción
    // de fila. La diferencia se MIDE en vez de prometerse: un modelo sin primaria no sale en ningún informe
    // por rubro, y eso hay que poder verlo antes de darle valor a un conteo por categoría.
    const m = await modelo('1'); const conPrimaria = await modelo('2');
    const { id: v } = await conTx((tx) => crearVersion(tx, empresa));
    const claves = await conTx((tx) => escribirArbol(tx, empresa, v, ARBOL));
    await conTx(async (tx) => {
      await clasificarModelo(tx, empresa, m, claves.get('mtb')!);
      await clasificarModelo(tx, empresa, conPrimaria, claves.get('mtb')!, { primaria: true });
    });
    expect(await conTx((tx) => modelosSinPrimaria(tx, empresa))).toEqual([m]);
  });

  it('la app no puede borrar nada de la taxonomía', async () => {
    await expect(app.query('DELETE FROM catalog.taxonomy_nodes')).rejects.toThrow(/permiso|permission/i);
    await expect(app.query('DELETE FROM catalog.collections')).rejects.toThrow(/permiso|permission/i);
  });
});
