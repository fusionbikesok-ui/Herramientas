import type { Server } from 'node:http';

export type RegistroSim = Record<string, unknown>;

/** Fixture en memoria de E1 T2. Los arrays se exponen vivos en `datos` para mutarlos entre páginas. */
export interface FixtureCanales {
  ml?: {
    orders?: RegistroSim[];
    shipments?: RegistroSim[];
    questions?: RegistroSim[];
    claims?: RegistroSim[];
    unread?: RegistroSim[];
    packs?: Record<string, RegistroSim[]>;
    /** Fallo simulado de un elemento del bulk: `{ id: status_code }`. */
    fallosBulk?: Record<string, number>;
    missedFeeds?: RegistroSim[];
    missedFeedsForma?: 'rota';
    missedFeedsExigeSitio?: boolean;
    items?: RegistroSim[];
  };
  woo?: { orders?: RegistroSim[]; products?: RegistroSim[] };
  alLlamar?: (llamada: { metodo: string; ruta: string; n: number }, datos: DatosSimulador) => void;
}

export interface DatosSimulador {
  items: Map<string, RegistroSim>;
  productos: Map<number, RegistroSim>;
  variaciones: Map<number, RegistroSim[]>;
  ordenesMl: RegistroSim[];
  envios: Map<string, RegistroSim>;
  preguntas: Map<string, RegistroSim>;
  reclamos: Map<string, RegistroSim>;
  noLeidos: RegistroSim[];
  packs: Map<string, RegistroSim[]>;
  ordenesWoo: RegistroSim[];
}

export interface LlamadaSimulador {
  en: string;
  metodo: string;
  ruta: string;
  cuerpo: unknown;
  status: number;
  headers: Record<string, string>;
}

export function crearDatos(db: unknown): DatosSimulador;
export function crearSimulador(opciones?: {
  db?: unknown;
  fixture?: FixtureCanales;
  cert?: Buffer | null;
  key?: Buffer | null;
  reloj?: () => Date;
}): Server;
