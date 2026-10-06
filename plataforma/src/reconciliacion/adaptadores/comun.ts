import { ErrorPaginaInvalida } from '../motor.ts';
import type { CicloVida } from '../tipos.ts';

export const HORA_MS = 3_600_000;
export const DIA_MS = 24 * HORA_MS;
/** Primera corrida de órdenes: 30 días hacia atrás desde el `window_to` congelado. */
export const BOOTSTRAP_ORDENES_MS = 30 * DIA_MS;
/** Ninguna consulta temporal de órdenes cubre más de 6 h (mitiga el tope de offset de ML). */
export const SEGMENTO_ORDENES_MS = 6 * HORA_MS;

export type Registro = Record<string, unknown>;

export function esRegistro(valor: unknown): valor is Registro {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

export function exigirRegistro(valor: unknown, que: string): Registro {
  if (!esRegistro(valor)) throw new ErrorPaginaInvalida(`${que}: se esperaba un objeto`);
  return valor;
}

export function exigirLista(valor: unknown, que: string): unknown[] {
  if (!Array.isArray(valor)) throw new ErrorPaginaInvalida(`${que}: se esperaba una lista`);
  return valor;
}

export function idTexto(valor: unknown): string {
  return typeof valor === 'number' || typeof valor === 'string' ? String(valor) : '';
}

/** Woo devuelve `*_gmt` sin zona; se fija UTC explícito para no depender del TZ del proceso. */
export function fechaUtc(valor: unknown): string {
  if (typeof valor !== 'string' || !valor.trim()) return '';
  const texto = /(?:Z|[+-]\d{2}:?\d{2})$/.test(valor) ? valor : `${valor}Z`;
  const ms = Date.parse(texto);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function numeroPosicion(posicion: Registro | null, clave: string, porDefecto: number): number {
  const v = posicion?.[clave];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : porDefecto;
}

export function textoPosicion(posicion: Registro | null, clave: string): string | null {
  const v = posicion?.[clave];
  return typeof v === 'string' ? v : null;
}

/** Límite inferior efectivo: cursor−solape, o bootstrap desde `window_to` si aún no hubo éxito. */
export function inicioVentana(windowFrom: Date | null, windowTo: Date, bootstrapMs: number): Date {
  return windowFrom ?? new Date(windowTo.getTime() - bootstrapMs);
}

export function finSegmento(desde: Date, windowTo: Date): Date {
  return new Date(Math.min(desde.getTime() + SEGMENTO_ORDENES_MS, windowTo.getTime()));
}

export function cicloPorEstado(status: unknown, cerrados: readonly string[]): CicloVida {
  return typeof status === 'string' && cerrados.includes(status) ? 'closed' : 'open';
}

export function valorOnull(valor: unknown): unknown {
  return valor === undefined ? null : valor;
}
