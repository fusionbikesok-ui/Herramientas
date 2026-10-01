import { describe, expect, it } from 'vitest';
import { nombreCanonico } from '../plataforma/src/identidad/comparar.ts';

const mod = await import('../public/bandeja-identidad/logica.js');
const L = mod.default?.marca ? mod.default : mod.marca ? mod : (globalThis.BandejaLogica ?? globalThis.window?.BandejaLogica);

describe('paridad de nombreCanonico entre la bandeja y la plataforma', () => {
  it('normaliza exactamente igual los nombres de atributos', () => {
    const casos = [
      'COLOR', 'Tamaño-áé', 'material-del cuadro', '  Tamaño del Cuadro  ',
      'Material del Cuadro', 'material_del_cuadro', '  espacios   múltiples  ',
    ];
    for (const nombre of casos) {
      expect(L.nombreCanonico(nombre), nombre).toBe(nombreCanonico(nombre));
    }
  });
});
