import { describe, it, expect } from 'vitest';
import { createContinuousGate } from '../public/lib/scannerGate.js';

/* Reproducción del bug de conteo del Contador de inventario ("cuento 8 y me marca 3").
 *
 * Los tests de test/scannerGate.test.js pasan todos y describen el gate tal como fue
 * diseñado — por eso el bug convive con la suite en verde: nadie estaba simulando el
 * ESCENARIO REAL, que es un flujo continuo de unidades, no llamadas sueltas a frame().
 *
 * La pieza que faltaba son los frames VACÍOS. Un test que solo llame frame('X', t) repetido
 * no reproduce nada: reproduce el comportamiento correcto del gate y pasa en verde.
 *
 * Números de producción: muestreo cada 350ms (public/lib/scanner.js:224) y dropoutMs 500
 * (public/inventario/index.html:1351, y el mismo valor en public/preparacion/index.html:1477).
 */

/** Pasa `unidades` por delante de la cámara y devuelve cuántas contó el gate.
 *  Cada unidad es legible `visibleMs` y después queda un hueco hasta la siguiente.
 *  `codigoDe` permite simular unidades iguales (mismo código) o productos distintos. */
function simularPasada({ unidades, periodoMs, visibleMs, muestreoMs, dropoutMs, codigoDe = () => 'X' }) {
  const gate = createContinuousGate({ dropoutMs });
  let contadas = 0;
  for (let t = 0; t <= unidades * periodoMs; t += muestreoMs) {
    const i = Math.floor(t / periodoMs);
    const visible = i < unidades && (t - i * periodoMs) < visibleMs;
    if (gate.frame(visible ? codigoDe(i) : null, t)) contadas++;
  }
  return contadas;
}

// Ritmo real de alguien pasando unidades a mano: cada unidad queda a la vista ~600ms y
// entre una y otra hay un hueco de ~200ms.
const RITMO_REAL = { unidades: 8, periodoMs: 800, visibleMs: 600 };
const PRODUCCION = { muestreoMs: 350, dropoutMs: 500 };

describe('conteo por cámara — reproducción del bug', () => {
  // ESTE ES EL TEST QUE TIENE QUE FALLAR ANTES DEL FIX. Hoy da 1.
  it('8 unidades iguales al ritmo real se cuentan las 8', () => {
    expect(simularPasada({ ...RITMO_REAL, ...PRODUCCION })).toBe(8);
  });

  // El hueco entre unidades (200ms) es MENOR que dropoutMs (500ms), así que el gate no se
  // re-arma nunca y las 8 unidades cuentan como una sola. Es determinista, no estadístico.
  it('la causa es el umbral, no el muestreo: afinar la cámara no cambia nada', () => {
    const conDropout500 = [350, 200, 100, 50].map((muestreoMs) =>
      simularPasada({ ...RITMO_REAL, muestreoMs, dropoutMs: 500 }));
    expect(conDropout500).toEqual([1, 1, 1, 1]);
  });

  // Contraprueba: con el umbral por debajo del hueco real, el muestreo sí importa — y muestrear
  // más fino MEJORA el conteo, no lo empeora. (Un frame vacío es la OBSERVACIÓN del hueco:
  // muestrear más seguido encuentra más huecos, no menos. La intuición contraria es incorrecta
  // y quedó anotada acá para que nadie la repita.)
  it('con el umbral por debajo del hueco, muestrear más fino cuenta más, no menos', () => {
    expect(simularPasada({ ...RITMO_REAL, muestreoMs: 350, dropoutMs: 0 })).toBe(5);
    expect(simularPasada({ ...RITMO_REAL, muestreoMs: 100, dropoutMs: 0 })).toBe(8);
  });

  // La cámara identifica bien: el problema es exclusivamente re-contar el MISMO código.
  // Por eso la vara del gate se fija sobre productos distintos (ver el spec).
  it('8 productos distintos al mismo ritmo se cuentan los 8, ya hoy', () => {
    expect(simularPasada({ ...RITMO_REAL, ...PRODUCCION, codigoDe: (i) => 'COD' + i })).toBe(8);
  });
});
