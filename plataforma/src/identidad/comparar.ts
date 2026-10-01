/*
 * src/identidad/comparar.ts — marca por atributo de los atributos que el motor NO compara (todo menos color/talle).
 *
 * Mismas reglas que candidatos.ts (T4): 'falta' SÓLO cuando ML no declaró el atributo; si ML lo declaró y el
 * candidato no, es 'difiere' (un dato ausente en el candidato tiene que verse como diferencia). Sin 'equivalente':
 * acá no hay normalización de tokens, sólo igualdad de texto normalizado.
 */
export type Atributos = Map<string, string>;
export interface AtributoMarcado { nombre: string; marca: 'coincide' | 'difiere' | 'falta'; valorMl: string; valorCandidato: string }

export const ATRIBUTOS_COMPARABLES = new Set([
  'marca', 'modelo', 'color', 'talle', 'rodado', 'material', 'tipo_de_producto',
  'tipo_de_bicicleta', 'genero', 'edad', 'cantidad_de_velocidades',
]);

export function nombreCanonico(nombre: string): string {
  const n = nombre.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/[-\s]+/g, '_');
  if (n === 'tamano_del_cuadro') return 'talle';
  // Woo normaliza «Material del cuadro» y ML suele enviar «Material»: son el mismo atributo de catálogo.
  if (n === 'material_del_cuadro') return 'material';
  return n;
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function canonicos(atributos: Atributos): Atributos {
  const resultado: Atributos = new Map();
  for (const [nombre, valor] of atributos) {
    const canonico = nombreCanonico(nombre);
    if (!ATRIBUTOS_COMPARABLES.has(canonico)) continue;
    resultado.set(canonico, resultado.has(canonico) ? `${resultado.get(canonico)} / ${valor}` : valor);
  }
  return resultado;
}

export function otrosAtributos(ml: Atributos, cand: Atributos): AtributoMarcado[] {
  const mlCanonicos = canonicos(ml);
  const candCanonicos = canonicos(cand);
  const nombres = [...new Set([...mlCanonicos.keys(), ...candCanonicos.keys()])].filter((n) => n !== 'color' && n !== 'talle').sort();
  return nombres.map((nombre) => {
    const valorMl = mlCanonicos.get(nombre) ?? '', valorCandidato = candCanonicos.get(nombre) ?? '';
    const marca = !valorMl ? 'falta' : norm(valorMl) === norm(valorCandidato) ? 'coincide' : 'difiere';
    return { nombre, marca, valorMl, valorCandidato };
  });
}
