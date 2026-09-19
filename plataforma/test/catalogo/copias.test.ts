/*
 * test/catalogo/copias.test.ts — E2 T1 tarea 7: copias en tandas y eventos del matcher.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  abrirCopia, aplicarEvento, aplicarEventoIdentidad, confirmarCopia, ErrorCopia, hashFilas, recibirLote, type EventoDecision, type EventoIdentidad, type FilaDecision, type FilaIdentidad,
} from '../../src/catalogo/copias.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E2-CPY-01 copias del matcher', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  const fila = (recurso: string, sku: string | null, accion: FilaDecision['accion'] = 'confirmar', variacion = ''): FilaDecision => ({
    recurso, variacion, sku, accion, actor: 'persona', motivo: null, confirmado_por: 'jose', actualizado_en_legado: null,
  });
  const vigentes = () => q<{ recurso: string; sku: string | null; accion: string; origen: string }>(
    'SELECT recurso, sku, accion, origen FROM catalog.matcher_decisions WHERE vigente_hasta IS NULL ORDER BY recurso');

  /** Copia completa: abrir, mandar los lotes y confirmar. */
  async function copiar(filas: FilaDecision[], opciones: { lotes?: number; corte?: string } = {}) {
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: filas.length, hashEsperado: hashFilas(filas), corte: opciones.corte ?? new Date().toISOString() });
    const tam = Math.max(1, Math.ceil(filas.length / (opciones.lotes ?? 1)));
    for (let i = 0, n = 1; i < filas.length || n === 1; i += tam, n++) await recibirLote(app, copia, n, filas.slice(i, i + tam));
    return { copia, resultado: await enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml)) };
  }
  const evento = (e: Partial<EventoDecision> & { recurso: string }): EventoDecision => ({
    evento_id: randomUUID(), variacion: '', accion: 'confirmar', sku: null, actor: 'persona', motivo: null, confirmado_por: 'jose',
    ocurrido_en: new Date().toISOString(), ...e,
  });

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await app.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.copias_lotes, catalog.copias,
      catalog.eventos_recibidos, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('una copia en varios lotes abre todas sus decisiones', async () => {
    const { resultado } = await copiar([fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2'), fila('MLA3', null, 'omitir')], { lotes: 3 });
    expect(resultado).toMatchObject({ abiertas: 3, cerradas: 0 });
    expect(await vigentes()).toEqual([
      { recurso: 'MLA1', sku: 'FB-1', accion: 'confirmar', origen: 'copia' },
      { recurso: 'MLA2', sku: 'FB-2', accion: 'confirmar', origen: 'copia' },
      { recurso: 'MLA3', sku: null, accion: 'omitir', origen: 'copia' },
    ]);
  });

  it('un lote intermedio no cambia nada: sólo el confirmar aplica', async () => {
    await copiar([fila('MLA1', 'FB-1')]);
    const filas = [fila('MLA9', 'FB-9')];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 1, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
    await recibirLote(app, copia, 1, filas);
    // MLA1 no viene en esta copia, pero sin confirmar sigue vigente y MLA9 todavía no existe.
    expect((await vigentes()).map((v) => v.recurso)).toEqual(['MLA1']);
  });

  it('la segunda copia cierra lo ausente, reemplaza lo distinto y deja lo igual', async () => {
    await copiar([fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2'), fila('MLA3', 'FB-3')]);
    const { resultado } = await copiar([fila('MLA1', 'FB-1'), fila('MLA2', 'FB-20')]);
    expect(resultado).toMatchObject({ sinCambios: 1, cerradas: 2, abiertas: 1 });
    expect(await vigentes()).toEqual([
      { recurso: 'MLA1', sku: 'FB-1', accion: 'confirmar', origen: 'copia' },
      { recurso: 'MLA2', sku: 'FB-20', accion: 'confirmar', origen: 'copia' },
    ]);
    // El historial se conserva: la de FB-2 y la de MLA3 están cerradas con su motivo, no borradas.
    expect(await q("SELECT recurso, motivo_cierre FROM catalog.matcher_decisions WHERE vigente_hasta IS NOT NULL ORDER BY recurso"))
      .toEqual([{ recurso: 'MLA2', motivo_cierre: expect.stringMatching(/reemplazada/) }, { recurso: 'MLA3', motivo_cierre: expect.stringMatching(/ausente/) }]);
  });

  it('confirmar con un lote faltante falla sin efecto y la copia queda abierta para completarla', async () => {
    const filas = [fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2')];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 2, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
    await recibirLote(app, copia, 1, [filas[0]]);
    await expect(enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml))).rejects.toMatchObject({ codigo: 'copia_incompleta' });
    expect(await vigentes()).toEqual([]);
    // Se completa y ahora sí.
    await recibirLote(app, copia, 2, [filas[1]]);
    await expect(enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml))).resolves.toMatchObject({ abiertas: 2 });
  });

  it('un hueco en la numeración de lotes también es copia incompleta', async () => {
    const filas = [fila('MLA1', 'FB-1')];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 1, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
    await recibirLote(app, copia, 2, filas);
    await expect(enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml))).rejects.toMatchObject({ codigo: 'copia_incompleta' });
  });

  it('confirmar con hash distinto falla sin efecto', async () => {
    const filas = [fila('MLA1', 'FB-1')];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 1, hashEsperado: hashFilas([fila('MLA1', 'FB-999')]), corte: new Date().toISOString() });
    await recibirLote(app, copia, 1, filas);
    await expect(enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml))).rejects.toMatchObject({ codigo: 'hash_distinto' });
    expect(await vigentes()).toEqual([]);
  });

  it('el hash no depende del orden de las filas', () => {
    const a = [fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2')];
    expect(hashFilas(a)).toBe(hashFilas([...a].reverse()));
    expect(hashFilas(a)).not.toBe(hashFilas([fila('MLA1', 'FB-1'), fila('MLA2', 'FB-3')]));
  });

  it('confirmar dos veces no duplica', async () => {
    const { copia } = await copiar([fila('MLA1', 'FB-1')]);
    await expect(enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml))).resolves.toMatchObject({ yaConfirmada: true });
    expect(await vigentes()).toHaveLength(1);
  });

  it('un lote repetido idéntico se acepta; con otro contenido, no; y a una copia confirmada no entran lotes', async () => {
    const filas = [fila('MLA1', 'FB-1')];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 1, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
    await recibirLote(app, copia, 1, filas);
    await expect(recibirLote(app, copia, 1, filas)).resolves.toBeUndefined();
    await expect(recibirLote(app, copia, 1, [fila('MLA1', 'FB-2')])).rejects.toMatchObject({ codigo: 'lote_repetido' });
    await enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml));
    await expect(recibirLote(app, copia, 2, filas)).rejects.toMatchObject({ codigo: 'copia_cerrada' });
  });

  it('LA REGLA DEL CORTE: una decisión por evento posterior al corte no la pisa ni la cierra la copia', async () => {
    const corte = new Date(Date.now() - 60_000).toISOString();
    // Después del corte, el operador cambió MLA1 y creó MLA5. La copia (foto de antes) no los conoce así.
    await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, evento({ recurso: 'MLA1', sku: 'FB-100' })));
    await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, evento({ recurso: 'MLA5', sku: 'FB-5' })));
    const { resultado } = await copiar([fila('MLA1', 'FB-1')], { corte });
    expect(resultado.masNuevasQueLaCopia).toBe(2);
    expect(await vigentes()).toEqual([
      { recurso: 'MLA1', sku: 'FB-100', accion: 'confirmar', origen: 'evento' },
      { recurso: 'MLA5', sku: 'FB-5', accion: 'confirmar', origen: 'evento' },
    ]);
  });

  describe('eventos', () => {
    it('un evento cierra la vigencia anterior de su clave y abre la nueva', async () => {
      await copiar([fila('MLA1', 'FB-1')]);
      expect(await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, evento({ recurso: 'MLA1', sku: 'FB-2', actor: 'sistema', motivo: 'autoasignación por SKU' }))))
        .toBe('aplicado');
      expect(await q('SELECT sku, actor, motivo FROM catalog.matcher_decisions WHERE vigente_hasta IS NULL'))
        .toEqual([{ sku: 'FB-2', actor: 'sistema', motivo: 'autoasignación por SKU' }]);
    });

    it('el mismo evento dos veces se aplica una sola', async () => {
      const e = evento({ recurso: 'MLA1', sku: 'FB-1' });
      await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, e));
      expect(await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, e))).toBe('repetido');
      expect(await q('SELECT count(*)::int n FROM catalog.matcher_decisions')).toEqual([{ n: 1 }]);
    });

    it('un evento más viejo que la decisión vigente no la vuelve atrás', async () => {
      await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, evento({ recurso: 'MLA1', sku: 'FB-2' })));
      const viejo = evento({ recurso: 'MLA1', sku: 'FB-1', ocurrido_en: new Date(Date.now() - 3_600_000).toISOString() });
      expect(await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, viejo))).toBe('viejo');
      expect((await vigentes())[0]!.sku).toBe('FB-2');
    });

    it('revocar cierra la vigente sin abrir otra y deja el motivo', async () => {
      await copiar([fila('MLA1', 'FB-1')]);
      await enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, evento({ recurso: 'MLA1', accion: 'revocar', motivo: 'vinculada por error' })));
      expect(await vigentes()).toEqual([]);
      expect(await q('SELECT motivo_cierre FROM catalog.matcher_decisions')).toEqual([{ motivo_cierre: 'revocada en el legado: vinculada por error' }]);
    });
  });

  describe('casos de identidad del legado', () => {
    const caso = (caso_legado: string, recurso: string, prioridad: FilaIdentidad['prioridad'] = 'normal'): FilaIdentidad =>
      ({ caso_legado, recurso, variacion: '', prioridad, detalle: { motivo: 'nombre ambiguo' } });
    async function copiarIdentidad(filas: FilaIdentidad[]) {
      const copia = await abrirCopia(app, { empresa, tipo: 'identidad', totalEsperado: filas.length, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
      await recibirLote(app, copia, 1, filas);
      return enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml));
    }
    async function representacion(recurso: string) {
      const m = (await admin.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1,$2,'ml_simple',$3,'t') RETURNING id`, [empresa, ml, recurso])).rows[0]!.id;
      const v = (await admin.query<{ id: string }>('INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1,$2) RETURNING id', [empresa, m])).rows[0]!.id;
      await admin.query(`INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id) VALUES ($1,$2,'mercadolibre',$3,'vendible',$4)`, [empresa, ml, recurso, v]);
    }

    it('abre un caso por publicación conocida y cuenta las que todavía no están', async () => {
      await representacion('MLA1');
      const r = await copiarIdentidad([caso('c1', 'MLA1', 'urgente'), caso('c2', 'MLA2')]);
      expect(r).toMatchObject({ abiertas: 1, sinRepresentacion: 1 });
      expect(await q("SELECT tipo, prioridad, detalle->>'caso_legado' AS c FROM catalog.identity_cases"))
        .toEqual([{ tipo: 'identidad_legado', prioridad: 'urgente', c: 'c1' }]);
    });

    it('dos casos del legado sobre la misma publicación conviven, y resolver uno no cierra el otro', async () => {
      await representacion('MLA1');
      await copiarIdentidad([caso('c1', 'MLA1'), caso('c2', 'MLA1')]);
      expect(await q("SELECT count(*)::int n FROM catalog.identity_cases WHERE cerrado_en IS NULL")).toEqual([{ n: 2 }]);
      await copiarIdentidad([caso('c2', 'MLA1')]);
      expect(await q("SELECT detalle->>'caso_legado' AS c FROM catalog.identity_cases WHERE cerrado_en IS NULL")).toEqual([{ c: 'c2' }]);
      // Por evento, lo mismo: cerrar c2 no toca a un c3 abierto sobre la misma publicación.
      const ev = (caso_legado: string, abierto: boolean): EventoIdentidad => ({ evento_id: randomUUID(), caso_legado, recurso: 'MLA1', variacion: '',
        prioridad: 'normal', abierto, detalle: {}, ocurrido_en: new Date().toISOString() });
      await enTransaccion(app, (tx) => aplicarEventoIdentidad(tx, empresa, ml, ev('c3', true)));
      await enTransaccion(app, (tx) => aplicarEventoIdentidad(tx, empresa, ml, ev('c2', false)));
      expect(await q("SELECT detalle->>'caso_legado' AS c FROM catalog.identity_cases WHERE cerrado_en IS NULL")).toEqual([{ c: 'c3' }]);
    });

    it('un cambio de prioridad o de detalle en el legado llega por la copia', async () => {
      await representacion('MLA1');
      await copiarIdentidad([caso('c1', 'MLA1')]);
      await copiarIdentidad([{ ...caso('c1', 'MLA1', 'urgente'), detalle: { motivo: 'otra clasificación' } }]);
      expect(await q("SELECT prioridad, detalle->>'motivo' AS m FROM catalog.identity_cases WHERE cerrado_en IS NULL"))
        .toEqual([{ prioridad: 'urgente', m: 'otra clasificación' }]);
    });

    it('eventos de identidad: abre, actualiza la prioridad, cierra, y deduplica', async () => {
      await representacion('MLA1');
      const ev = (abierto: boolean, prioridad: EventoIdentidad['prioridad'] = 'normal', evento_id = randomUUID()): EventoIdentidad =>
        ({ evento_id, caso_legado: '7', recurso: 'MLA1', variacion: '', prioridad, abierto, detalle: { estado: 'x' }, ocurrido_en: new Date().toISOString() });
      const ap = (e: EventoIdentidad) => enTransaccion(app, (tx) => aplicarEventoIdentidad(tx, empresa, ml, e));
      await ap(ev(true));
      const repetido = ev(true, 'urgente');
      await ap(repetido);
      expect(await ap(repetido)).toBe('repetido');
      expect(await q("SELECT prioridad, cerrado_en FROM catalog.identity_cases WHERE tipo = 'identidad_legado'")).toEqual([{ prioridad: 'urgente', cerrado_en: null }]);
      await ap(ev(false));
      expect(await q("SELECT motivo_cierre FROM catalog.identity_cases WHERE tipo = 'identidad_legado'")).toEqual([{ motivo_cierre: 'resuelto en el legado' }]);
      // Sin publicación en el catálogo no hay a qué colgarlo: lo trae la copia diaria.
      expect(await ap({ ...ev(true), recurso: 'MLA404' })).toBe('sin_representacion');
    });

    it('un caso que ya no viene en la copia se cierra como resuelto en el legado', async () => {
      await representacion('MLA1');
      await copiarIdentidad([caso('c1', 'MLA1')]);
      const r = await copiarIdentidad([]);
      expect(r.cerradas).toBe(1);
      expect(await q('SELECT motivo_cierre FROM catalog.identity_cases')).toEqual([{ motivo_cierre: 'resuelto en el legado' }]);
    });
  });

  it('ErrorCopia lleva un código que la API traduce', () => {
    expect(new ErrorCopia('hash_distinto', 'x').codigo).toBe('hash_distinto');
  });
});
