import { createHash } from 'node:crypto';

export interface ArtefactoMuestra {
  version: unknown;
  fuente: unknown;
  catalogo: unknown[];
  casos: Array<{ clave: string; ml: never; sku_verdad?: string }>;
}

export interface ResultadoMuestra {
  artefacto: ArtefactoMuestra;
  parcial: boolean;
}

export function validarMuestra(contenido: string | Buffer, o: { sha256: string; cardinalidad?: number; parcial?: boolean }): ResultadoMuestra {
  const bytes = typeof contenido === 'string' ? Buffer.from(contenido) : contenido;
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!/^[0-9a-f]{64}$/i.test(o.sha256) || hash !== o.sha256.toLowerCase()) throw new Error('sha256 de muestra no coincide');
  let artefacto: ArtefactoMuestra;
  try { artefacto = JSON.parse(bytes.toString('utf8')) as ArtefactoMuestra; } catch { throw new Error('muestra inválida: JSON'); }
  if (!Array.isArray(artefacto.casos) || !Array.isArray(artefacto.catalogo)) throw new Error('muestra inválida: faltan catalogo/casos');
  const cardinalidad = o.cardinalidad ?? 299;
  if (!o.parcial && artefacto.casos.length !== cardinalidad) throw new Error(`cardinalidad de muestra inválida: esperada ${cardinalidad}, recibida ${artefacto.casos.length}`);
  if (o.parcial && artefacto.casos.length >= cardinalidad) throw new Error(`muestra parcial no es menor que la cardinalidad esperada ${cardinalidad}`);
  return { artefacto, parcial: o.parcial === true };
}
