import { ErrorBarridoReintentable } from '../worker/barridos.ts';

/** Respuesta ya leída y parseada de un canal remoto. Sólo 2xx y 404 llegan al adaptador. */
export interface RespuestaCanal { status: number; headers: Headers; body: unknown }

export interface TransporteCanal {
  get(ruta: string, opciones?: { headers?: Readonly<Record<string, string>> }): Promise<RespuestaCanal>;
}

/** 401/403, redirección, 4xx no reintentable o respuesta inutilizable: no se reintenta solo. */
export class ErrorCanalTerminal extends Error {
  override name = 'ErrorCanalTerminal';
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

export class ErrorDestinoProhibido extends Error { override name = 'ErrorDestinoProhibido'; }
export class ErrorMetodoProhibido extends Error { override name = 'ErrorMetodoProhibido'; }

// T2 sólo puede hablar con un simulador local o con el servicio Docker `simulator`.
const HOSTS_PERMITIDOS = new Set(['127.0.0.1', 'localhost', '[::1]', 'simulator']);
const MAX_RETRY_AFTER_S = 300;

export function parsearRetryAfter(valor: string | null, ahora: Date = new Date()): number | undefined {
  if (!valor) return undefined;
  const texto = valor.trim();
  if (/^\d+$/.test(texto)) return Math.min(MAX_RETRY_AFTER_S, Number(texto));
  const fecha = Date.parse(texto);
  if (!Number.isFinite(fecha)) return undefined;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(0, Math.ceil((fecha - ahora.getTime()) / 1000)));
}

function validarBase(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ErrorDestinoProhibido('URL base inválida'); }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS_PERMITIDOS.has(url.hostname) || url.username || url.password) {
    throw new ErrorDestinoProhibido(`destino no permitido en T2: ${url.hostname}`);
  }
  return url;
}

function semaforo(maximo: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let activos = 0;
  const cola: Array<() => void> = [];
  return async (fn) => {
    if (activos >= maximo) await new Promise<void>((r) => cola.push(r));
    activos++;
    try { return await fn(); } finally {
      activos--;
      cola.shift()?.();
    }
  };
}

async function leerCuerpoAcotado(respuesta: Response, maxBytes: number): Promise<Buffer> {
  const declarado = Number(respuesta.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > maxBytes) throw new ErrorCanalTerminal('CUERPO_EXCEDIDO', respuesta.status);
  if (!respuesta.body) return Buffer.alloc(0);
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of respuesta.body as unknown as AsyncIterable<Uint8Array>) {
    total += parte.byteLength;
    if (total > maxBytes) throw new ErrorCanalTerminal('CUERPO_EXCEDIDO', respuesta.status);
    partes.push(Buffer.from(parte));
  }
  return Buffer.concat(partes);
}

/**
 * Cliente de lectura para barridos. Rechaza cualquier método distinto de GET y cualquier destino
 * fuera de la allowlist antes de tocar la red. Los errores sólo exponen status y ruta sin query:
 * nunca Authorization, secretos de query ni cuerpos remotos.
 */
export function crearClienteCanal(opciones: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxConexiones?: number;
  fetch?: typeof fetch;
  reloj?: () => Date;
}): TransporteCanal & { solicitar(metodo: string, ruta: string, headers?: Readonly<Record<string, string>>): Promise<RespuestaCanal> } {
  const base = validarBase(opciones.baseUrl);
  const hacerFetch = opciones.fetch ?? fetch;
  const timeoutMs = opciones.timeoutMs ?? 5_000;
  const maxBytes = opciones.maxBytes ?? 10 * 1024 * 1024;
  const limitar = semaforo(opciones.maxConexiones ?? 4);

  async function solicitar(metodo: string, ruta: string, headers: Readonly<Record<string, string>> = {}): Promise<RespuestaCanal> {
    if (metodo.toUpperCase() !== 'GET') throw new ErrorMetodoProhibido(`método ${metodo} prohibido en barridos`);
    if (!ruta.startsWith('/') || ruta.startsWith('//')) throw new ErrorDestinoProhibido('ruta relativa inválida');
    const url = new URL(ruta, base);
    if (url.origin !== base.origin) throw new ErrorDestinoProhibido('la ruta cambia el destino');
    const rutaSegura = url.pathname;

    return limitar(async () => {
      let respuesta: Response;
      try {
        respuesta = await hacerFetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: 'application/json',
            'x-fusion-plano': 'canal',
            ...headers,
            ...(opciones.token ? { authorization: `Bearer ${opciones.token}` } : {}),
          },
        });
      } catch (error) {
        const nombre = (error as Error)?.name;
        throw new ErrorBarridoReintentable(nombre === 'TimeoutError' || nombre === 'AbortError' ? `TIMEOUT ${rutaSegura}` : `RED ${rutaSegura}`);
      }
      const { status } = respuesta;
      if (status >= 300 && status < 400) throw new ErrorCanalTerminal(`REDIRECCION ${status} ${rutaSegura}`, status);
      if (status === 408 || status === 429 || status >= 500) {
        await respuesta.body?.cancel().catch(() => undefined);
        throw new ErrorBarridoReintentable(`HTTP_${status} ${rutaSegura}`,
          parsearRetryAfter(respuesta.headers.get('retry-after'), (opciones.reloj ?? (() => new Date()))()));
      }
      if (status === 401 || status === 403 || (status >= 400 && status !== 404)) {
        await respuesta.body?.cancel().catch(() => undefined);
        throw new ErrorCanalTerminal(`HTTP_${status} ${rutaSegura}`, status);
      }
      let crudo: Buffer;
      try {
        crudo = await leerCuerpoAcotado(respuesta, maxBytes);
      } catch (error) {
        if (error instanceof ErrorCanalTerminal) throw error;
        // La respuesta se cortó después de empezar: es transitorio, la página se repite entera.
        throw new ErrorBarridoReintentable(`RESPUESTA_CORTADA ${rutaSegura}`);
      }
      let body: unknown = null;
      if (crudo.length) {
        try { body = JSON.parse(crudo.toString('utf8')); } catch { throw new ErrorCanalTerminal(`JSON_INVALIDO ${rutaSegura}`, status); }
      }
      return { status, headers: respuesta.headers, body };
    });
  }

  return { solicitar, get: (ruta, o) => solicitar('GET', ruta, o?.headers) };
}
