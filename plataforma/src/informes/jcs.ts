/*
 * src/informes/jcs.ts — JSON canónico (RFC 8785, JCS).
 *
 * Existe porque "claves ordenadas y sin espacios" no alcanza: sin fijar la forma de los números, el
 * escapado y el orden por código UTF-16, dos programas producen bytes distintos para el mismo objeto y la
 * firma deja de ser verificable por terceros (hallazgo 8 de la revisión externa del 2026-09-17).
 */

// RFC 8785 §3.2.2.2: los números usan la forma de ECMAScript, que Number.prototype.toString ya produce,
// salvo el cero negativo, que canoniza a "0".
function numero(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonizar: ${n} no es un número finito`);
  return Object.is(n, -0) ? '0' : String(n);
}

const ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function texto(s: string): string {
  // Un surrogate sin par no tiene representación UTF-8: hay que fallar, no dejar que Node lo cambie por
  // U+FFFD, porque entonces la firma no correspondería al texto recibido.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
    throw new Error('canonizar: hay un surrogate UTF-16 sin par');
  }
  let salida = '"';
  for (const ch of s) {
    const escape = ESCAPES[ch];
    if (escape) { salida += escape; continue; }
    const cp = ch.codePointAt(0)!;
    // Sólo los de control van en \u00xx; el resto viaja como UTF-8 literal (RFC 8785 §3.2.2.2).
    salida += cp < 0x20 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
  }
  return `${salida}"`;
}

function serializar(valor: unknown, vistos: Set<object>): string {
  if (valor === null) return 'null';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') return numero(valor);
  if (typeof valor === 'string') return texto(valor);
  if (typeof valor === 'bigint') throw new Error('canonizar: BigInt no tiene forma canónica en JSON');
  if (typeof valor === 'function') throw new Error('canonizar: una función no es serializable');
  if (typeof valor === 'undefined') throw new Error('canonizar: undefined no es serializable');
  if (typeof valor === 'object') {
    if (vistos.has(valor as object)) throw new Error('canonizar: hay un ciclo en el objeto');
    vistos.add(valor as object);
    try {
      if (Array.isArray(valor)) {
        // Iterar con índice explícito en lugar de .map: Array.prototype.map no invoca el callback
        // en huecos ("holes") de arrays dispersos, así que los undefined implícitos nunca pasan por
        // serializar y nunca lanzan. Con .map, [1, , 3] produciría "[1,,3]", JSON inválido.
        const elementos: string[] = [];
        for (let i = 0; i < valor.length; i += 1) {
          elementos.push(serializar(valor[i], vistos));
        }
        return `[${elementos.join(',')}]`;
      }
      const entradas = Object.entries(valor as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // RFC 8785 §3.2.3: se ordena por las unidades de código UTF-16, que es lo que compara `<`.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entradas.map(([k, v]) => `${texto(k)}:${serializar(v, vistos)}`).join(',')}}`;
    } finally {
      vistos.delete(valor as object);
    }
  }
  throw new Error(`canonizar: tipo no soportado ${typeof valor}`);
}

export function canonizar(valor: unknown): string {
  return serializar(valor, new Set());
}
