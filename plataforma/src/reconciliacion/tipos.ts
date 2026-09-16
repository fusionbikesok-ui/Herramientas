import type { CorridaReclamada } from './corridas.ts';

export type CicloVida = 'open' | 'closed' | 'deleted' | 'unknown';

export interface RelacionRemota {
  type: 'order_shipment' | 'order_pack' | 'product_variation';
  targetTopic: string;
  targetId: string;
  lifecycle?: CicloVida;
}

export interface RecursoRemoto {
  id: string;
  version: string;
  updatedAt?: string | null;
  lifecycle: CicloVida;
  payload: unknown;
  projection: unknown;
  relations?: readonly RelacionRemota[];
}

export interface ContextoListado {
  corrida: CorridaReclamada;
  windowFrom: Date | null;
  windowTo: Date;
}

export interface PaginaRemota {
  /** Recursos con contenido. Vacío en una corriente de sólo presencia. */
  resources: readonly RecursoRemoto[];
  /** IDs presentes en el remoto, sin contenido. Obligatorio en modo `presencia`. */
  presentes?: readonly string[];
  nextPosition: Record<string, unknown> | null;
  cursorAfter: Record<string, unknown>;
}

/**
 * `temporal`: la versión es un instante remoto y se compara como UTC.
 * `hash`: el remoto no ofrece fecha; la versión sólo distingue igualdad y la relectura más nueva gana.
 */
export type TipoVersion = 'temporal' | 'hash';

/**
 * `contenido`: la corriente lee el recurso completo, actualiza la observación y encola.
 * `presencia`: la corriente sólo enumera IDs para declarar bajas; no encola ni cambia versiones.
 */
export type ModoBarrido = 'contenido' | 'presencia';

/**
 * Universo que una vuelta completa puede declarar ausente. `no_variaciones` excluye los recursos que
 * son destino de una relación `product_variation`: una vuelta que sólo enumera padres no puede
 * afirmar que una variación desapareció.
 */
export type AlcanceBajas = 'todos' | 'no_variaciones';

export interface AdaptadorBarrido {
  readonly topic: string;
  /** Corriente dentro del tópico: `state_sweep` (incremental) o `full_scan` (vuelta completa). */
  readonly cursorKind: string;
  readonly fullScan: boolean;
  readonly versionKind: TipoVersion;
  readonly modo?: ModoBarrido;
  readonly alcanceBajas?: AlcanceBajas;
  listar(contexto: ContextoListado, posicion: Record<string, unknown> | null): Promise<PaginaRemota>;
}

export function claveCorriente(topic: string, cursorKind: string): string {
  return `${topic}|${cursorKind}`;
}

/** Clave de procesador en el worker multi-cuenta (T3): una corriente sólo existe dentro de una cuenta. */
export function claveCorrienteCuenta(channelAccountId: string, topic: string, cursorKind: string): string {
  return `${channelAccountId}|${topic}|${cursorKind}`;
}
