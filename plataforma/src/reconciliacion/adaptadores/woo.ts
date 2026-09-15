import { ErrorCanalTerminal, type RespuestaCanal, type TransporteCanal } from '../cliente-http.ts';
import type { AdaptadorBarrido, PaginaRemota, RecursoRemoto } from '../tipos.ts';
import {
  BOOTSTRAP_ORDENES_MS, cicloPorEstado, exigirLista, exigirRegistro, fechaUtc, finSegmento, idTexto,
  inicioVentana, numeroPosicion, textoPosicion, valorOnull,
} from './comun.ts';

export interface DependenciasWoo { transporte: TransporteCanal }

const BASE = '/wp-json/wc/v3';
const POR_PAGINA = 100;

function paginasTotales(r: RespuestaCanal, que: string): number {
  if (r.status === 404) throw new ErrorCanalTerminal(`HTTP_404 ${que}`, 404);
  const total = Number(r.headers.get('x-wp-totalpages'));
  if (!Number.isInteger(total) || total < 0) throw new ErrorCanalTerminal(`PAGING_INVALIDO ${que}`);
  return total;
}

const PEDIDO_CERRADO = ['completed', 'cancelled', 'refunded', 'failed', 'trash'];

export function adaptadorPedidosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return {
    topic: 'woo.orders', fullScan: false, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const desdeTexto = textoPosicion(posicion, 'desde');
      const desde = desdeTexto ? new Date(desdeTexto) : inicioVentana(ctx.windowFrom, ctx.windowTo, BOOTSTRAP_ORDENES_MS);
      const hasta = finSegmento(desde, ctx.windowTo);
      const page = Math.max(1, numeroPosicion(posicion, 'page', 1));
      const q = new URLSearchParams({
        modified_after: desde.toISOString(), modified_before: hasta.toISOString(), dates_are_gmt: 'true',
        per_page: String(POR_PAGINA), page: String(page), orderby: 'modified', order: 'asc',
      });
      const r = await dep.transporte.get(`${BASE}/orders?${q}`);
      const totalPaginas = paginasTotales(r, '/orders');
      const resources = exigirLista(r.body, '/orders').map((crudo): RecursoRemoto => {
        const o = exigirRegistro(crudo, 'pedido Woo');
        const id = idTexto(o.id);
        const version = fechaUtc(o.date_modified_gmt);
        return {
          id, version, updatedAt: version || null, lifecycle: cicloPorEstado(o.status, PEDIDO_CERRADO), payload: o,
          projection: { id, status: valorOnull(o.status), date_modified_gmt: version },
        };
      });
      let nextPosition: Record<string, unknown> | null = null;
      if (page < totalPaginas) nextPosition = { desde: desde.toISOString(), page: page + 1 };
      else if (hasta.getTime() < ctx.windowTo.getTime()) nextPosition = { desde: hasta.toISOString(), page: 1 };
      return { resources, nextPosition, cursorAfter: { v: 1, updated_at: ctx.windowTo.toISOString(), tie_breaker: '' } };
    },
  };
}

function productoWoo(crudo: unknown): RecursoRemoto {
  const p = exigirRegistro(crudo, 'producto Woo');
  const id = idTexto(p.id);
  const version = fechaUtc(p.date_modified_gmt);
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(p.status, ['trash']), payload: p,
    projection: { id, parent_id: idTexto(p.parent_id) || null, status: valorOnull(p.status), date_modified_gmt: version },
  };
}

/**
 * Vuelta completa de padres + variaciones. Es la fuente de bajas por conjunto: `product.deleted` no
 * aparece entre los modificados, así que sólo la ausencia en una vuelta completa exitosa lo detecta.
 */
export function adaptadorProductosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return {
    topic: 'woo.products', fullScan: true, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const page = Math.max(1, numeroPosicion(posicion, 'page', 1));
      const q = new URLSearchParams({ per_page: String(POR_PAGINA), page: String(page), orderby: 'id', order: 'asc', status: 'any' });
      const r = await dep.transporte.get(`${BASE}/products?${q}`);
      const totalPaginas = paginasTotales(r, '/products');
      const resources: RecursoRemoto[] = [];
      for (const crudo of exigirLista(r.body, '/products')) {
        const padre = productoWoo(crudo);
        const variables: RecursoRemoto[] = [];
        if ((crudo as { type?: unknown }).type === 'variable') {
          for (let vp = 1, total = 1; vp <= total; vp++) {
            const rv = await dep.transporte.get(`${BASE}/products/${encodeURIComponent(padre.id)}/variations?${new URLSearchParams({ per_page: String(POR_PAGINA), page: String(vp) })}`);
            total = paginasTotales(rv, '/variations');
            variables.push(...exigirLista(rv.body, '/variations').map(productoWoo));
          }
        }
        resources.push(
          { ...padre, relations: variables.map((v) => ({ type: 'product_variation' as const, targetTopic: 'woo.products', targetId: v.id })) },
          ...variables,
        );
      }
      return {
        resources,
        nextPosition: page < totalPaginas ? { page: page + 1 } : null,
        cursorAfter: { v: 1, generation: ctx.windowTo.toISOString() },
      };
    },
  };
}

export function crearAdaptadoresWoo(dep: DependenciasWoo): Record<string, AdaptadorBarrido> {
  return Object.fromEntries([adaptadorPedidosWoo(dep), adaptadorProductosWoo(dep)].map((a) => [a.topic, a]));
}
