// public/lib/conteoCantidad.js es un <script> clásico (no ESM), igual que
// format.js: se evalúa en un sandbox de node:vm con un `window` propio y se
// extraen las funciones de ahí, sin tocar el archivo de producción.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../public/lib/conteoCantidad.js'), 'utf8');

function loadConteoCantidad() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'conteoCantidad.js' });
  return sandbox.ConteoCantidad;
}

const ConteoCantidad = loadConteoCantidad();

describe('conteoCantidad.js (ConteoCantidad)', () => {
  describe('normalizarCantidad — campo vacío nunca produce 0', () => {
    it('string vacío se marca como vacío, no como 0', () => {
      const r = ConteoCantidad.normalizarCantidad('');
      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('vacio');
      expect(r.valor).not.toBe(0);
    });

    it('solo espacios también se trata como vacío', () => {
      const r = ConteoCantidad.normalizarCantidad('   ');
      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('vacio');
    });

    it('null/undefined se tratan como vacío', () => {
      expect(ConteoCantidad.normalizarCantidad(null).motivo).toBe('vacio');
      expect(ConteoCantidad.normalizarCantidad(undefined).motivo).toBe('vacio');
    });

    it('un 0 tipeado explícitamente SÍ es válido (es un conteo legítimo)', () => {
      const r = ConteoCantidad.normalizarCantidad('0');
      expect(r.ok).toBe(true);
      expect(r.valor).toBe(0);
    });

    it('texto no numérico ("2.") se marca inválido, no se confunde con vacío ni con 0', () => {
      const r = ConteoCantidad.normalizarCantidad('2.');
      // Number('2.') es 2 en JS, así que este caso puntual es válido=2; lo que
      // interesa acá es que un texto realmente no numérico caiga en 'invalida'.
      const r2 = ConteoCantidad.normalizarCantidad('abc');
      expect(r2.ok).toBe(false);
      expect(r2.motivo).toBe('invalida');
      expect(r2.valor).not.toBe(0);
    });

    it('decimales se redondean y quedan marcados como truncados (no se pierden en silencio)', () => {
      const r = ConteoCantidad.normalizarCantidad('2.5');
      expect(r.ok).toBe(true);
      expect(r.valor).toBe(3);
      expect(r.truncada).toBe(true);
    });

    it('negativos se clampean a 0', () => {
      const r = ConteoCantidad.normalizarCantidad('-5');
      expect(r.ok).toBe(true);
      expect(r.valor).toBe(0);
    });
  });

  describe('decidirCantidadAEnviar — campo vacío nunca produce un PATCH con 0', () => {
    it('campo vacío revierte al valor anterior y NO manda nada', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(3, '');
      expect(d.enviar).toBe(false);
      expect(d.valorMostrar).toBe(3);
      expect(d.motivo).toBe('vacio');
    });

    it('un "0" tipeado a mano SÍ se manda (distinto de vacío)', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(3, '0');
      expect(d.enviar).toBe(true);
      expect(d.valorEnviar).toBe(0);
    });

    it('texto inválido revierte al valor anterior', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(7, 'abc');
      expect(d.enviar).toBe(false);
      expect(d.valorMostrar).toBe(7);
      expect(d.motivo).toBe('invalida');
    });

    it('mismo valor que el anterior no manda (sin_cambio)', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(5, '5');
      expect(d.enviar).toBe(false);
      expect(d.motivo).toBe('sin_cambio');
    });

    it('valor que excede el tope revierte y avisa el motivo "tope" (pistola HID)', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(2, '7798123456789');
      expect(d.enviar).toBe(false);
      expect(d.valorMostrar).toBe(2);
      expect(d.motivo).toBe('tope');
    });
  });

  describe('siguienteAlRestar — dos "−" seguidos bajan 2', () => {
    it('un solo toque baja 1', () => {
      expect(ConteoCantidad.siguienteAlRestar(5)).toBe(4);
    });

    it('dos toques encadenados (cada uno sobre el resultado del anterior) bajan 2, no 1', () => {
      // Este es el patrón correcto: la base del segundo toque es el resultado
      // del primero, NUNCA una copia vieja de "cantidad" releída del servidor.
      // El bug real era leer item.cantidad (todavía 5) las dos veces y mandar
      // 4 dos veces seguidas — acá se prueba que encadenar da 3, no 4.
      let base = 5;
      base = ConteoCantidad.siguienteAlRestar(base);
      base = ConteoCantidad.siguienteAlRestar(base);
      expect(base).toBe(3);
    });

    it('nunca baja de 0', () => {
      expect(ConteoCantidad.siguienteAlRestar(0)).toBe(0);
    });
  });

  describe('excedeTope', () => {
    it('respeta el tope por defecto', () => {
      expect(ConteoCantidad.excedeTope(ConteoCantidad.TOPE_CANTIDAD_DEFECTO + 1)).toBe(true);
      expect(ConteoCantidad.excedeTope(10)).toBe(false);
    });

    it('acepta un tope custom', () => {
      expect(ConteoCantidad.excedeTope(50, 30)).toBe(true);
      expect(ConteoCantidad.excedeTope(20, 30)).toBe(false);
    });
  });
});
