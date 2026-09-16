import { envioMl, itemMl, ordenMl, preguntaMl, reclamoMl, recursoNoEncontrado } from './adaptadores/ml.ts';
import { pedidoWoo, productoWoo } from './adaptadores/woo.ts';
import { esRegistro, exigirLista, exigirRegistro, idTexto } from './adaptadores/comun.ts';
import { ErrorBarridoReintentable } from '../worker/barridos.ts';
import { ErrorCanalTerminal, type TransporteCanal } from './cliente-http.ts';
import type { RecursoRemoto, TipoVersion } from './tipos.ts';

/**
 * Relectura puntual por señal (E1 T3 §9, corte C6). Una señal sólo dice "mirá este recurso": la verdad
 * sale del GET, y se normaliza con las mismas funciones que el barrido para que versión y proyección
 * coincidan exactamente con las de la corriente incremental.
 */
export type ResultadoRelectura =
  | { tipo: 'recursos'; recursos: RecursoRemoto[] }
  /** 404 donde el contrato del tópico NO admite baja por relectura: queda explicado y decide el barrido. */
  | { tipo: 'sin_baja'; motivo: 'not_found' }
  /** Tópico que no se resuelve por id (mensajes): se adelanta su barrido. */
  | { tipo: 'barrido' };

export interface Relector {
  readonly topic: string;
  readonly versionKind: TipoVersion;
  /** Formato válido del id remoto; un id fuera de formato excluye la señal sin tocar la red. */
  readonly id: RegExp;
  releer(resourceId: string): Promise<ResultadoRelectura>;
}

const DIGITOS = /^\d{1,20}$/;
const ITEM = /^[A-Z]{3}\d{1,15}$/;
const WOO = '/wp-json/wc/v3';

export function crearRelectoresMl(dep: { transporte: TransporteCanal }): Record<string, Relector> {
  const t = dep.transporte;
  const simple = (topic: string, versionKind: TipoVersion, ruta: (id: string) => string, normalizar: (b: unknown) => RecursoRemoto,
    alNoEncontrar: (id: string) => ResultadoRelectura, headers?: Record<string, string>): Relector => ({
    topic, versionKind, id: DIGITOS,
    async releer(id) {
      const r = await t.get(ruta(id), headers ? { headers } : undefined);
      if (r.status === 404) return alNoEncontrar(id);
      return { tipo: 'recursos', recursos: [normalizar(r.body)] };
    },
  });
  const sinBaja = (): ResultadoRelectura => ({ tipo: 'sin_baja', motivo: 'not_found' });
  // Preguntas y reclamos: el barrido ya da de baja un conocido que responde 404, y la relectura hace lo mismo.
  const baja = (id: string): ResultadoRelectura => ({ tipo: 'recursos', recursos: [recursoNoEncontrado(id)] });
  const relectores: Relector[] = [
    // Una orden de ML no se borra: un 404 es un id ajeno o un error, nunca una baja.
    simple('ml.orders', 'temporal', (id) => `/orders/${id}`, ordenMl, sinBaja),
    simple('ml.shipments', 'temporal', (id) => `/shipments/${id}`, envioMl, sinBaja, { 'x-format-new': 'true' }),
    simple('ml.questions', 'hash', (id) => `/questions/${id}`, preguntaMl, baja),
    simple('ml.claims', 'hash', (id) => `/post-purchase/v1/claims/${id}`, reclamoMl, baja),
    {
      topic: 'ml.items', versionKind: 'temporal', id: ITEM,
      async releer(id) {
        const r = await t.get(`/items/bulk?ids=${id}`);
        const entrada = exigirRegistro(exigirLista(r.body, '/items/bulk')[0], 'bulk');
        const codigo = Number(entrada.status_code);
        // Una publicación eliminada sólo la da de baja la vuelta completa diaria.
        if (codigo === 404) return sinBaja();
        if (codigo === 429 || codigo >= 500) throw new ErrorBarridoReintentable(`BULK_${codigo} /items/bulk`);
        if (codigo !== 200) throw new ErrorCanalTerminal(`BULK_${idTexto(entrada.status_code)} /items/bulk`);
        return { tipo: 'recursos', recursos: [itemMl(entrada.body)] };
      },
    },
    // Mensajes: el id del aviso no es resoluble con credenciales de vendedor; se barre por packs.
    { topic: 'ml.messages', versionKind: 'hash', id: /^.{1,256}$/, async releer() { return { tipo: 'barrido' }; } },
  ];
  return Object.fromEntries(relectores.map((r) => [r.topic, r]));
}

export function crearRelectoresWoo(dep: { transporte: TransporteCanal }): Record<string, Relector> {
  const t = dep.transporte;
  const relectores: Relector[] = [
    {
      topic: 'woo.orders', versionKind: 'temporal', id: DIGITOS,
      async releer(id) {
        const r = await t.get(`${WOO}/orders/${id}`);
        // Borrado duro o id ajeno: la vuelta semanal de IDs es la única fuente de bajas de pedidos.
        if (r.status === 404) return { tipo: 'sin_baja', motivo: 'not_found' };
        return { tipo: 'recursos', recursos: [pedidoWoo(r.body)] };
      },
    },
    {
      topic: 'woo.products', versionKind: 'temporal', id: DIGITOS,
      async releer(id) {
        const r = await t.get(`${WOO}/products/${id}`);
        if (r.status === 404) return { tipo: 'sin_baja', motivo: 'not_found' };
        const padre = productoWoo(r.body);
        if (!esRegistro(r.body) || r.body.type !== 'variable') return { tipo: 'recursos', recursos: [padre] };
        // Mismo contrato que el barrido: un padre variable trae sus variaciones y la relación a cada una.
        const variaciones: RecursoRemoto[] = [];
        for (let page = 1, total = 1; page <= total; page++) {
          const rv = await t.get(`${WOO}/products/${id}/variations?${new URLSearchParams({ per_page: '100', page: String(page) })}`);
          if (rv.status === 404) throw new ErrorCanalTerminal(`HTTP_404 /variations`, 404);
          total = Number(rv.headers.get('x-wp-totalpages'));
          if (!Number.isInteger(total) || total < 0) throw new ErrorCanalTerminal('PAGING_INVALIDO /variations');
          variaciones.push(...exigirLista(rv.body, '/variations').map(productoWoo));
        }
        return {
          tipo: 'recursos',
          recursos: [
            { ...padre, relations: variaciones.map((v) => ({ type: 'product_variation' as const, targetTopic: 'woo.products', targetId: v.id })) },
            ...variaciones,
          ],
        };
      },
    },
  ];
  return Object.fromEntries(relectores.map((r) => [r.topic, r]));
}
