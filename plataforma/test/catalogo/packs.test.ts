/*
 * test/catalogo/packs.test.ts — E2 T3 tarea 7: la composición de packs y kits, en sombra. Con base real y con
 * el rol de la app, porque la prohibición de ciclos y de componentes archivados es un trigger, no código.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activarPack, archivarPack, componentes, declararPack, ponerComponente, quitarComponente,
} from '../../src/catalogo/packs.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string; let modelo: string; let n = 0;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.pack_components, catalog.packs, catalog.external_representations,
    catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>('INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id', [`E ${randomUUID()}`])).rows[0]!.id;
  woo = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  modelo = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'woo_simple', $3, 'M') RETURNING id`, [empresa, woo, randomUUID()])).rows[0]!.id;
});

const conTx = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => enTransaccion(app, fn);

/** Una variante vendible con SKU canónico, que es lo único que un pack puede llevar adentro. */
async function variante(): Promise<string> {
  return (await admin.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, modelo, `FB-${1000 + ++n}`])).rows[0]!.id;
}

describe('E2-PACK-01 composición de un pack', () => {
  it('se compone y se lee con sus componentes y cantidades', async () => {
    const pack = await variante(); const a = await variante(); const b = await variante();
    await conTx(async (tx) => {
      await declararPack(tx, empresa, pack, 'Kit de mantenimiento');
      await ponerComponente(tx, pack, { variante: a, cantidad: 2 });
      await ponerComponente(tx, pack, { variante: b, cantidad: 0.5, unidad: 'litro' });
    });
    const c = await conTx((tx) => componentes(tx, pack));
    expect(c.map((x) => ({ v: x.variant_id, cantidad: x.cantidad, unidad: x.unidad }))).toEqual([
      { v: a, cantidad: '2.0000', unidad: 'unidad' }, { v: b, cantidad: '0.5000', unidad: 'litro' },
    ]);
    // Nace en borrador: «declarado» no es «vendible». Precio, stock y publicación están diferidos.
    const p = await admin.query<{ estado: string }>('SELECT estado FROM catalog.packs WHERE variant_id = $1', [pack]);
    expect(p.rows[0]!.estado).toBe('borrador');
  });

  it('poner la misma cantidad no genera una fila nueva, corregirla sí', async () => {
    const pack = await variante(); const a = await variante();
    await conTx((tx) => declararPack(tx, empresa, pack, 'Kit'));
    expect(await conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: 2 }))).toBe(true);
    expect(await conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: 2 }))).toBe(false);
    expect(await conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: 3 }))).toBe(true);
    expect((await conTx((tx) => componentes(tx, pack))).map((x) => x.cantidad)).toEqual(['3.0000']);
    // La corrección no editó la fila: quedaron las dos, con la vieja cerrada.
    expect((await admin.query('SELECT 1 FROM catalog.pack_components WHERE pack_variant_id = $1', [pack])).rowCount).toBe(2);
  });

  it('una venta de ayer reconstruye qué llevaba el pack ayer, no lo que lleva hoy', async () => {
    const pack = await variante(); const viejo = await variante(); const nuevo = await variante();
    await conTx(async (tx) => {
      await declararPack(tx, empresa, pack, 'Kit');
      await ponerComponente(tx, pack, { variante: viejo, cantidad: 1 });
    });
    const corte = (await admin.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
    await conTx(async (tx) => {
      await quitarComponente(tx, pack, viejo, 'discontinuado');
      await ponerComponente(tx, pack, { variante: nuevo, cantidad: 1 });
    });
    expect((await conTx((tx) => componentes(tx, pack))).map((x) => x.variant_id)).toEqual([nuevo]);
    expect((await conTx((tx) => componentes(tx, pack, corte))).map((x) => x.variant_id)).toEqual([viejo]);
  });

  it('un ciclo lo rechaza la base', async () => {
    const p1 = await variante(); const p2 = await variante();
    await conTx(async (tx) => {
      await declararPack(tx, empresa, p1, 'Pack 1');
      await declararPack(tx, empresa, p2, 'Pack 2');
      await ponerComponente(tx, p1, { variante: p2, cantidad: 1 });
    });
    // p2 no puede llevar a p1 adentro: p1 ya lleva a p2.
    await expect(conTx((tx) => ponerComponente(tx, p2, { variante: p1, cantidad: 1 }))).rejects.toThrow(/ciclo/);
    // Ni directamente a sí mismo. Acá avisa el trigger y no el CHECK `no_autocomponente`, porque un trigger
    // BEFORE corre antes de que se evalúen las restricciones de la fila. El CHECK igual se queda: es la
    // garantía que sobrevive si algún día se toca el trigger.
    await expect(conTx((tx) => ponerComponente(tx, p1, { variante: p1, cantidad: 1 }))).rejects.toThrow(/ciclo/);
  });

  it('un componente archivado se rechaza', async () => {
    const pack = await variante(); const muerta = await variante();
    await admin.query(
      `UPDATE catalog.sellable_variants SET archivado_en = now(), motivo_archivo = 'baja' WHERE id = $1`, [muerta]);
    await conTx((tx) => declararPack(tx, empresa, pack, 'Kit'));
    await expect(conTx((tx) => ponerComponente(tx, pack, { variante: muerta, cantidad: 1 })))
      .rejects.toThrow(/archivada/);
  });

  it('una cantidad no positiva se rechaza', async () => {
    const pack = await variante(); const a = await variante();
    await conTx((tx) => declararPack(tx, empresa, pack, 'Kit'));
    await expect(conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: 0 })))
      .rejects.toThrow(/cantidad/);
  });
});

describe('E2-PACK-02 estados', () => {
  it('un pack vacío no se puede activar', async () => {
    const pack = await variante();
    await conTx((tx) => declararPack(tx, empresa, pack, 'Kit'));
    await expect(conTx((tx) => activarPack(tx, pack))).rejects.toThrow(/no tiene componentes/);
  });

  it('con componentes se activa, y activar dos veces no se permite', async () => {
    const pack = await variante(); const a = await variante();
    await conTx(async (tx) => {
      await declararPack(tx, empresa, pack, 'Kit');
      await ponerComponente(tx, pack, { variante: a, cantidad: 1 });
      await activarPack(tx, pack);
    });
    expect((await admin.query<{ estado: string }>('SELECT estado FROM catalog.packs WHERE variant_id = $1', [pack])).rows[0]!.estado).toBe('vigente');
    await expect(conTx((tx) => activarPack(tx, pack))).rejects.toThrow(/borrador/);
    await conTx((tx) => archivarPack(tx, pack));
    expect((await admin.query<{ estado: string }>('SELECT estado FROM catalog.packs WHERE variant_id = $1', [pack])).rows[0]!.estado).toBe('archivado');
  });

  it('una cantidad NaN o con más de 4 decimales se rechaza', async () => {
    const pack = await variante(); const a = await variante();
    await conTx((tx) => declararPack(tx, empresa, pack, 'Kit'));
    // `'NaN'::numeric > 0` es TRUE en PostgreSQL: el CHECK `cantidad > 0` dejaba pasar un NaN.
    await expect(conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: NaN }))).rejects.toThrow(/inválida/);
    // Y numeric(12,4) redondeaba en silencio, con lo que la comparación de idempotencia no volvía a calzar
    // nunca y cada llamada cerraba y reabría la fila.
    await expect(conTx((tx) => ponerComponente(tx, pack, { variante: a, cantidad: 0.00001 }))).rejects.toThrow(/decimales/);
  });

  it('reabrir un componente cerrado no puede colar un ciclo', async () => {
    // Era la vía que se salteaba el trigger: estaba en `UPDATE OF variant_id, pack_variant_id`, y reabrir
    // toca sólo `vigente_hasta`. P1→P2 se cierra, se agrega P2→P1 (legítimo mientras el otro está cerrado),
    // y al reabrir P1→P2 quedaba un ciclo vigente sin un solo error.
    const p1 = await variante(); const p2 = await variante();
    await conTx(async (tx) => {
      await declararPack(tx, empresa, p1, 'P1');
      await declararPack(tx, empresa, p2, 'P2');
      await ponerComponente(tx, p1, { variante: p2, cantidad: 1 });
      await quitarComponente(tx, p1, p2, 'probando');
      await ponerComponente(tx, p2, { variante: p1, cantidad: 1 });
    });
    const fila = (await admin.query<{ id: string }>(
      `SELECT id FROM catalog.pack_components WHERE pack_variant_id = $1 AND variant_id = $2`, [p1, p2])).rows[0]!.id;
    await expect(app.query(
      'UPDATE catalog.pack_components SET vigente_hasta = NULL, motivo_cierre = NULL WHERE id = $1', [fila]))
      .rejects.toThrow(/ciclo/);
  });

  it('un ciclo de tres niveles también se rechaza', async () => {
    // El test viejo sólo probaba un salto: quitarle la recursión al trigger no rompía nada.
    const p1 = await variante(); const p2 = await variante(); const p3 = await variante();
    await conTx(async (tx) => {
      for (const [p, n] of [[p1, 'P1'], [p2, 'P2'], [p3, 'P3']] as const) await declararPack(tx, empresa, p, n);
      await ponerComponente(tx, p1, { variante: p2, cantidad: 1 });
      await ponerComponente(tx, p2, { variante: p3, cantidad: 1 });
    });
    await expect(conTx((tx) => ponerComponente(tx, p3, { variante: p1, cantidad: 1 }))).rejects.toThrow(/ciclo/);
  });

  it('la app no puede borrar una composición', async () => {
    await expect(app.query('DELETE FROM catalog.pack_components')).rejects.toThrow(/permiso|permission/i);
    await expect(app.query('DELETE FROM catalog.packs')).rejects.toThrow(/permiso|permission/i);
  });
});
