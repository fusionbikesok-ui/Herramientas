/*
 * src/catalogo/bootstrap.ts — la lectura completa inicial del catálogo (E2 T1, tarea 12).
 *
 * El inbox de E1 sólo encola lo que CAMBIÓ: un producto que no se tocó desde que existe la sombra nunca pasó
 * por ahí, y el proyector no lo vería jamás. El bootstrap lee todo una vez por cuenta y lo encola con
 * source='bootstrap'. Lector propio: no toca los adaptadores de las corrientes diarias (hallazgo 25).
 *
 *   - Una página por vuelta, y el checkpoint (página y cursor) se guarda en la MISMA transacción que los mensajes
 *     de esa página: si el proceso muere, el que arranca sigue en la última página confirmada, sin huecos ni
 *     páginas perdidas. Encolar dos veces la misma versión no duplica (clave única del inbox).
 *   - Ritmo: a lo sumo `rpm` llamadas al canal por minuto (decisión de José: 10, se sube de madrugada), en serie.
 *   - Cede: si hay más de `cedeSenales` señales de ML esperando, o el canal devuelve 429, la vuelta no avanza.
 *     No mira el inbox para ceder: nadie lo consume todavía y el bootstrap quedaría pausado para siempre
 *     (hallazgo 30).
 */
import type pg from 'pg';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { ErrorCanalTerminal, type TransporteCanal } from '../reconciliacion/cliente-http.ts';
import { hashCanonico, jsonCanonico } from '../reconciliacion/canonico.ts';
import { exigirLista, exigirRegistro, idTexto } from '../reconciliacion/adaptadores/comun.ts';
import { itemMl } from '../reconciliacion/adaptadores/ml.ts';
import { productoWoo } from '../reconciliacion/adaptadores/woo.ts';
import type { RecursoRemoto } from '../reconciliacion/tipos.ts';
import { ErrorBarridoReintentable } from '../worker/barridos.ts';
import { cifrarSobre, type KeyringSobre } from '../seguridad/sobre.ts';

export type TopicoBootstrap = 'ml.items' | 'woo.products';

export class ErrorLeasePerdido extends Error { override name = 'ErrorLeasePerdido'; }

export interface CuentaBootstrap {
  id: string;
  topic: TopicoBootstrap;
  transporte: TransporteCanal;
  /** Sólo ML: el scan de ítems es por vendedor. */
  sellerId?: string;
}

export interface OpcionesBootstrap {
  pool: pg.Pool;
  keyring: KeyringSobre;
  rpm: number;
  cedeSenales: number;
  workerId: string;
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  leaseMs?: number;
}

export type ResultadoPagina =
  | { estado: 'avanzo'; pagina: number; encolados: number; leidos: number }
  | { estado: 'terminada' | 'ocupada' | 'cedio_senales' | 'reinicio_scan'; detalle?: string }
  | { estado: 'cedio_429'; detalle?: string; retryAfterS?: number };

/** Una página leída del canal: los recursos y la posición siguiente (null = terminó). */
interface Pagina { recursos: RecursoRemoto[]; siguiente: string | null }

const ML_POR_PAGINA = 100;
const ML_BULK = 20;
const WOO_POR_PAGINA = 100;

/** Cuántas llamadas por minuto: separa cada llamada al menos 60 s / rpm. En serie, nunca en paralelo. */
function crearRitmo(rpm: number, ahora: () => Date, dormir: (ms: number) => Promise<void>) {
  const intervalo = 60_000 / rpm;
  let ultima = -Infinity;
  return async <T>(llamada: () => Promise<T>): Promise<T> => {
    const espera = ultima + intervalo - ahora().getTime();
    if (espera > 0) await dormir(espera);
    ultima = ahora().getTime();
    return llamada();
  };
}

async function leerPaginaMl(c: CuentaBootstrap, cursor: string | null, llamar: ReturnType<typeof crearRitmo>): Promise<Pagina> {
  const q = new URLSearchParams({ search_type: 'scan', limit: String(ML_POR_PAGINA) });
  if (cursor) q.set('scroll_id', cursor);
  const r = await llamar(() => c.transporte.get(`/users/${encodeURIComponent(c.sellerId!)}/items/search?${q}`));
  const body = exigirRegistro(r.body, 'items/search');
  const ids = exigirLista(body.results, 'items/search results').map(idTexto);
  const recursos: RecursoRemoto[] = [];
  // Multigets en serie, no en paralelo: cada uno cuenta para el ritmo.
  for (let i = 0; i < ids.length; i += ML_BULK) {
    const lote = ids.slice(i, i + ML_BULK);
    const rb = await llamar(() => c.transporte.get(`/items/bulk?ids=${lote.map(encodeURIComponent).join(',')}`));
    for (const entrada of exigirLista(rb.body, '/items/bulk')) {
      const e = exigirRegistro(entrada, 'bulk');
      // Un ítem borrado entre el scan y el bulk no se encola; uno que falló suelto tampoco (lo trae la relectura).
      if (e.status_code === 200) recursos.push(itemMl(e.body));
    }
  }
  const siguiente = typeof body.scroll_id === 'string' && body.scroll_id && ids.length > 0 ? body.scroll_id : null;
  return { recursos, siguiente };
}

/*
 * El bootstrap de Woo va por el gateway del legado, cuyo catálogo de operaciones es cerrado:
 * `woo.products.list` es la única que devuelve el producto completo, y exige la ventana de modificación
 * (`modified_after`/`modified_before`, `dates_are_gmt=true`, `orderby=modified`). La que sí barre por id,
 * `woo.presence.list`, trae `_fields=id` y no alcanza para proyectar.
 *
 * Por eso el barrido completo se pide como una ventana que abarca todo: desde el epoch hasta un futuro
 * lejano, ordenado por fecha de modificación. Un listado por id se rechaza **antes de red** con
 * "ruta sin operación de gateway: valor de dates_are_gmt", que es lo que pasó al encender el paso 8
 * el 2026-09-19.
 */
const WOO_DESDE = '1970-01-01T00:00:00Z';
const WOO_HASTA = '2100-01-01T00:00:00Z';

async function leerPaginaWoo(c: CuentaBootstrap, cursor: string | null, llamar: ReturnType<typeof crearRitmo>): Promise<Pagina> {
  const pagina = cursor ? Number(cursor) : 1;
  const q = new URLSearchParams({
    modified_after: WOO_DESDE, modified_before: WOO_HASTA, dates_are_gmt: 'true',
    per_page: String(WOO_POR_PAGINA), page: String(pagina), orderby: 'modified', order: 'asc', status: 'any',
  });
  const r = await llamar(() => c.transporte.get(`/wp-json/wc/v3/products?${q}`));
  const crudos = exigirLista(r.body, '/products');
  const recursos: RecursoRemoto[] = [];
  for (const crudo of crudos) {
    recursos.push(productoWoo(crudo));
    // Las variaciones no vienen en el listado: se piden por padre. Sin ellas no habría variantes de Woo.
    if ((crudo as { type?: unknown }).type === 'variable') {
      const padre = idTexto((crudo as { id?: unknown }).id);
      for (let vp = 1; ; vp++) {
        const rv = await llamar(() => c.transporte.get(`/wp-json/wc/v3/products/${encodeURIComponent(padre)}/variations?per_page=100&page=${vp}`));
        const vars = exigirLista(rv.body, '/variations');
        recursos.push(...vars.map(productoWoo));
        if (vars.length < 100) break;
      }
    }
  }
  const total = Number(r.headers.get('x-wp-totalpages') ?? '0');
  return { recursos, siguiente: crudos.length > 0 && pagina < total ? String(pagina + 1) : null };
}

async function encolar(tx: Consultable, cuenta: string, topic: TopicoBootstrap, rec: RecursoRemoto, keyring: KeyringSobre): Promise<boolean> {
  const sobre = cifrarSobre(Buffer.from(jsonCanonico(rec.payload), 'utf8'),
    { account: cuenta, topic, resource: rec.id, remoteVersion: rec.version }, keyring);
  const r = await tx.query(
    `INSERT INTO integrations.inbox_messages
      (channel_account_id, topic, resource_id, remote_version, source, correlation_id, payload_hash,
       payload_ciphertext, payload_key_id, payload_nonce, payload_tag)
     VALUES ($1, $2, $3, $4, 'bootstrap', gen_random_uuid(), $5, $6, $7, $8, $9)
     ON CONFLICT (channel_account_id, topic, resource_id, remote_version) DO NOTHING`,
    [cuenta, topic, rec.id, rec.version, hashCanonico(rec.payload), sobre.ciphertext, sobre.keyId, sobre.nonce, sobre.tag]);
  return r.rowCount === 1;
}

/** Crea la corrida de una cuenta si no existe. Idempotente: una por cuenta y tópico, para siempre. */
export async function prepararBootstrap(db: Consultable, cuenta: string, topic: TopicoBootstrap): Promise<void> {
  await db.query(`INSERT INTO catalog.bootstrap_runs (channel_account_id, topic) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cuenta, topic]);
}

export function crearBootstrap(o: OpcionesBootstrap) {
  const ahora = o.ahora ?? (() => new Date());
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const llamar = crearRitmo(o.rpm, ahora, dormir);
  const leaseMs = o.leaseMs ?? 10 * 60_000;

  return {
    /** Lee y encola UNA página de la cuenta. */
    async unaPagina(c: CuentaBootstrap): Promise<ResultadoPagina> {
      // Tomar la corrida con lease: dos workers no leen la misma cuenta a la vez.
      const tomada = (await o.pool.query<{ id: string; pagina_confirmada: number; cursor: string | null; lease_token: string }>(
        `UPDATE catalog.bootstrap_runs SET estado = 'corriendo', lease_token = gen_random_uuid(),
                lease_until = $3::timestamptz + make_interval(secs => $4), worker_id = $5
          WHERE channel_account_id = $1 AND topic = $2
            AND (estado IN ('pendiente', 'pausada') OR (estado = 'corriendo' AND lease_until < $3::timestamptz))
          RETURNING id, pagina_confirmada, cursor, lease_token`,
        [c.id, c.topic, ahora().toISOString(), leaseMs / 1000, o.workerId])).rows[0];
      if (!tomada) {
        const e = (await o.pool.query<{ estado: string }>('SELECT estado FROM catalog.bootstrap_runs WHERE channel_account_id = $1 AND topic = $2', [c.id, c.topic])).rows[0];
        return { estado: e?.estado === 'terminada' ? 'terminada' : 'ocupada' };
      }
      const soltar = (estado: 'pausada' | 'terminada', extra: string, params: unknown[] = []) => o.pool.query(
        `UPDATE catalog.bootstrap_runs SET estado = $2, lease_token = NULL, lease_until = NULL, worker_id = NULL ${extra}
          WHERE id = $1 AND lease_token = $3`, [tomada.id, estado, tomada.lease_token, ...params]);

      // Ceder ante señales de ML esperando: son relecturas que sí tienen consumidor y compiten por el cupo.
      const esperando = (await o.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM integrations.reconciliation_signals
          WHERE topic LIKE 'ml.%' AND status IN ('pending', 'retryable') AND available_at <= now()`)).rows[0]!.n;
      if (esperando > o.cedeSenales) {
        await soltar('pausada', '');
        return { estado: 'cedio_senales', detalle: `${esperando} señales de ML esperando` };
      }

      // El lease se renueva antes de cada llamada al canal (hallazgo alto de la revisión): a 10 por minuto, una
      // página de Woo con 100 padres variables son más de 100 llamadas, bastante más que un lease fijo; al vencer,
      // otro worker retomaba la misma página y ninguno podía confirmar el checkpoint.
      const renovando = (async <T>(llamada: () => Promise<T>): Promise<T> => {
        const r = await o.pool.query(
          `UPDATE catalog.bootstrap_runs SET lease_until = $3::timestamptz + make_interval(secs => $4)
            WHERE id = $1 AND lease_token = $2`, [tomada.id, tomada.lease_token, ahora().toISOString(), leaseMs / 1000]);
        if (r.rowCount !== 1) throw new ErrorLeasePerdido('otro worker tomó el bootstrap de esta cuenta');
        return llamar(llamada);
      }) as ReturnType<typeof crearRitmo>;

      let pagina: Pagina;
      try {
        pagina = c.topic === 'ml.items' ? await leerPaginaMl(c, tomada.cursor, renovando) : await leerPaginaWoo(c, tomada.cursor, renovando);
      } catch (e) {
        // Perdimos el lease: la página es de otro worker ahora. No se toca la corrida.
        if (e instanceof ErrorLeasePerdido) return { estado: 'ocupada', detalle: e.message };
        if (e instanceof ErrorBarridoReintentable) {
          await soltar('pausada', ', error_detail = $4', [e.message.slice(0, 200)]);
          return { estado: 'cedio_429', detalle: e.message, ...(e.retryAfter !== undefined ? { retryAfterS: e.retryAfter } : {}) };
        }
        // El scroll de ML vence a los pocos minutos: retomar con uno viejo da error. Se vuelve a empezar el scan;
        // lo ya encolado no se duplica (clave única), sólo se gasta cupo en releerlo.
        if (e instanceof ErrorCanalTerminal && c.topic === 'ml.items' && tomada.cursor) {
          await soltar('pausada', ', cursor = NULL, error_detail = $4', ['scroll vencido: el scan vuelve a empezar']);
          return { estado: 'reinicio_scan' };
        }
        await soltar('pausada', ', error_detail = $4', [(e as Error).message.slice(0, 200)]);
        throw e;
      }

      // La página y su checkpoint, juntos: o quedan los dos o ninguno.
      return enTransaccion(o.pool, async (tx) => {
        let encolados = 0;
        for (const rec of pagina.recursos) if (await encolar(tx, c.id, c.topic, rec, o.keyring)) encolados++;
        const terminada = pagina.siguiente === null;
        const u = await tx.query(
          `UPDATE catalog.bootstrap_runs SET pagina_confirmada = pagina_confirmada + 1, cursor = $3,
                  encolados = encolados + $4, leidos = leidos + $5, error_detail = NULL,
                  estado = $6, lease_token = NULL, lease_until = NULL, worker_id = NULL,
                  terminada_en = CASE WHEN $6 = 'terminada' THEN now() ELSE NULL END
            WHERE id = $1 AND lease_token = $2`,
          [tomada.id, tomada.lease_token, pagina.siguiente, encolados, pagina.recursos.length, terminada ? 'terminada' : 'pausada']);
        // Si otro worker tomó la corrida (el lease venció mientras leíamos), esta página no se confirma.
        if (u.rowCount !== 1) throw new Error('el lease del bootstrap venció mientras se leía la página');
        return terminada
          ? { estado: 'terminada' as const }
          : { estado: 'avanzo' as const, pagina: tomada.pagina_confirmada + 1, encolados, leidos: pagina.recursos.length };
      });
    },
  };
}
