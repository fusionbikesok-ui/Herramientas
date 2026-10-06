import { createHash } from 'node:crypto';

function normalizar(valor: unknown): unknown {
  if (valor === undefined) return null;
  if (valor === null || typeof valor === 'string' || typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new Error('JSON canónico no admite números no finitos');
    return Object.is(valor, -0) ? 0 : valor;
  }
  if (Array.isArray(valor)) {
    const items = valor.map(normalizar);
    if (items.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'id' in v)) {
      return items.toSorted((a, b) => String((a as { id: unknown }).id).localeCompare(String((b as { id: unknown }).id), 'en'));
    }
    return items;
  }
  if (typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      salida[clave] = normalizar((valor as Record<string, unknown>)[clave]);
    }
    return salida;
  }
  throw new Error(`tipo no admitido en JSON canónico: ${typeof valor}`);
}

export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(normalizar(valor));
}

export function hashCanonico(valor: unknown): Buffer {
  return createHash('sha256').update(jsonCanonico(valor), 'utf8').digest();
}
