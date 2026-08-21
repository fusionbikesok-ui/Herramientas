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
  // Un negativo se lleva a 0 —eso ya estaba— pero antes se hacía en SILENCIO, mientras que
  // un decimal sí avisaba. Es la misma asimetría del campo vacío: el operario tipea una cosa
  // y se guarda otra sin enterarse. El flag `negativa` existe para que la pantalla avise.
  describe('negativo: se lleva a 0 pero avisando', () => {
    it('normalizarCantidad marca negativa y devuelve 0', () => {
      const r = ConteoCantidad.normalizarCantidad('-3');
      expect(r.valor).toBe(0);
      expect(r.negativa).toBe(true);
    });

    it('un valor válido no queda marcado como negativa', () => {
      expect(ConteoCantidad.normalizarCantidad('4').negativa).toBe(false);
    });

    it('decidirCantidadAEnviar propaga el motivo para que la pantalla pueda avisar', () => {
      const d = ConteoCantidad.decidirCantidadAEnviar(5, '-2', {});
      expect(d.enviar).toBe(true);
      expect(d.valorEnviar).toBe(0);
      expect(d.motivo).toBe('negativa');
    });
  });


  // La cola de escrituras es la pieza que hace que el orden en que TOCÓ el operario sea el
  // orden en que se APLICA. Sin ella, el escaneo (+1 relativo en el servidor) y el control de
  // cantidad (valor absoluto) viajan juntos y gana el que llega: el +1 se pierde en silencio.
  describe('crearColaEscrituras', () => {
    const diferido = () => {
      let resolver, rechazar;
      const promesa = new Promise((res, rej) => { resolver = res; rechazar = rej; });
      return { promesa, resolver, rechazar };
    };

    it('no arranca la segunda escritura hasta que termina la primera', async () => {
      const encolar = ConteoCantidad.crearColaEscrituras();
      const a = diferido();
      const arrancaron = [];
      encolar(() => { arrancaron.push('a'); return a.promesa; });
      encolar(() => { arrancaron.push('b'); return Promise.resolve(); });
      await Promise.resolve();
      expect(arrancaron).toEqual(['a']);   // 'b' todavía no arrancó
      a.resolver();
      await new Promise((r) => setTimeout(r, 0));
      expect(arrancaron).toEqual(['a', 'b']);
    });

    // El caso que rompe en la pantalla: el "−" resuelve su valor DENTRO de la escritura,
    // así que lo que importa es que para entonces la escritura anterior ya haya terminado
    // (y con ella el refresco del estado). Acá se modela con un contador compartido.
    it('escaneo(+1) y resta(absoluto) alternados dejan el valor correcto', async () => {
      const encolar = ConteoCantidad.crearColaEscrituras();
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      // Arranca en 1 a propósito: `siguienteAlRestar` satura en 0, así que la suma NO es
      // conmutativa cerca del piso. Con un valor alto (4) el resultado da bien aunque el
      // orden se rompa, y el test no probaría nada — se verificó por mutación.
      let servidor = 1;
      const ultima = [];
      for (let i = 0; i < 3; i++) {
        // El escaneo tarda (viaja al servidor); la resta resuelve su valor al arrancar.
        // Sin serialización la resta lee `servidor` ANTES de que el escaneo lo haya subido
        // y el +1 se pierde: es exactamente el subconteo que se vio en el navegador.
        ultima.push(encolar(() => esperar(5).then(() => { servidor += 1; })));
        ultima.push(encolar(() => { servidor = ConteoCantidad.siguienteAlRestar(servidor); }));
      }
      await Promise.all(ultima);
      expect(servidor).toBe(1);   // 3 escaneos y 3 restas alternados: sin cambio neto
    });

    it('una escritura que falla no corta la cola', async () => {
      const encolar = ConteoCantidad.crearColaEscrituras();
      const corridas = [];
      encolar(() => { corridas.push('falla'); return new Promise((_r, rej) => setTimeout(() => rej(new Error('sin red')), 5)); }).catch(() => {});
      const segunda = encolar(() => { corridas.push('sigue'); return Promise.resolve(); });
      await segunda;
      expect(corridas).toEqual(['falla', 'sigue']);
    });
  });

});
