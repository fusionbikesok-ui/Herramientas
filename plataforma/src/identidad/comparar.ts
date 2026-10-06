/*
 * src/identidad/comparar.ts — marca por atributo de los atributos que el motor NO compara (todo menos color/talle).
 *
 * Mismas reglas que candidatos.ts (T4): 'falta' SÓLO cuando ML no declaró el atributo; si ML lo declaró y el
 * candidato no, es 'difiere' (un dato ausente en el candidato tiene que verse como diferencia). Sin 'equivalente':
 * acá no hay normalización de tokens, sólo igualdad de texto normalizado.
 */
export type Atributos = Map<string, string>;
export interface AtributoMarcado { nombre: string; marca: 'coincide' | 'difiere' | 'falta'; valorMl: string; valorCandidato: string }

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

export function otrosAtributos(ml: Atributos, cand: Atributos): AtributoMarcado[] {
  const nombres = [...new Set([...ml.keys(), ...cand.keys()])].filter((n) => n !== 'color' && n !== 'talle').sort();
  return nombres.map((nombre) => {
    const valorMl = ml.get(nombre) ?? '', valorCandidato = cand.get(nombre) ?? '';
    const marca = !valorMl ? 'falta' : norm(valorMl) === norm(valorCandidato) ? 'coincide' : 'difiere';
    return { nombre, marca, valorMl, valorCandidato };
  });
}
