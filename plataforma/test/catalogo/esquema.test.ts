/*
 * test/catalogo/esquema.test.ts — E2 T1 tarea 1: lo que la base tiene que hacer cumplir sola.
 *
 * Cada caso prueba una regla que el diseño le encarga al esquema, no al código: si mañana alguien
 * escribe un INSERT a mano o un proyector con un defecto, la base lo tiene que rechazar igual.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import type { MensajeEntrada } from '../../src/colas/colas.ts';
import type { ContextoEscritura } from '../../src/reconciliacion/motor.ts';

let base: BaseDePrueba;
const clientes: pg.Client[] = [];

beforeAll(async () => {
  base = await crearBaseDePrueba();
  return async () => { while (clientes.length) await clientes.pop()?.end(); await base.borrar(); };
});

async function admin(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: base.urlAdmin });
  await c.connect(); clientes.push(c); return c;
}

/** Empresa y cuentas de canal nuevas por caso, para que un caso no vea lo del otro. */
async function sembrar(db: pg.Client): Promise<{ empresa: string; woo: string; ml: string }> {
  const empresa = (await db.query<{ id: string }>(
    `INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`,
    [`Empresa ${randomUUID().slice(0, 8)}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await db.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account)
     VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  return { empresa, woo: await cuenta('woocommerce'), ml: await cuenta('mercadolibre') };
}

async function modelo(db: pg.Client, e: { empresa: string }, cuenta: string, origen: string, clave: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, $3, $4, 'm') RETURNING id`, [e.empresa, cuenta, origen, clave])).rows[0]!.id;
}

async function variante(db: pg.Client, empresa: string, modelId: string, sku: string | null): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, modelId, sku])).rows[0]!.id;
}

afterEach(async () => {
  const db = await admin();
  // Forward-only también en los tests: se limpia el catálogo, nunca el esquema.
  await db.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.external_representations,
                           catalog.sellable_variants, catalog.product_models CASCADE`);
});

describe('E2-SCH-01 esquema del catálogo', () => {
  it('un SKU con formato no canónico se rechaza', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.woo, 'woo_simple', 'w1');
    await expect(variante(db, e.empresa, m, 'ABC-123')).rejects.toThrow(/sku/i);
    await expect(variante(db, e.empresa, m, 'FB-')).rejects.toThrow(/sku/i);
    // El canónico sí entra, y el pendiente (nulo) también.
    await expect(variante(db, e.empresa, m, 'FB-123')).resolves.toBeTruthy();
    await expect(variante(db, e.empresa, m, null)).resolves.toBeTruthy();
  });

  it('el mismo SKU dos veces en la misma empresa se rechaza', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.woo, 'woo_simple', 'w1');
    await variante(db, e.empresa, m, 'FB-500');
    await expect(variante(db, e.empresa, m, 'FB-500')).rejects.toThrow(/sku/i);
  });

  it('el mismo SKU en dos empresas distintas se acepta', async () => {
    const db = await admin();
    const a = await sembrar(db); const b = await sembrar(db);
    const ma = await modelo(db, a, a.woo, 'woo_simple', 'w1');
    const mb = await modelo(db, b, b.woo, 'woo_simple', 'w1');
    await variante(db, a.empresa, ma, 'FB-777');
    await expect(variante(db, b.empresa, mb, 'FB-777')).resolves.toBeTruthy();
  });

  it('varias variantes con SKU pendiente conviven', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.woo, 'woo_padre', 'w9');
    await variante(db, e.empresa, m, null);
    await expect(variante(db, e.empresa, m, null)).resolves.toBeTruthy();
  });

  it('el SKU es inmutable una vez puesto, pero se puede poner sobre un pendiente', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.woo, 'woo_simple', 'w1');
    const pendiente = await variante(db, e.empresa, m, null);
    // Resolver un pendiente es el caso legítimo del §6 del diseño.
    await expect(db.query(`UPDATE catalog.sellable_variants SET sku = 'FB-10' WHERE id = $1`, [pendiente]))
      .resolves.toBeTruthy();
    // Cambiarlo después, no.
    await expect(db.query(`UPDATE catalog.sellable_variants SET sku = 'FB-11' WHERE id = $1`, [pendiente]))
      .rejects.toThrow(/inmutable/i);
    // Ni borrarlo para "liberarlo".
    await expect(db.query(`UPDATE catalog.sellable_variants SET sku = NULL WHERE id = $1`, [pendiente]))
      .rejects.toThrow(/inmutable/i);
  });

  it('el mismo id de recurso en dos cuentas distintas no choca', async () => {
    const db = await admin(); const e = await sembrar(db);
    const otra = (await db.query<{ id: string }>(
      `INSERT INTO core.channel_accounts (company_id, channel, external_account)
       VALUES ($1, 'woocommerce', $2) RETURNING id`, [e.empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
    const m1 = await modelo(db, e, e.woo, 'woo_simple', '1234');
    const m2 = await modelo(db, e, otra, 'woo_simple', '1234');
    const v1 = await variante(db, e.empresa, m1, 'FB-1234');
    const v2 = await variante(db, e.empresa, m2, null);
    const rep = (cuenta: string, variante: string) => db.query(
      `INSERT INTO catalog.external_representations
         (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, variant_id)
       VALUES ($1, $2, 'woocommerce', '1234', '', 'vendible', $3)`, [e.empresa, cuenta, variante]);
    await rep(e.woo, v1);
    await expect(rep(otra, v2)).resolves.toBeTruthy();
  });

  it('dos modelos con la misma clave en la misma cuenta se rechazan', async () => {
    const db = await admin(); const e = await sembrar(db);
    await modelo(db, e, e.woo, 'woo_simple', '55');
    await expect(modelo(db, e, e.woo, 'woo_simple', '55')).rejects.toThrow(/clave_origen|product_models/i);
  });

  it('una representación duplicada sin variación se rechaza, incluso omitiendo la columna', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.ml, 'ml_simple', 'MLA1');
    const v = await variante(db, e.empresa, m, null);
    // Deliberadamente **sin** nombrar variacion_normalizada: así se escribe el proyector de un ítem sin
    // variaciones, y es el caso donde un UNIQUE con NULL dejaría entrar el duplicado sin decir nada.
    // Si la columna dejara de ser NOT NULL DEFAULT '', este caso lo detecta.
    const rep = () => db.query(
      `INSERT INTO catalog.external_representations
         (company_id, channel_account_id, canal, recurso, tipo, variant_id)
       VALUES ($1, $2, 'mercadolibre', 'MLA1', 'vendible', $3)`, [e.empresa, e.ml, v]);
    await rep();
    await expect(rep()).rejects.toThrow(/un_aparicion/i);
    // Y el valor guardado es la cadena vacía, no NULL: lo que hace que el UNIQUE funcione.
    const r = await db.query<{ variacion_normalizada: string | null }>(
      `SELECT variacion_normalizada FROM catalog.external_representations WHERE recurso = 'MLA1'`);
    expect(r.rows[0]!.variacion_normalizada).toBe('');
  });

  it('un contenedor apunta a un modelo y nunca a una variante', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.ml, 'ml_clasico', 'MLA2');
    const v = await variante(db, e.empresa, m, null);
    // Contenedor con variante: prohibido.
    await expect(db.query(
      `INSERT INTO catalog.external_representations
         (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, variant_id, model_id)
       VALUES ($1, $2, 'mercadolibre', 'MLA2', '', 'contenedor', $3, $4)`, [e.empresa, e.ml, v, m]))
      .rejects.toThrow(/colgadura/i);
    // Contenedor con modelo: correcto.
    await expect(db.query(
      `INSERT INTO catalog.external_representations
         (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, model_id)
       VALUES ($1, $2, 'mercadolibre', 'MLA2', '', 'contenedor', $3)`, [e.empresa, e.ml, m]))
      .resolves.toBeTruthy();
    // Un vendible sin variante: prohibido.
    await expect(db.query(
      `INSERT INTO catalog.external_representations
         (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, model_id)
       VALUES ($1, $2, 'mercadolibre', 'MLA2', 'x', 'vendible', $3)`, [e.empresa, e.ml, m]))
      .rejects.toThrow(/colgadura/i);
  });

  it('un caso abierto no se duplica para el mismo objeto y tipo', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.ml, 'ml_simple', 'MLA3');
    const v = await variante(db, e.empresa, m, null);
    const caso = () => db.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, prioridad)
       VALUES ($1, 'sku_pendiente', $2, 'normal')`, [e.empresa, v]);
    await caso();
    await expect(caso()).rejects.toThrow(/identity_cases|abierto/i);
    // Cerrado el primero, se puede volver a abrir: el caso puede reaparecer.
    await db.query(`UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'resuelto' WHERE variant_id = $1`, [v]);
    await expect(caso()).resolves.toBeTruthy();
  });

  it('las decisiones del matcher son append-only y con una sola vigente por clave', async () => {
    const db = await admin(); const e = await sembrar(db);
    const dec = (hasta: string | null) => db.query(
      `INSERT INTO catalog.matcher_decisions
         (company_id, channel_account_id, canal, recurso, variacion_normalizada, sku, accion, origen, actor, vigente_hasta)
       VALUES ($1, $2, 'mercadolibre', 'MLA9', '', 'FB-9', 'confirmar', 'copia', 'persona', $3)`, [e.empresa, e.ml, hasta]);
    await dec(null);
    await expect(dec(null)).rejects.toThrow(/matcher_decisions|vigente/i);
    // Cerrada la vigencia, entra la siguiente: es el historial que el diseño pide conservar.
    await db.query(`UPDATE catalog.matcher_decisions SET vigente_hasta = now(), motivo_cierre = 'revocada' WHERE vigente_hasta IS NULL`);
    await expect(dec(null)).resolves.toBeTruthy();
  });

  it('la app no puede borrar filas del catálogo', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e, e.woo, 'woo_simple', 'w1');
    const app = new pg.Client({ connectionString: base.urlApp });
    await app.connect(); clientes.push(app);
    await expect(app.query(`DELETE FROM catalog.product_models WHERE id = $1`, [m])).rejects.toThrow(/permis|denied/i);
    await expect(app.query(`TRUNCATE catalog.product_models`)).rejects.toThrow(/permis|denied|owner/i);
    // Archivar sí: es la baja que el diseño admite.
    await expect(app.query(
      `UPDATE catalog.product_models SET archivado_en = now(), motivo_archivo = 'cerrado en el canal' WHERE id = $1`, [m]))
      .resolves.toBeTruthy();
  });

  it('el bootstrap y el payload vencido son orígenes válidos', async () => {
    const db = await admin(); const e = await sembrar(db);
    // Los dos CHECK que la migración amplía, probados por su efecto y no por su texto.
    await expect(db.query(
      `INSERT INTO integrations.inbox_messages (channel_account_id, topic, resource_id, remote_version, source, correlation_id)
       VALUES ($1, 'ml.items', 'MLA1', 'v1', 'bootstrap', gen_random_uuid())`, [e.ml])).resolves.toBeTruthy();
    await expect(db.query(
      `INSERT INTO integrations.reconciliation_signals (channel_account_id, topic, resource_id, fingerprint, source)
       VALUES ($1, 'ml.items', 'MLA2', $2, 'payload_expired')`, [e.ml, randomUUID()])).resolves.toBeTruthy();
    // Y uno inventado sigue rechazándose: el CHECK no quedó abierto.
    await expect(db.query(
      `INSERT INTO integrations.inbox_messages (channel_account_id, topic, resource_id, remote_version, source, correlation_id)
       VALUES ($1, 'ml.items', 'MLA3', 'v1', 'cualquiera', gen_random_uuid())`, [e.ml])).rejects.toThrow(/source/i);
  });

  it('una corrida de bootstrap es única por cuenta y tópico, y guarda la página confirmada', async () => {
    const db = await admin(); const e = await sembrar(db);
    const corrida = () => db.query(
      `INSERT INTO catalog.bootstrap_runs (channel_account_id, topic) VALUES ($1, 'ml.items')`, [e.ml]);
    await corrida();
    await expect(corrida()).rejects.toThrow(/bootstrap_runs/i);
    const r = await db.query<{ estado: string; pagina_confirmada: number }>(
      `SELECT estado, pagina_confirmada FROM catalog.bootstrap_runs WHERE channel_account_id = $1`, [e.ml]);
    expect(r.rows[0]).toEqual({ estado: 'pendiente', pagina_confirmada: 0 });
  });

  it('una copia sin confirmar no tiene lotes fuera de orden ni conteo negativo', async () => {
    const db = await admin(); const e = await sembrar(db);
    const copia = (await db.query<{ id: string }>(
      `INSERT INTO catalog.copias (company_id, tipo, total_esperado, hash_esperado)
       VALUES ($1, 'matcher', 3, 'abc') RETURNING id`, [e.empresa])).rows[0]!.id;
    await db.query(`INSERT INTO catalog.copias_lotes (copy_id, numero, filas) VALUES ($1, 1, '[]'::jsonb)`, [copia]);
    await expect(db.query(`INSERT INTO catalog.copias_lotes (copy_id, numero, filas) VALUES ($1, 1, '[]'::jsonb)`, [copia]))
      .rejects.toThrow(/copias_lotes|numero/i);
    await expect(db.query(
      `INSERT INTO catalog.copias (company_id, tipo, total_esperado, hash_esperado) VALUES ($1, 'matcher', -1, 'x')`,
      [e.empresa])).rejects.toThrow(/total_esperado/i);
  });
});

/*
 * Red de tipos: la migración amplía dos CHECK, y si los tipos de TypeScript no acompañan, el código
 * que quiera emitir con el origen nuevo no compila. Estas líneas fallan el typecheck si alguien
 * revierte la ampliación, y también si alguien la abre de más.
 */
describe('E2-SCH-01 los orígenes nuevos existen en los tipos', () => {
  it('bootstrap es un source válido de la cola y del motor', () => {
    const entrada: MensajeEntrada = {
      channelAccountId: 'c', topic: 'ml.items', resourceId: 'MLA1', remoteVersion: 'v1',
      source: 'bootstrap', correlationId: 'r',
    };
    const contexto: ContextoEscritura = {
      channelAccountId: 'c', topic: 'ml.items', correlationId: 'r', runId: null, source: 'bootstrap',
    };
    expect([entrada.source, contexto.source]).toEqual(['bootstrap', 'bootstrap']);
    // @ts-expect-error un origen inventado no pasa: el tipo no quedó abierto a cualquier string.
    const invalido: MensajeEntrada['source'] = 'cualquiera';
    expect(invalido).toBe('cualquiera');
  });
});
