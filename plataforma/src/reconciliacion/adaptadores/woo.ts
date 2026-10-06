import { ErrorCanalTerminal, type RespuestaCanal, type TransporteCanal } from '../cliente-http.ts';
import { claveCorriente, type AdaptadorBarrido, type PaginaRemota, type RecursoRemoto } from '../tipos.ts';
import {
  BOOTSTRAP_ORDENES_MS, cicloPorEstado, exigirLista, exigirRegistro, fechaUtc, idTexto,
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

/**
 * `status=any` de Woo es el valor por defecto y **no** incluye `trash`: WordPress registra ese estado
 * como interno y por eso queda excluido de la búsqueda (verificado en el código de WooCommerce y de
 * WordPress el 2026-09-16, y asumido por el legado en `routes/sync.js` y `routes/woo.js`). Sin una
 * segunda consulta explícita, un pedido papelereado desaparecería del barrido y la vuelta de presencia
 * lo declararía borrado: la matriz pide que `trash` se observe como estado en la misma corrida.
 */
const FASES_PEDIDOS = ['any', 'trash'] as const;

function siguienteFase(fase: string, page: number, totalPaginas: number): Record<string, unknown> | null {
  if (page < totalPaginas) return { fase, page: page + 1 };
  const indice = FASES_PEDIDOS.indexOf(fase as typeof FASES_PEDIDOS[number]);
  const proxima = FASES_PEDIDOS[indice + 1];
  return proxima ? { fase: proxima, page: 1 } : null;
}

export function pedidoWoo(crudo: unknown): RecursoRemoto {
  const o = exigirRegistro(crudo, 'pedido Woo');
  const id = idTexto(o.id);
  const version = fechaUtc(o.date_modified_gmt);
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(o.status, PEDIDO_CERRADO), payload: o,
    projection: { id, status: valorOnull(o.status), date_modified_gmt: version },
  };
}

export function adaptadorPedidosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return {
    topic: 'woo.orders', cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      // Woo pagina por número de página sobre la ventana congelada, así que la ventana no se parte en
      // segmentos: los 6 h de ML existen por el tope de offset de su búsqueda, no por la fecha.
      const desde = inicioVentana(ctx.windowFrom, ctx.windowTo, BOOTSTRAP_ORDENES_MS);
      const page = Math.max(1, numeroPosicion(posicion, 'page', 1));
      const fase = textoPosicion(posicion, 'fase') ?? FASES_PEDIDOS[0];
      const q = new URLSearchParams({
        modified_after: desde.toISOString(), modified_before: ctx.windowTo.toISOString(), dates_are_gmt: 'true',
        per_page: String(POR_PAGINA), page: String(page), orderby: 'modified', order: 'asc', status: fase,
      });
      const r = await dep.transporte.get(`${BASE}/orders?${q}`);
      const totalPaginas = paginasTotales(r, '/orders');
      const resources = exigirLista(r.body, '/orders').map(pedidoWoo);
      return {
        resources,
        nextPosition: siguienteFase(fase, page, totalPaginas),
        cursorAfter: { v: 1, updated_at: ctx.windowTo.toISOString(), tie_breaker: '' },
      };
    },
  };
}

/** Normalizadores compartidos por el barrido y la relectura puntual (C6). */
export function productoWoo(crudo: unknown): RecursoRemoto {
  const p = exigirRegistro(crudo, 'producto Woo');
  const id = idTexto(p.id);
  const version = fechaUtc(p.date_modified_gmt);
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(p.status, ['trash']), payload: p,
    projection: { id, parent_id: idTexto(p.parent_id) || null, status: valorOnull(p.status), date_modified_gmt: version },
  };
}

/** Modificados de la ventana más las variaciones de cada padre variable modificado. */
export function adaptadorProductosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return {
    topic: 'woo.products', cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      // Ventana única con paginado por página, igual que pedidos: partirla en segmentos multiplicaba
      // las consultas y volvía a enumerar el mismo catálogo en cada tramo.
      const desde = inicioVentana(ctx.windowFrom, ctx.windowTo, BOOTSTRAP_ORDENES_MS);
      const page = Math.max(1, numeroPosicion(posicion, 'page', 1));
      const q = new URLSearchParams({
        modified_after: desde.toISOString(), modified_before: ctx.windowTo.toISOString(), dates_are_gmt: 'true',
        per_page: String(POR_PAGINA), page: String(page), orderby: 'modified', order: 'asc', status: 'any',
      });
      const r = await dep.transporte.get(`${BASE}/products?${q}`);
      const totalPaginas = paginasTotales(r, '/products');
      const resources: RecursoRemoto[] = [];
      for (const crudo of exigirLista(r.body, '/products')) {
        const padre = productoWoo(crudo);
        const variaciones: RecursoRemoto[] = [];
        if ((crudo as { type?: unknown }).type === 'variable') {
          for (let vp = 1, total = 1; vp <= total; vp++) {
            const rv = await dep.transporte.get(`${BASE}/products/${encodeURIComponent(padre.id)}/variations?${new URLSearchParams({ per_page: String(POR_PAGINA), page: String(vp) })}`);
            total = paginasTotales(rv, '/variations');
            variaciones.push(...exigirLista(rv.body, '/variations').map(productoWoo));
          }
        }
        resources.push(
          { ...padre, relations: variaciones.map((v) => ({ type: 'product_variation' as const, targetTopic: 'woo.products', targetId: v.id })) },
          ...variaciones,
        );
      }
      return {
        resources,
        nextPosition: page < totalPaginas ? { page: page + 1 } : null,
        cursorAfter: { v: 1, updated_at: ctx.windowTo.toISOString(), tie_breaker: '' },
      };
    },
  };
}

/**
 * Vuelta completa de sólo IDs: única fuente de bajas por conjunto. Ni `product.deleted` ni el borrado
 * duro de un pedido aparecen entre los modificados, y una relectura completa de contenido competiría
 * con el hash de la corriente incremental.
 */
function adaptadorPresencia(dep: DependenciasWoo, config: {
  topic: string; recurso: string; fases: readonly string[]; alcanceBajas?: AdaptadorBarrido['alcanceBajas'];
}): AdaptadorBarrido {
  return {
    topic: config.topic, cursorKind: 'full_scan', fullScan: true, versionKind: 'temporal',
    modo: 'presencia', ...(config.alcanceBajas ? { alcanceBajas: config.alcanceBajas } : {}),
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const page = Math.max(1, numeroPosicion(posicion, 'page', 1));
      const fase = textoPosicion(posicion, 'fase') ?? config.fases[0]!;
      const q = new URLSearchParams({
        per_page: String(POR_PAGINA), page: String(page), orderby: 'id', order: 'asc',
        status: fase, _fields: 'id',
      });
      const r = await dep.transporte.get(`${BASE}/${config.recurso}?${q}`);
      const totalPaginas = paginasTotales(r, `/${config.recurso}`);
      const presentes = exigirLista(r.body, `/${config.recurso}`).map((crudo) => {
        const id = idTexto(exigirRegistro(crudo, `${config.recurso} presencia`).id);
        if (!id) throw new ErrorCanalTerminal(`ID_INVALIDO /${config.recurso}`);
        return id;
      });
      let nextPosition: Record<string, unknown> | null = null;
      if (page < totalPaginas) nextPosition = { fase, page: page + 1 };
      else {
        const proxima = config.fases[config.fases.indexOf(fase) + 1];
        if (proxima) nextPosition = { fase: proxima, page: 1 };
      }
      return {
        resources: [], presentes, nextPosition,
        cursorAfter: { v: 1, generation: ctx.windowTo.toISOString() },
      };
    },
  };
}

/**
 * La vuelta de productos sólo enumera padres, así que no puede declarar ausente una variación. Tampoco
 * consulta `trash`: para el catálogo, un producto en la papelera está fuera y la baja es la señal
 * correcta (la matriz le asigna la diferencia de IDs justamente para eso).
 */
export function adaptadorPresenciaProductosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return adaptadorPresencia(dep, { topic: 'woo.products', recurso: 'products', fases: ['any'], alcanceBajas: 'no_variaciones' });
}

/** Pedidos sí recorren `trash`: un pedido papelereado es un cierre, no un borrado definitivo. */
export function adaptadorPresenciaPedidosWoo(dep: DependenciasWoo): AdaptadorBarrido {
  return adaptadorPresencia(dep, { topic: 'woo.orders', recurso: 'orders', fases: FASES_PEDIDOS });
}

export function crearAdaptadoresWoo(dep: DependenciasWoo): Record<string, AdaptadorBarrido> {
  return Object.fromEntries([
    adaptadorPedidosWoo(dep), adaptadorProductosWoo(dep),
    adaptadorPresenciaPedidosWoo(dep), adaptadorPresenciaProductosWoo(dep),
  ].map((a) => [claveCorriente(a.topic, a.cursorKind), a]));
}
