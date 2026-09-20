/*
 * test/catalogo/categorias-ml.test.ts — fuente de categorías de MercadoLibre (sin red: `obtener` inyectado).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { categoriasDesdeRutas, ErrorFuenteMl, fuenteCategoriasMl, type ObtenerCategoria } from '../../src/catalogo/categorias-ml.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const RUTAS: Record<string, Array<[string, string]>> = {
  MLA3: [['MLA1', 'Deportes'], ['MLA2', 'Ciclismo'], ['MLA3', 'Cascos']],
  MLA4: [['MLA1', 'Deportes'], ['MLA2', 'Ciclismo'], ['MLA4', 'Luces']],
  MLA9: [['MLA9', 'Otros']],
};
const cuerpo = (id: string) => ({ id, name: 'x', path_from_root: RUTAS[id]!.map(([i, n]) => ({ id: i, name: n })) });
const obtenerOk: ObtenerCategoria = async (id) => (RUTAS[id]
  ? { estado: 200, cuerpo: cuerpo(id) } : { estado: 404, cuerpo: null });

describe('E2-CATML-01 reconstrucción desde path_from_root', () => {
  it('saca padres y ancestros de la ruta, sin duplicar los compartidos', () => {
    const r = categoriasDesdeRutas([{ pedido: 'MLA3', cuerpo: cuerpo('MLA3') }, { pedido: 'MLA4', cuerpo: cuerpo('MLA4') }]);
    expect(r.map((c) => [c.id, c.parent, c.name]).sort()).toEqual([
      ['MLA1', 0, 'Deportes'], ['MLA2', 'MLA1', 'Ciclismo'], ['MLA3', 'MLA2', 'Cascos'], ['MLA4', 'MLA2', 'Luces'],
    ]);
    expect(r.every((c) => c.count === null)).toBe(true);
  });
  it('frena si la ruta no termina en la categoría pedida', () => {
    expect(() => categoriasDesdeRutas([{ pedido: 'MLA4', cuerpo: cuerpo('MLA3') }])).toThrow(ErrorFuenteMl);
  });
  it('frena si el id es el pedido pero la ruta termina en otra categoría', () => {
    expect(() => categoriasDesdeRutas([{ pedido: 'MLA4', cuerpo: { id: 'MLA4', path_from_root: cuerpo('MLA3').path_from_root } }])).toThrow(/otra categoría/);
  });
  it('frena si falta path_from_root en vez de tratarla como raíz', () => {
    expect(() => categoriasDesdeRutas([{ pedido: 'MLA3', cuerpo: { id: 'MLA3', name: 'Cascos' } }])).toThrow(/path_from_root/);
  });
  it('frena si un mismo id viene con dos padres distintos', () => {
    const otra = { id: 'MLA4', path_from_root: [{ id: 'MLA1', name: 'Deportes' }, { id: 'MLA5', name: 'Otra' }, { id: 'MLA2', name: 'Ciclismo' }, { id: 'MLA4', name: 'Luces' }] };
    expect(() => categoriasDesdeRutas([{ pedido: 'MLA3', cuerpo: cuerpo('MLA3') }, { pedido: 'MLA4', cuerpo: otra }])).toThrow(/dos nombres o dos padres/);
  });
});

describe('E2-CATML-02 fuente', () => {
  it('lista vacía de ids aborta: no se cierra lo vigente por no tener qué pedir', async () => {
    await expect(fuenteCategoriasMl([], { obtener: obtenerOk }).listar()).rejects.toThrow(/ninguna categoría/);
  });
  it('un id con formato raro aborta antes de ir a la red', async () => {
    let llamadas = 0;
    const f = fuenteCategoriasMl(['MLA3', 'undefined'], { obtener: async (i) => { llamadas++; return obtenerOk(i); } });
    await expect(f.listar()).rejects.toThrow(/formato/);
    expect(llamadas).toBe(0);
  });
  it('un 5xx o un status inesperado aborta la lectura completa', async () => {
    const f = fuenteCategoriasMl(['MLA3', 'MLA4'], { obtener: async (i) => (i === 'MLA4' ? { estado: 503, cuerpo: null } : obtenerOk(i)) });
    await expect(f.listar()).rejects.toThrow(/503/);
  });
  it('un 404 aborta salvo que se pida omitirlo, y entonces queda informado', async () => {
    await expect(fuenteCategoriasMl(['MLA3', 'MLA77'], { obtener: obtenerOk }).listar()).rejects.toThrow(/404/);
    const f = fuenteCategoriasMl(['MLA3', 'MLA77'], { obtener: obtenerOk, omitirInexistentes: true });
    expect((await f.listar()).map((c) => c.id).sort()).toEqual(['MLA1', 'MLA2', 'MLA3']);
    expect(f.inexistentes).toEqual(['MLA77']);
  });
  it('deduplica ids y respeta la concurrencia pedida', async () => {
    let activos = 0; let maximo = 0; let n = 0;
    const f = fuenteCategoriasMl(['MLA3', 'MLA3', 'MLA4', 'MLA9'], {
      concurrencia: 2,
      obtener: async (i) => { n++; activos++; maximo = Math.max(maximo, activos); await new Promise((r) => setTimeout(r, 5)); activos--; return obtenerOk(i); },
    });
    await f.listar();
    expect(n).toBe(3);
    expect(maximo).toBeLessThanOrEqual(2);
  });
});

describe('E2-CATML-03 importación a la base', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let cuenta: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.channel_categories CASCADE`);
    empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
    cuenta = (await admin.query<{ id: string }>(
      `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'mercadolibre', $2) RETURNING id`,
      [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  });
  const ctx = () => ({ companyId: empresa, channelAccountId: cuenta, canal: 'mercadolibre' as const });
  const vigentes = async () => (await admin.query(
    `SELECT id_externo, parent_externo, nombre, conteo FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL ORDER BY id_externo`, [cuenta])).rows;

  it('escribe el árbol con ids alfanuméricos, es idempotente y el dry-run no escribe', async () => {
    const fuente = () => fuenteCategoriasMl(['MLA3', 'MLA4'], { obtener: obtenerOk });
    const seco = await importarCategoriasCanal(app, fuente(), ctx(), { dryRun: true });
    expect(seco.nuevas).toBe(4);
    expect(await vigentes()).toEqual([]);
    await importarCategoriasCanal(app, fuente(), ctx());
    const otra = await importarCategoriasCanal(app, fuente(), ctx());
    expect(otra).toMatchObject({ nuevas: 0, actualizadas: 0, sinCambios: 4, cerradas: 0 });
    expect(await vigentes()).toEqual([
      { id_externo: 'MLA1', parent_externo: null, nombre: 'Deportes', conteo: null },
      { id_externo: 'MLA2', parent_externo: 'MLA1', nombre: 'Ciclismo', conteo: null },
      { id_externo: 'MLA3', parent_externo: 'MLA2', nombre: 'Cascos', conteo: null },
      { id_externo: 'MLA4', parent_externo: 'MLA2', nombre: 'Luces', conteo: null },
    ]);
  });

  it('una lectura abortada no cierra nada de lo ya importado', async () => {
    await importarCategoriasCanal(app, fuenteCategoriasMl(['MLA3', 'MLA4'], { obtener: obtenerOk }), ctx());
    const caida = fuenteCategoriasMl(['MLA3', 'MLA4'], { obtener: async () => ({ estado: 500, cuerpo: null }) });
    await expect(importarCategoriasCanal(app, caida, ctx())).rejects.toThrow(/500/);
    expect((await vigentes()).length).toBe(4);
  });
});
