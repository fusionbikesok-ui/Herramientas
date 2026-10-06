/*
 * test/catalogo/categorias-canal.test.ts — E2 T3 tarea 1: importar la jerarquía de categorías del canal
 * como evidencia. Fixture real: docs/superpowers/specs/e2/woo-categorias-2026-09-20.md
 * (INDUMENTARIA Y CALZADO [61] es padre de ZAPATILLAS [27]).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal, normalizarCategorias, type CategoriaCanalCruda, type FuenteCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let cuenta: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.channel_categories CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  cuenta = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
});

const ctx = () => ({ companyId: empresa, channelAccountId: cuenta, canal: 'woocommerce' as const });
const fuente = (categorias: CategoriaCanalCruda[]): FuenteCategoriasCanal => ({ listar: async () => categorias });

// Recorte del fixture real: raíz INDUMENTARIA Y CALZADO [61] con hijo ZAPATILLAS [27], más otra raíz
// COMPONENTES Y REPUESTOS [60] con hijo TRANSMISIÓN [1472] y nieto SHIFTERS [135], para probar 3 niveles.
const FIXTURE_WOO: CategoriaCanalCruda[] = [
  { id: 60, parent: 0, name: 'COMPONENTES Y REPUESTOS', slug: 'componentes-y-repuestos', count: 486 },
  { id: 1472, parent: 60, name: 'TRANSMISIÓN', slug: 'transmision', count: 165 },
  { id: 135, parent: 1472, name: 'SHIFTERS', slug: 'shifters', count: 4 },
  { id: 61, parent: 0, name: 'INDUMENTARIA Y CALZADO', slug: 'indumentaria-y-calzado', count: 207 },
  { id: 27, parent: 61, name: 'ZAPATILLAS', slug: 'zapatillas', count: 47 },
];

const vigentesDe = async (channelAccountId: string) => (await admin.query(
  `SELECT id_externo AS "idExterno", parent_externo AS "parentExterno", nombre, conteo
     FROM catalog.channel_categories WHERE channel_account_id = $1 AND vigente_hasta IS NULL ORDER BY id_externo::int`,
  [channelAccountId])).rows;

describe('E2-CAT-01 normalización', () => {
  it('normaliza parent=0 (Woo) a NULL: es una raíz, no un padre literal', () => {
    const filas = normalizarCategorias([{ id: 61, parent: 0, name: 'INDUMENTARIA Y CALZADO' }], ctx());
    expect(filas[0]!.parentExterno).toBeNull();
  });

  it('conserva el parent real como id externo en texto', () => {
    const filas = normalizarCategorias([{ id: 27, parent: 61, name: 'ZAPATILLAS' }], ctx());
    expect(filas[0]!.parentExterno).toBe('61');
    expect(filas[0]!.idExterno).toBe('27');
  });
});

describe('E2-CAT-02 importación', () => {
  it('el árbol de Woo queda reconstruible con una consulta recursiva, e INDUMENTARIA Y CALZADO es padre de ZAPATILLAS', async () => {
    const r = await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    expect(r).toMatchObject({ leidas: 5, nuevas: 5, actualizadas: 0, cerradas: 0 });

    const arbol = (await admin.query(
      `WITH RECURSIVE t AS (
         SELECT id_externo, parent_externo, nombre, 0 AS profundidad
           FROM catalog.channel_categories
          WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND parent_externo IS NULL
         UNION ALL
         SELECT c.id_externo, c.parent_externo, c.nombre, t.profundidad + 1
           FROM catalog.channel_categories c
           JOIN t ON c.parent_externo = t.id_externo AND c.channel_account_id = $1 AND c.vigente_hasta IS NULL
       )
       SELECT id_externo, parent_externo, nombre, profundidad FROM t ORDER BY profundidad, id_externo`,
      [cuenta])).rows;

    expect(arbol).toHaveLength(5);
    const zapatillas = arbol.find((n) => n.nombre === 'ZAPATILLAS');
    const indumentaria = arbol.find((n) => n.nombre === 'INDUMENTARIA Y CALZADO');
    expect(zapatillas.parent_externo).toBe(indumentaria.id_externo);
    expect(indumentaria.parent_externo).toBeNull();
    // 3 niveles: SHIFTERS cuelga de TRANSMISIÓN que cuelga de COMPONENTES Y REPUESTOS.
    const shifters = arbol.find((n) => n.nombre === 'SHIFTERS');
    expect(shifters.profundidad).toBe(2);
  });

  it('es idempotente: correr la misma foto dos veces no duplica ni cambia nada', async () => {
    await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    const antes = await vigentesDe(cuenta);
    const r2 = await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    expect(r2).toMatchObject({ leidas: 5, nuevas: 0, actualizadas: 0, cerradas: 0, sinCambios: 5 });
    expect(await vigentesDe(cuenta)).toEqual(antes);
  });

  it('es reanudable: una corrida parcial no rompe la siguiente corrida completa', async () => {
    const r1 = await importarCategoriasCanal(app, fuente(FIXTURE_WOO.slice(0, 2)), ctx());
    expect(r1).toMatchObject({ leidas: 2, nuevas: 2 });
    const r2 = await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    expect(r2).toMatchObject({ leidas: 5, nuevas: 3, sinCambios: 2 });
    expect(await vigentesDe(cuenta)).toHaveLength(5);
  });

  it('un cambio de NOMBRE cierra la fila vieja y abre una nueva, sin perder historia', async () => {
    await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    const cambiada = FIXTURE_WOO.map((c) => (c.id === 27 ? { ...c, name: 'ZAPATILLAS DE RUTA' } : c));
    const r2 = await importarCategoriasCanal(app, fuente(cambiada), ctx());
    expect(r2).toMatchObject({ actualizadas: 1, sinCambios: 4 });

    const historicas = (await admin.query(
      `SELECT nombre, vigente_hasta FROM catalog.channel_categories
        WHERE channel_account_id = $1 AND id_externo = '27' ORDER BY capturado_en`, [cuenta])).rows;
    expect(historicas).toHaveLength(2);
    expect(historicas[0].vigente_hasta).not.toBeNull();
    expect(historicas[1].vigente_hasta).toBeNull();
    expect(historicas[1].nombre).toBe('ZAPATILLAS DE RUTA');
  });

  it('un cambio de CONTEO se actualiza sobre la vigente y no genera historia', async () => {
    // El conteo es la cantidad de productos publicados y cambia todos los días: si abriera fila, cada
    // importación dejaría una fila nueva por categoría, con historia que no dice nada. Lo que hace historia
    // es la identidad y el lugar en el árbol.
    await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    const cambiada = FIXTURE_WOO.map((c) => (c.id === 27 ? { ...c, count: 99 } : c));
    expect(await importarCategoriasCanal(app, fuente(cambiada), ctx())).toMatchObject({ actualizadas: 0, sinCambios: 5 });
    const filas = (await admin.query(
      `SELECT conteo, vigente_hasta FROM catalog.channel_categories
        WHERE channel_account_id = $1 AND id_externo = '27'`, [cuenta])).rows;
    expect(filas).toHaveLength(1);
    expect(filas[0].conteo).toBe(99);
    expect(filas[0].vigente_hasta).toBeNull();
  });

  it('una categoría que el canal deja de informar se marca vigente_hasta y no se borra', async () => {
    await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    const sinShifters = FIXTURE_WOO.filter((c) => c.id !== 135);
    const r2 = await importarCategoriasCanal(app, fuente(sinShifters), ctx());
    expect(r2).toMatchObject({ leidas: 4, cerradas: 1, sinCambios: 4 });

    const fila = (await admin.query(
      `SELECT vigente_hasta FROM catalog.channel_categories WHERE channel_account_id = $1 AND id_externo = '135'`,
      [cuenta])).rows[0];
    expect(fila).toBeDefined();
    expect(fila.vigente_hasta).not.toBeNull();
    expect(await vigentesDe(cuenta)).toHaveLength(4);

    // Si vuelve a aparecer, es una fila NUEVA (dos filas en total), no un revive de la vieja.
    const r3 = await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx());
    expect(r3).toMatchObject({ nuevas: 1 });
    const todas = (await admin.query(
      `SELECT count(*)::int AS n FROM catalog.channel_categories WHERE channel_account_id = $1 AND id_externo = '135'`,
      [cuenta])).rows[0].n;
    expect(todas).toBe(2);
  });

  it('el dry-run informa pero no escribe nada', async () => {
    const r = await importarCategoriasCanal(app, fuente(FIXTURE_WOO), ctx(), { dryRun: true });
    expect(r).toMatchObject({ leidas: 5, nuevas: 5 });
    expect(await vigentesDe(cuenta)).toHaveLength(0);
  });

  it('no toca las categorías de otra cuenta de canal', async () => {
    const otraCuenta = (await admin.query<{ id: string }>(
      `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
      [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
    await importarCategoriasCanal(app, fuente(FIXTURE_WOO), { companyId: empresa, channelAccountId: otraCuenta, canal: 'woocommerce' });
    const r = await importarCategoriasCanal(app, fuente([]), ctx());
    expect(r).toMatchObject({ leidas: 0, cerradas: 0 });
    expect(await vigentesDe(otraCuenta)).toHaveLength(5);
  });
});
