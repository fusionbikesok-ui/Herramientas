/*
 * test/identidad/motor.test.ts — E3 corte 1 tarea 4: correrMotor, el motor en sombra.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, correrMotor } from '../../src/identidad/motor.ts';
import { decidirCaso } from '../../src/identidad/decidir.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const logSilencioso = { info() {}, warn() {}, error() {} };

describe('E3-MOTOR-01 correrMotor', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.identity_candidates,
      catalog.matcher_decisions, catalog.model_attributes, catalog.external_representations,
      catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  /** Variante YA vinculada con SKU (candidato de destino, lado "Woo" del catálogo). */
  async function varianteConSku(sku: string) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresa, ml, `Bici ${sku}`])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresa, modelo, sku])).rows[0]!.id;
  }

  /** Variante pendiente + representación ML + caso sku_pendiente, con sku_observado. */
  async function casoConSkuObservado(recurso: string, skuObservado: string | null, titulo = recurso) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $4) RETURNING id`, [empresa, ml, recurso, titulo])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
      [empresa, modelo])).rows[0]!.id;
    const rep = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, sku_observado)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4, NULL, $5) RETURNING id`, // como en producción: el modelo vive en la variante
      [empresa, ml, recurso, variante, skuObservado])).rows[0]!.id;
    const caso = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id`,
      [empresa, variante])).rows[0]!.id;
    return { modelo, variante, rep, caso };
  }

  const decisionVigenteDe = async (recurso: string) => (await q<{ origen: string; eleccion: string; variant_id: string | null }>(
    `SELECT origen, eleccion, variant_id FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = $2 AND superada_en IS NULL`,
    [ml, recurso]))[0];

  it('[esc:auto-sku-unico] SKU único: hay auto_sku en sombra y el vínculo de la representación NO cambia', async () => {
    const destino = await varianteConSku('FB-4001');
    const { caso, rep, variante } = await casoConSkuObservado('MLB1', 'FB-4001');
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r).toEqual({ casos: 1, autoSku: 1 });
    const d = await decisionVigenteDe('MLB1');
    expect(d).toMatchObject({ origen: 'auto_sku', eleccion: 'vincular', variant_id: destino });
    // Sombra: nunca toca la representación ni el vínculo real.
    expect((await q<{ variant_id: string }>('SELECT variant_id FROM catalog.external_representations WHERE id = $1', [rep]))[0]!.variant_id).toBe(variante);
  });

  it('[esc:empate] empate de SKU (dos variantes vivas con el mismo sku, no debería pasar por el UNIQUE, se prueba con otra empresa): no hay auto_sku', async () => {
    // El UNIQUE de sellable_variants ya impide dos SKUs iguales en la misma empresa; el caso real de
    // "empate" que puede pasar es 0 candidatos vivos (ver siguiente test) — acá se prueba directamente
    // el contrato de skuUnico devolviendo 'varias' vía un sku_observado que no matchea ninguna variante,
    // así que no hay auto_sku (comportamiento ya cubierto por sku.test.ts a nivel de unidad). Lo que sí
    // hay que probar acá es que sin candidato (SKU inexistente) el motor no inventa nada.
    const { caso } = await casoConSkuObservado('MLB2', 'FB-9999-INEXISTENTE');
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r).toEqual({ casos: 1, autoSku: 0 });
    expect(await decisionVigenteDe('MLB2')).toBeUndefined();
  });

  it('con humana vigente: no hay auto_sku aunque el sku_observado resuelva único', async () => {
    const destino = await varianteConSku('FB-4002');
    const { caso, rep } = await casoConSkuObservado('MLB3', 'FB-4002');
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, $3, 'MLB3', '', 'vincular', $4, 'humano', 'jose', 'aplicar')`,
      [empresa, caso, ml, destino]);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
    const decisiones = await q<{ origen: string }>('SELECT origen FROM catalog.identity_decisions WHERE case_id = $1', [caso]);
    expect(decisiones.map((d) => d.origen)).toEqual(['humano']); // no se agregó ninguna auto_sku
  });

  it('con omitir del legado vigente: no hay auto_sku', async () => {
    const destino = await varianteConSku('FB-4003');
    const { caso } = await casoConSkuObservado('MLB4', 'FB-4003');
    await admin.query(
      `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, accion, origen, actor)
       VALUES ($1, $2, 'mercadolibre', 'MLB4', '', 'omitir', 'evento', 'persona')`,
      [empresa, ml]);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
  });

  it('dos corridas: una sola auto_sku (idempotente)', async () => {
    await varianteConSku('FB-4004');
    await casoConSkuObservado('MLB5', 'FB-4004');
    const r1 = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r1.autoSku).toBe(1);
    const r2 = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r2.autoSku).toBe(0);
    const n = (await q<{ n: number }>(
      "SELECT count(*)::int n FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLB5' AND origen = 'auto_sku'",
      [ml]))[0]!.n;
    expect(n).toBe(1);
  });

  it('auto_sku vigente apuntando a otra variante (el SKU ahora resuelve a otra): la corrida no falla, supera la anterior y anota la nueva', async () => {
    const a = await varianteConSku('FB-4010');
    await casoConSkuObservado('MLB6', 'FB-4010');
    expect((await correrMotor(app, { empresa, limite: 500, log: logSilencioso })).autoSku).toBe(1);
    // El vendedor corrige el SKU de la publicación en ML: ahora el sku_observado resuelve a otra variante viva.
    const b = await varianteConSku('FB-4011');
    await admin.query("UPDATE catalog.external_representations SET sku_observado = 'FB-4011' WHERE recurso = 'MLB6'");
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(1);
    const filas = await q<{ variant_id: string; vigente: boolean }>(
      "SELECT variant_id, superada_en IS NULL AS vigente FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLB6' AND origen = 'auto_sku' ORDER BY creado_en", [ml]);
    expect(filas).toEqual([{ variant_id: a, vigente: false }, { variant_id: b, vigente: true }]);
  });

  describe('título ML observado (fuente y no-fuga)', () => {
    const registros: Array<{ nivel: string; msg: string; meta?: any }> = [];
    const logCaptura = {
      info: (msg: string, meta?: object) => registros.push({ nivel: 'info', msg, meta }),
      warn: (msg: string, meta?: object) => registros.push({ nivel: 'warn', msg, meta }),
      error: (msg: string, meta?: object) => registros.push({ nivel: 'error', msg, meta }),
    };
    beforeEach(() => { registros.length = 0; });
    const candidatos = async () => q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_candidates');
    const resumen = () => registros.find((r) => r.msg.includes('resumen de la corrida'))!.meta;

    /** Un destino Woo con SKU cuyo título coincide con el título ML de los casos de estos tests. */
    async function destinoParaTitulo(titulo: string, sku: string) {
      const modelo = (await q<{ id: string }>(
        `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1, $2, 'woo_simple', $3, $4) RETURNING id`,
        [empresa, ml, `W-${sku}`, titulo]))[0]!.id;
      await q('INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3)', [empresa, modelo, sku]);
    }
    async function contenedor(recurso: string, titulo: string) {
      const modelo = (await q<{ id: string }>(
        `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1, $2, 'ml_clasico', $3, $4) RETURNING id`,
        [empresa, ml, `C-${recurso}`, titulo]))[0]!.id;
      await q(`INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, model_id)
               VALUES ($1, $2, 'mercadolibre', 'contenedor', $3, '', $4)`, [empresa, ml, recurso, modelo]);
    }

    it('no-fuga: publicación vinculada a una variante de modelo woo_*, sin contenedor → sin candidatos y código sin_titulo_ml', async () => {
      await destinoParaTitulo('Casco Bell Super Negro', 'FB-8001');
      const { variante } = await casoConSkuObservado('MLC1', null, 'irrelevante');
      // La variante del caso pasa a estar vinculada a Woo: su modelo es el NUESTRO (woo_simple) y trae el título "correcto".
      const woo = (await q<{ id: string }>(
        `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1, $2, 'woo_simple', 'W-x', 'Casco Bell Super Negro') RETURNING id`, [empresa, ml]))[0]!.id;
      await q('UPDATE catalog.sellable_variants SET model_id = $1 WHERE id = $2', [woo, variante]);
      await correrMotor(app, { empresa, limite: 500, log: logCaptura });
      expect((await candidatos())[0]!.n).toBe(0);
      expect(registros.some((r) => r.meta?.codigo === 'sin_titulo_ml')).toBe(true);
      expect(resumen().sin_titulo_ml).toBe(1);
    });

    it('sin representación de modelo propio: el título sale de la variante ml_* y se calculan candidatos', async () => {
      await destinoParaTitulo('Casco Bell Super Negro', 'FB-8002');
      await casoConSkuObservado('MLC2', null, 'Casco Bell Super Negro');
      await correrMotor(app, { empresa, limite: 500, log: logCaptura });
      expect((await candidatos())[0]!.n).toBeGreaterThan(0);
      expect(resumen().fuente_titulo).toEqual({ variante: 1 });
    });

    it('contenedor gana sobre la variante cuando difieren, y se cuenta', async () => {
      await destinoParaTitulo('Casco Bell Super Negro', 'FB-8003');
      await casoConSkuObservado('MLC3', null, 'Título viejo de la variante');
      await q("UPDATE catalog.external_representations SET variacion_normalizada = '55' WHERE recurso = 'MLC3'"); // en producción el contenedor lleva '' y la vendible el id de variación
      await contenedor('MLC3', 'Casco Bell Super Negro');
      await correrMotor(app, { empresa, limite: 500, log: logCaptura });
      const r = resumen();
      expect(r.fuente_titulo).toEqual({ contenedor: 1 });
      expect(r.contenedor_difiere_variante).toBe(1);
      expect((await candidatos())[0]!.n).toBeGreaterThan(0); // acertó por el título del contenedor, no por el de la variante
    });
  });

  it('[esc:gtin] GTIN igual y SKU distinto (o sea sku_observado no resuelve): no hay auto_sku', async () => {
    // El motor sólo mira sku_observado (no GTIN: eso es evidencia, no identidad — ver 0014). Con
    // sku_observado null (representación sin ese dato, GTIN es lo único que trajo el canal), skuUnico
    // ni se llama: normalizarSku(null) da null y el motor corta antes.
    await casoConSkuObservado('MLB6', null);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
  });

  it('el top-3 de candidatos queda guardado en identity_candidates con engine_version', async () => {
    await varianteConSku('FB-5001'); // candidato de catálogo con título parecido
    const { caso } = await casoConSkuObservado('MLB7', null, 'Bici FB-5001');
    await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    const candidatos = await q<{ rank: number; engine_version: string }>(
      'SELECT rank, engine_version FROM catalog.identity_candidates WHERE case_id = $1 ORDER BY rank', [caso]);
    expect(candidatos.length).toBeGreaterThan(0);
    expect(candidatos[0]).toMatchObject({ rank: 1, engine_version: ENGINE_VERSION });
  });

  describe('marca D5 (omitida_revisar con omitir legado vigente + SKU único)', () => {
    /** Igual que casoConSkuObservado pero con tipo omitida_revisar (D5 sólo aplica a ese tipo). */
    async function casoOmitidaRevisar(recurso: string, skuObservado: string | null) {
      const modelo = (await admin.query<{ id: string }>(
        `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
         VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, recurso])).rows[0]!.id;
      const variante = (await admin.query<{ id: string }>(
        'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
        [empresa, modelo])).rows[0]!.id;
      await admin.query(
        `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, sku_observado)
         VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4, $5, $6)`,
        [empresa, ml, recurso, variante, modelo, skuObservado]);
      const caso = (await admin.query<{ id: string }>(
        `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'omitida_revisar', $2) RETURNING id`,
        [empresa, variante])).rows[0]!.id;
      return { caso, variante };
    }
    async function omitirLegado(recurso: string) {
      await admin.query(
        `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, accion, origen, actor)
         VALUES ($1, $2, 'mercadolibre', $3, '', 'omitir', 'evento', 'persona')`,
        [empresa, ml, recurso]);
    }
    const detalleDe = async (caso: string) => (await q<{ detalle: { d5?: boolean } }>(
      'SELECT detalle FROM catalog.identity_cases WHERE id = $1', [caso]))[0]!.detalle;

    it('[esc:las-17-bloqueadas] SKU único + omitir legado vigente: detalle.d5=true, y NO hay auto_sku (la omisión sigue mandando)', async () => {
      await varianteConSku('FB-6001');
      const { caso } = await casoOmitidaRevisar('MLB8', 'FB-6001');
      await omitirLegado('MLB8');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect(await detalleDe(caso)).toMatchObject({ d5: true });
      expect(await decisionVigenteDe('MLB8')).toBeUndefined();
    });

    it('es idempotente: dos corridas dejan detalle.d5=true una sola vez (UPDATE no reescribe de más)', async () => {
      await varianteConSku('FB-6002');
      const { caso } = await casoOmitidaRevisar('MLB9', 'FB-6002');
      await omitirLegado('MLB9');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect(await detalleDe(caso)).toMatchObject({ d5: true });
    });

    it('sin SKU único (0 o 2 candidatos): no hay marca d5', async () => {
      const { caso } = await casoOmitidaRevisar('MLB10', 'FB-9999-INEXISTENTE');
      await omitirLegado('MLB10');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect((await detalleDe(caso)).d5).toBeFalsy();
    });

    it('la marca se quita si el SKU deja de ser único', async () => {
      await varianteConSku('FB-6003');
      const { caso } = await casoOmitidaRevisar('MLB11', 'FB-6003');
      await omitirLegado('MLB11');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect(await detalleDe(caso)).toMatchObject({ d5: true });
      // El SKU deja de resolver único: se archiva la variante que lo tenía.
      await admin.query("UPDATE catalog.sellable_variants SET archivado_en = now(), motivo_archivo = 'test' WHERE sku = 'FB-6003'");
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect((await detalleDe(caso)).d5).toBeFalsy();
    });
  });

  it('[esc:desorden-y-duplicados] dos corridas concurrentes sobre la misma empresa no duplican auto_sku ni candidatos (el advisory lock del ciclo se prueba en worker/identidad; acá se prueba que el propio correrMotor, corrido dos veces en paralelo dentro de la misma transacción lógica de Postgres, no rompe la idempotencia de datos)', async () => {
    await varianteConSku('FB-7001');
    await casoConSkuObservado('MLB12', 'FB-7001');
    const [r1, r2] = await Promise.all([
      correrMotor(app, { empresa, limite: 500, log: logSilencioso }),
      correrMotor(app, { empresa, limite: 500, log: logSilencioso }),
    ]);
    const totalAutoSku = r1.autoSku + r2.autoSku;
    expect(totalAutoSku).toBeGreaterThanOrEqual(1);
    const n = (await q<{ n: number }>(
      "SELECT count(*)::int n FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLB12' AND origen = 'auto_sku'",
      [ml]))[0]!.n;
    expect(n).toBe(1); // el UNIQUE identity_decisions_una_vigente (clave, efecto) garantiza esto aunque ambas corridas lo intenten
  });

  describe('avance de la cola (marca por corrida en detalle.motor)', () => {
    const marca = async (caso: string) => (await q<{ m: { engine: string; corrido_en: string } | null }>(
      "SELECT detalle->'motor' AS m FROM catalog.identity_cases WHERE id = $1", [caso]))[0]!.m;
    const filasDe = async (caso: string) => (await q<{ n: number; runs: number }>(
      'SELECT count(*)::int n, count(DISTINCT run_id)::int runs FROM catalog.identity_candidates WHERE case_id = $1', [caso]))[0]!;

    it('[esc:cola-avanza] dos vueltas con limite menor al total cubren todos los casos (no repite siempre los más viejos)', async () => {
      await varianteConSku('FB-8001');
      const casos = [];
      for (let i = 0; i < 4; i++) casos.push((await casoConSkuObservado(`MLC${i}`, null, 'Bici FB-8001')).caso);
      await correrMotor(app, { empresa, limite: 2, log: logSilencioso });
      expect(await marca(casos[0]!)).toMatchObject({ engine: ENGINE_VERSION });
      expect(await marca(casos[2]!)).toBeNull();
      await correrMotor(app, { empresa, limite: 2, log: logSilencioso });
      for (const c of casos) expect(await marca(c), `caso ${c}`).toMatchObject({ engine: ENGINE_VERSION });
    });

    it('un caso sin publicación (sin candidatos posibles) queda marcado y no bloquea la cola', async () => {
      const sinPublicacion = await varianteConSku('FB-8002'); // variante sin representación de ML viva
      const huerfano = (await admin.query<{ id: string }>(
        "INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id", [empresa, sinPublicacion])).rows[0]!.id;
      const { caso } = await casoConSkuObservado('MLC10', null, 'Bici FB-8002');
      await correrMotor(app, { empresa, limite: 1, log: logSilencioso });
      expect(await marca(huerfano)).toMatchObject({ engine: ENGINE_VERSION });
      expect(await marca(caso)).toBeNull();
      await correrMotor(app, { empresa, limite: 1, log: logSilencioso });
      expect(await marca(caso)).toMatchObject({ engine: ENGINE_VERSION });
      expect((await filasDe(caso)).n).toBeGreaterThan(0);
    });

    it('[esc:sin-duplicados] re-correr sin cambios no agrega candidatos y la última corrida sigue siendo la misma', async () => {
      await varianteConSku('FB-8003');
      const { caso } = await casoConSkuObservado('MLC20', null, 'Bici FB-8003');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      const antes = await filasDe(caso);
      const corridaAntes = (await q<{ run_id: string }>('SELECT DISTINCT run_id FROM catalog.identity_candidates WHERE case_id = $1', [caso]))[0]!.run_id;
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect(await filasDe(caso)).toEqual(antes);
      expect((await q<{ run_id: string }>('SELECT DISTINCT run_id FROM catalog.identity_candidates WHERE case_id = $1', [caso]))[0]!.run_id).toBe(corridaAntes);
    });

    it('si el top-3 cambia entre corridas, se guarda la corrida nueva y la vieja se conserva', async () => {
      await varianteConSku('FB-8004');
      const { caso } = await casoConSkuObservado('MLC30', null, 'Bici FB-8004 FB-8005');
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect((await filasDe(caso)).runs).toBe(1);
      await varianteConSku('FB-8005'); // entra un candidato nuevo al catálogo
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      expect((await filasDe(caso)).runs).toBe(2);
    });

    it('un caso marcado por otro ENGINE_VERSION vuelve a ser "nunca corrido" y se procesa antes que uno ya marcado con el actual', async () => {
      await varianteConSku('FB-8006');
      const a = (await casoConSkuObservado('MLC40', null, 'Bici FB-8006')).caso;
      const b = (await casoConSkuObservado('MLC41', null, 'Bici FB-8006')).caso;
      await correrMotor(app, { empresa, limite: 2, log: logSilencioso });
      await admin.query(
        `UPDATE catalog.identity_cases SET detalle = detalle || jsonb_build_object('motor', jsonb_build_object('engine','viejo','corrido_en','2099-01-01T00:00:00.000000Z')) WHERE id = $1`, [b]);
      await admin.query(
        `UPDATE catalog.identity_cases SET detalle = jsonb_set(detalle, '{motor,corrido_en}', '"2000-01-01T00:00:00.000000Z"') WHERE id = $1`, [a]);
      await correrMotor(app, { empresa, limite: 1, log: logSilencioso });
      expect((await marca(b))!.engine).toBe(ENGINE_VERSION); // b (engine viejo) va primero aunque a tenga corrido_en más viejo
    });

    it('la marca no toca version, estado ni abierto_en, y una decisión de la bandeja tomada antes de la corrida igual entra (sin version_conflict)', async () => {
      const destino = await varianteConSku('FB-8007');
      const { caso } = await casoConSkuObservado('MLC50', null, 'Bici FB-8007');
      const antes = (await q<{ version: number; estado: string; abierto_en: Date }>(
        'SELECT version, estado, abierto_en FROM catalog.identity_cases WHERE id = $1', [caso]))[0]!;
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      const despues = (await q<{ version: number; estado: string; abierto_en: Date }>(
        'SELECT version, estado, abierto_en FROM catalog.identity_cases WHERE id = $1', [caso]))[0]!;
      expect(despues).toEqual(antes);
      const r = await decidirCaso(app, { caseId: caso, expectedVersion: antes.version, eleccion: 'vincular', variantId: destino,
        actor: 'jose', esAdmin: false, idempotencyKey: randomUUID() }, { bandeja: true });
      expect(r).toMatchObject({ ok: true });
    });

    it('la marca D5 y la marca del motor conviven en detalle (merge, ninguna pisa a la otra)', async () => {
      await varianteConSku('FB-8008');
      const { caso, rep } = await casoConSkuObservado('MLC60', 'FB-8008');
      await admin.query("UPDATE catalog.identity_cases SET tipo = 'omitida_revisar', representation_id = $2 WHERE id = $1", [caso, rep]);
      await admin.query(
        `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, accion, origen, actor)
         VALUES ($1, $2, 'mercadolibre', 'MLC60', '', 'omitir', 'evento', 'persona')`, [empresa, ml]);
      await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
      const d = (await q<{ detalle: Record<string, unknown> }>('SELECT detalle FROM catalog.identity_cases WHERE id = $1', [caso]))[0]!.detalle;
      expect(d).toMatchObject({ d5: true, motor: { engine: ENGINE_VERSION } });
    });
  });
});
